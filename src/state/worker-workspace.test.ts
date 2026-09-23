// worker 工作区联合（M6 S0，决策 064）：加法式新增"无工作区"成员（054 的形状封顶口径不变）。
// git-worktree 成员逐字不动，旧记录读取不变；收尾结果的分支与改动文件对无工作区的 worker 缺省。
// 只读、无工作区的 Reviewer 已退役（决策 137），这里守的是它的旧记录照常可读。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  ChildResultSchema,
  ChildSpawnedRecordSchema,
  EVENT_LOG_VERSION,
  parseEventRecord,
  WorkerWorkspaceSchema,
} from "./event-log.ts";
import { newEntryId, newReceiptId, newRunId, newSessionId } from "./ids.ts";

test("工作区联合：git-worktree 与 none 两种形状都通过；缺字段或未知成员被拒绝", () => {
  assert.ok(
    Value.Check(WorkerWorkspaceSchema, {
      kind: "git-worktree",
      path: "/repo/.pigeon/worktrees/w",
      branch: "pigeon/w",
    })
  );
  assert.ok(Value.Check(WorkerWorkspaceSchema, { kind: "none" }));
  assert.ok(!Value.Check(WorkerWorkspaceSchema, { kind: "git-worktree", path: "/repo" }));
  assert.ok(!Value.Check(WorkerWorkspaceSchema, { kind: "container", image: "node" }));
});

test("收尾结果：无工作区时分支与改动文件缺省，可携带结构化内容；既有形状照旧通过", () => {
  const worktreeResult = {
    branch: "pigeon/w",
    changedFiles: ["a.ts"],
    receiptIds: [newReceiptId()],
    summary: "改完了",
    summaryTruncated: false,
  };
  assert.ok(Value.Check(ChildResultSchema, worktreeResult), "既有 worker 结果逐字有效");

  const reviewerResult = {
    receiptIds: [],
    summary: "提出 1 个候选",
    summaryTruncated: false,
    structured: { candidates: [{ kind: "skill", name: "anchors" }] },
  };
  assert.ok(
    Value.Check(ChildResultSchema, reviewerResult),
    "已退役 Reviewer 的旧结果（无工作区）可缺分支与改动文件"
  );
});

test("派出记录：已退役 Reviewer 的旧记录（无工作区成员、reviewer 角色）读路径按当前版本校验通过", () => {
  const record = {
    version: EVENT_LOG_VERSION,
    id: newEntryId(),
    sessionId: newSessionId(),
    runId: newRunId(),
    timestamp: 1,
    kind: "child.spawned",
    childSessionId: newSessionId(),
    name: "reviewer-1",
    role: "reviewer",
    task: "审阅本次运行",
    policy: { allow: ["review_snapshot"], deny: [], approvalMode: "prompt" },
    limits: { maxTurns: 12, wallClockMs: 180_000 },
    workspace: { kind: "none" },
    spawnedAt: 1,
  };
  assert.ok(Value.Check(ChildSpawnedRecordSchema, record));
  const parsed = parseEventRecord(record);
  assert.equal(parsed.kind, "child.spawned");
  assert.deepEqual(parsed.kind === "child.spawned" ? parsed.workspace : undefined, {
    kind: "none",
  });
});
