// 按编号找快照（决策 350）：快照在后台拍，条目落在文件里的位置不说明它对应哪一条——分叉点之前最近的快照按记录写明的条目号找；
// 最近的那一次没拍成（只有"拍摄中"标记即进程中断，或标了失败）时给出它的拍摄标记，不退回更早的快照；文件没有改变的不算。
import assert from "node:assert/strict";
import { test } from "vitest";
import { newRunId, newSessionId, type RunId } from "./ids.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "./session-entries.ts";
import { type StoreEntry, storeCheckpointBefore, storeSessionView } from "./session-judge.ts";

const sha = (digit: string) => digit.repeat(40);

function sessionBuilder() {
  const entries: StoreEntry[] = [];
  const push = (body: Record<string, unknown>) =>
    entries.push({ type: "custom", id: `e${entries.length}`, parentId: null, ...body });
  const custom = (customType: string, data: Record<string, unknown>) =>
    push({ customType, data: { version: SESSION_ENTRY_VERSION, ...data } });
  return {
    run: (runId: RunId) => custom(SessionEntryType.RunStart, { runId }),
    message: (role: string) => push({ type: "message", message: { role } }),
    checkpoint: (runId: RunId, toolCallId: string, runSeq: number, commit: string, base?: string) =>
      custom(SessionEntryType.Checkpoint, {
        runId,
        toolCallId,
        runSeq,
        ref: `refs/pigeon/checkpoints/s/${runSeq}`,
        commit,
        tree: sha("f"),
        ...(base !== undefined ? { baseCommit: base } : {}),
      }),
    mark: (runId: RunId, toolCallId: string, runSeq: number, state: string) =>
      custom(SessionEntryType.CheckpointMark, { runId, toolCallId, runSeq, state }),
    view: () => storeSessionView({ sessionId: newSessionId(), entries }),
  };
}

test("按条目号找快照：后台拍完的记录落在后面的消息之后也归到它的工具结果；没改动的跳过，没拍成的明确给出、不退回更早的快照", () => {
  const first = newRunId();
  const second = newRunId();
  const s = sessionBuilder();
  s.run(first);
  s.message("user"); // 1
  s.message("assistant"); // 2：调用 c1
  s.message("toolResult"); // 3
  s.mark(first, "c1", 3, "shooting");
  s.message("assistant"); // 4：调用 c2
  s.message("toolResult"); // 5
  s.mark(first, "c2", 5, "shooting");
  // c1 在后台拍完时，c2 的工具结果已经落盘
  s.checkpoint(first, "c1", 3, sha("1"), sha("0"));
  s.mark(first, "c2", 5, "unchanged");
  s.message("assistant"); // 6：调用 c3
  s.message("toolResult"); // 7
  s.mark(first, "c3", 7, "shooting");
  s.mark(first, "c3", 7, "failed");
  s.message("assistant"); // 8：调用 c4
  s.message("toolResult"); // 9
  s.mark(first, "c4", 9, "shooting"); // 进程在拍完之前退出
  s.run(second);
  s.message("user"); // 1
  const view = s.view();
  const at = (runId: RunId, runSeq: number) => storeCheckpointBefore(view, { runId, runSeq });

  assert.deepEqual(at(first, 2), { commit: sha("0") }, "首次改动之前取改前基线");
  for (const seq of [3, 4, 5, 6]) {
    assert.equal(at(first, seq)?.commit, sha("1"), `第 ${seq} 条取 c1 的快照（c2 没改动，不算）`);
  }
  for (const seq of [7, 8]) {
    const found = at(first, seq);
    assert.equal(found?.commit, undefined, `第 ${seq} 条不退回 c1 的快照`);
    assert.deepEqual([found?.unfinished?.toolCallId, found?.unfinished?.state], ["c3", "failed"]);
  }
  const crashed = at(first, 9);
  assert.deepEqual(
    [crashed?.unfinished?.toolCallId, crashed?.unfinished?.state],
    ["c4", "shooting"]
  );
  assert.equal(at(second, 1)?.unfinished?.toolCallId, "c4", "更早 Run 的最后一次没拍成同样报出");
});

test("首次改动之前的分叉点：基线没拍成（只有没拍成的标记，或快照不带改前基线）报 baseMissing；只有文件没变的标记即从未改过文件", () => {
  const run = newRunId();
  const onlyUnfinished = sessionBuilder();
  onlyUnfinished.run(run);
  onlyUnfinished.message("user"); // 1
  onlyUnfinished.message("assistant"); // 2
  onlyUnfinished.message("toolResult"); // 3
  onlyUnfinished.mark(run, "c1", 3, "shooting");
  assert.deepEqual(storeCheckpointBefore(onlyUnfinished.view(), { runId: run, runSeq: 1 }), {
    baseMissing: true,
  });

  const noBase = sessionBuilder();
  noBase.run(run);
  noBase.message("user"); // 1
  noBase.message("assistant"); // 2
  noBase.message("toolResult"); // 3
  noBase.checkpoint(run, "c1", 3, sha("1"));
  assert.deepEqual(storeCheckpointBefore(noBase.view(), { runId: run, runSeq: 2 }), {
    baseMissing: true,
  });
  assert.equal(storeCheckpointBefore(noBase.view(), { runId: run, runSeq: 3 })?.commit, sha("1"));

  const unchanged = sessionBuilder();
  unchanged.run(run);
  unchanged.message("user"); // 1
  unchanged.message("assistant"); // 2
  unchanged.message("toolResult"); // 3
  unchanged.mark(run, "c1", 3, "shooting");
  unchanged.mark(run, "c1", 3, "unchanged");
  assert.equal(storeCheckpointBefore(unchanged.view(), { runId: run, runSeq: 1 }), undefined);
});
