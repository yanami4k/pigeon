// 代码快照移出关键路径（决策 350）：
// - 工具自己的证据显示没有改动（编辑失败、命令的文件变化报告为空且完整）就不拍；
// - 有改动时工具结果交回即写"拍摄中"标记（工具调用号与条目号），快照在后台拍，拍完写快照条目；
// - 下一次工具执行之前（Adapter 的等待口）、分叉之前先等未完成的快照拍完；等待有上限，超时的记为失败并中止；
// - 进程在拍完之前退出留下的"拍摄中"使对应分叉点明确报错，不退回更早的快照，也不留分叉记录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Checkpointer,
  type CheckpointResult,
  createCheckpointer,
} from "../orchestration/checkpoint.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { type SessionCustomEntry, SessionEntryType } from "../state/session-entries.ts";
import {
  attachCheckpoints,
  type CheckpointHost,
  CheckpointWaitTimeoutError,
  evidenceShowsNoChange,
} from "./checkpoints.ts";
import { ForkError, runForkBranch } from "./fork.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

const sha = (digit: string) => digit.repeat(40);
const noChanges = { fileChanges: { added: [], removed: [], modified: [], truncated: false } };

test("没改动不拍的判定：编辑失败、命令带完整且为空的文件变化报告；其余都要拍", () => {
  const cases: Array<[string, Parameters<typeof evidenceShowsNoChange>, boolean]> = [
    ["编辑失败", ["write", { isError: true, details: undefined }], true],
    ["编辑成功", ["write", { isError: false, details: undefined }], false],
    ["命令没有改文件", ["exec", { isError: false, details: noChanges }], true],
    [
      "命令改了文件",
      [
        "exec",
        {
          isError: false,
          details: { fileChanges: { ...noChanges.fileChanges, modified: ["a.txt"] } },
        },
      ],
      false,
    ],
    [
      "命令的报告不完整",
      [
        "exec",
        { isError: false, details: { fileChanges: { ...noChanges.fileChanges, truncated: true } } },
      ],
      false,
    ],
    ["命令出错、没有报告", ["exec", { isError: true, details: undefined }], false],
  ];
  for (const [name, args, expected] of cases) {
    assert.equal(evidenceShowsNoChange(...args), expected, name);
  }
});

type Listener = Parameters<CheckpointHost["adapter"]["subscribe"]>[0];

function fakeHost() {
  const runId = newRunId();
  const proposed = new Set<Listener>();
  const results = new Set<Parameters<CheckpointHost["adapter"]["subscribeToolResults"]>[0]>();
  const gates = new Set<() => Promise<void>>();
  const entries: SessionCustomEntry[] = [];
  let seq = 0;
  const host: CheckpointHost = {
    adapter: {
      sessionId: newSessionId(),
      subscribe: (listener) => {
        proposed.add(listener);
        return () => proposed.delete(listener);
      },
      subscribeToolResults: (listener) => {
        results.add(listener);
        return () => results.delete(listener);
      },
      addToolGate: (gate) => {
        gates.add(gate);
        return () => gates.delete(gate);
      },
      entrySeq: () => seq,
    },
    toolTiers: new Map([
      ["edit_file", "write"],
      ["run_command", "exec"],
    ]),
    sessionStore: { append: (entry) => void entries.push(entry) },
  };
  return {
    host,
    entries,
    // 条目里与断言有关的几项
    rows: () =>
      entries.map((entry) => {
        const data = entry.data as unknown as Record<string, unknown>;
        return [entry.customType, data.state ?? data.commit, data.toolCallId, data.runSeq];
      }),
    propose: (toolName: string) => {
      const event = { kind: "tool.proposed", payload: { toolName, toolCallId: "p", args: {} } };
      for (const listener of proposed) listener(event as unknown as Parameters<Listener>[0]);
    },
    // 一次调用占助手消息与工具结果两个条目号
    result: (toolName: string, toolCallId: string, isError: boolean, details?: unknown) => {
      seq += 2;
      for (const listener of results) {
        listener({ runId, toolCallId, toolName, isError, text: "", details });
      }
      return seq;
    },
    gate: async () => {
      for (const gate of gates) await gate();
    },
  };
}

// afterChange 由测试放行的快照器
function heldCheckpointer() {
  let finish: (result: CheckpointResult | undefined) => void = () => {};
  let aborted = false;
  let afterCalls = 0;
  const checkpointer: Checkpointer = {
    beforeChange: async () => {},
    afterChange: (signal) => {
      afterCalls += 1;
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    snapshotNow: () => Promise.reject(new Error("不该用到")),
    pin: () => Promise.reject(new Error("不该用到")),
    close: async () => {},
  };
  return {
    checkpointer,
    finish: (result: CheckpointResult | undefined) => finish(result),
    aborted: () => aborted,
    afterCalls: () => afterCalls,
  };
}

test("有改动先写拍摄中标记再后台拍；等待口等它拍完才放行，拍完写带条目号的快照条目", async () => {
  const fake = fakeHost();
  const held = heldCheckpointer();
  const attached = attachCheckpoints({
    bundle: fake.host,
    workspaceRoot: "",
    checkpointer: held.checkpointer,
  });
  assert.ok(attached !== undefined);
  fake.propose("edit_file");
  fake.result("edit_file", "c0", true);
  fake.result("run_command", "c1", false, noChanges);
  await fake.gate();
  assert.equal(held.afterCalls(), 0, "没改动的不拍");
  assert.deepEqual(fake.entries, []);

  const seq = fake.result("edit_file", "c2", false);
  assert.deepEqual(fake.rows(), [[SessionEntryType.CheckpointMark, "shooting", "c2", seq]]);
  let passed = false;
  const gating = fake.gate().then(() => {
    passed = true;
  });
  await delay(30);
  assert.equal(passed, false, "快照没拍完，下一次工具不得执行");
  held.finish({ ref: "refs/pigeon/checkpoints/s/1", commit: sha("1"), tree: sha("2") });
  await gating;
  assert.deepEqual(fake.rows().at(-1), [SessionEntryType.Checkpoint, sha("1"), "c2", seq]);
  await attached.close();
});

test("等待有上限：卡住的快照到点放行，记为失败并中止，之后到达的结果不再写", {
  timeout: 10_000,
}, async () => {
  const fake = fakeHost();
  const held = heldCheckpointer();
  const attached = attachCheckpoints({
    bundle: fake.host,
    workspaceRoot: "",
    checkpointer: held.checkpointer,
    waitMs: 50,
    warn: () => {},
  });
  assert.ok(attached !== undefined);
  const seq = fake.result("edit_file", "c1", false);
  await fake.gate();
  assert.deepEqual(fake.rows(), [
    [SessionEntryType.CheckpointMark, "shooting", "c1", seq],
    [SessionEntryType.CheckpointMark, "failed", "c1", seq],
  ]);
  assert.ok(held.aborted(), "卡住的 git 被中止");
  assert.deepEqual(
    attached.errors().map((error) => error instanceof CheckpointWaitTimeoutError),
    [true]
  );
  held.finish({ ref: "refs/pigeon/checkpoints/s/1", commit: sha("1"), tree: sha("2") });
  await delay(10);
  assert.equal(fake.entries.length, 2, "超时之后到达的快照不再写");
});

// ---- 真实运行面 ----

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function withSession(
  replies: Parameters<typeof createFakeStreamFn>[0]["replies"],
  body: (input: {
    root: string;
    home: string;
    sessionId: SessionId;
    opened: Awaited<ReturnType<typeof openSessionRuntime>>;
  }) => Promise<void>
): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-cp-async-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-cp-async-home-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "pigeon@example.invalid"]);
    git(root, ["config", "user.name", "pigeon-test"]);
    git(root, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
    writeFileSync(join(root, "a.txt"), "old\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "init"]);
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn: createFakeStreamFn({ replies }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
    });
    try {
      await body({ root, home, sessionId, opened });
    } finally {
      await disposeRuntime(opened.bundle);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const EDIT = [
  {
    text: "改",
    toolCalls: [
      { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: "new\n" } },
    ],
  },
  { text: "改好了" },
];

const branchRun = (home: string) => ({
  streamFn: createFakeStreamFn({ replies: [{ text: "分支好" }] }),
  yolo: true,
  homeDir: home,
  startMcp: noMcp,
});

test("工具执行之前先过等待口：等待口里落下的文件，随后执行的工具看得到", async () => {
  await withSession(
    [{ text: "读", toolCalls: [{ name: "read_file", args: { path: "b.txt" } }] }, { text: "好" }],
    async ({ root, opened }) => {
      opened.bundle.adapter.addToolGate(async () => {
        await delay(50);
        writeFileSync(join(root, "b.txt"), "gated\n");
      });
      await opened.bundle.adapter.run("读 b.txt");
      const result = opened.bundle.adapter
        .transcript()
        .find((message) => message.role === "toolResult");
      assert.match(JSON.stringify(result?.content), /gated/);
    }
  );
});

test("分叉之前先等未完成的快照拍完：分叉点取到刚拍完的快照", async () => {
  await withSession(EDIT, async ({ root, home, sessionId, opened }) => {
    // 换上拍得比运行收尾慢的快照器
    opened.checkpoints?.stop();
    const real = createCheckpointer({ workspaceRoot: root, sessionId });
    const slow: Checkpointer = {
      ...real,
      afterChange: async (signal) => {
        await delay(300);
        return real.afterChange(signal);
      },
    };
    const attached = attachCheckpoints({
      bundle: opened.bundle,
      workspaceRoot: root,
      checkpointer: slow,
    });
    assert.ok(attached !== undefined);
    try {
      const { runId } = await opened.bundle.adapter.run("改");
      const result = await runForkBranch({
        governanceRoot: root,
        sourceSessionId: sessionId,
        sourceStore: opened.bundle.sessionStore,
        forkPoint: { runId, runSeq: 3 },
        trigger: "manual",
        checkpointer: slow,
        settleCheckpoints: attached.settle,
        run: branchRun(home),
      });
      assert.equal(git(root, ["show", `${result.checkpoint.commit}:a.txt`]), "new\n");
      assert.equal(readFileSync(join(result.workspace.path, "a.txt"), "utf8"), "new\n");
    } finally {
      await attached.close();
    }
  });
});

test("进程在拍完之前退出：留下的拍摄中标记使该分叉点明确报错，不退回更早的快照，不留分叉记录", async () => {
  await withSession(EDIT, async ({ root, home, sessionId, opened }) => {
    opened.checkpoints?.stop();
    const real = createCheckpointer({ workspaceRoot: root, sessionId });
    const attached = attachCheckpoints({
      bundle: opened.bundle,
      workspaceRoot: root,
      checkpointer: { ...real, afterChange: () => new Promise(() => {}) },
    });
    const { runId } = await opened.bundle.adapter.run("改");
    // 模拟进程退出：不等快照、不写下文；分叉方只读到会话文件（不给等待口与快照器）
    attached?.stop();
    await assert.rejects(
      () =>
        runForkBranch({
          governanceRoot: root,
          sourceSessionId: sessionId,
          sourceStore: opened.bundle.sessionStore,
          forkPoint: { runId, runSeq: 3 },
          trigger: "manual",
          run: branchRun(home),
        }),
      (error) => error instanceof ForkError && /没有拍成/.test(error.message)
    );
    const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
    assert.equal(loaded?.view.forks.length, 0, "不留分叉记录");
  });
});
