// 代码快照移出关键路径（决策 350）：
// - 只有工具自己的证据确定没有改动（编辑在写入之前失败、被拦下）才不拍；其余（含 run_command，不论文件变化报告）一律拍，
//   要不要新提交由快照比对文件树决定；
// - 工具结果交回（PostToolUse 钩子跑完）即写"拍摄中"标记（工具调用号与条目号），快照在后台拍，拍完写快照条目；
// - 下一次工具执行之前（Adapter 的等待口）、任何钩子运行之前、分叉之前先等未完成的快照拍完；等待有上限，超时的记为失败并中止；
// - 退出时先停运行面再等快照，最后一个工具结果的快照同样拍完、落盘；
// - 进程在拍完之前退出留下的"拍摄中"使对应分叉点明确报错，不退回更早的快照、不拿改后的现状顶替，也不留分叉记录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
import {
  type CheckpointData,
  type SessionCustomEntry,
  SessionEntryType,
} from "../state/session-entries.ts";
import { TOOL_RESULT_MARK_KEY } from "../state/session-judge.ts";
import { emptySettingsSnapshot } from "../state/settings.ts";
import {
  attachCheckpoints,
  type CheckpointHost,
  CheckpointWaitTimeoutError,
  evidenceShowsNoChange,
} from "./checkpoints.ts";
import { ForkError, runForkBranch } from "./fork.ts";
import { SessionHooks } from "./hooks.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

const sha = (digit: string) => digit.repeat(40);
const noChanges = { fileChanges: { added: [], removed: [], modified: [], truncated: false } };
const marked = (mark: Record<string, unknown>) => ({ [TOOL_RESULT_MARK_KEY]: mark });
const approved = { outcome: "approved", approvedBy: "policy:yolo" };

test("确定没有改动的判定：只有 edit_file 在写入之前失败或被拦下、且没有失败后的钩子；其余都要拍", () => {
  const cases: Array<[string, Parameters<typeof evidenceShowsNoChange>, boolean]> = [
    [
      "编辑被拦下",
      [
        {
          toolName: "edit_file",
          isError: true,
          details: marked({ gate: { outcome: "rejected", approvedBy: "human" } }),
        },
        false,
      ],
      true,
    ],
    [
      "编辑在写入之前出错（域错误）",
      [
        {
          toolName: "edit_file",
          isError: true,
          details: marked({ gate: approved, errorKind: "domain" }),
        },
        false,
      ],
      true,
    ],
    [
      "编辑写入时出错（环境异常，可能写了一半）",
      [
        {
          toolName: "edit_file",
          isError: true,
          details: marked({ gate: approved, errorKind: "environment" }),
        },
        false,
      ],
      false,
    ],
    [
      "编辑出错但配置了失败后的钩子",
      [
        {
          toolName: "edit_file",
          isError: true,
          details: marked({ gate: approved, errorKind: "domain" }),
        },
        true,
      ],
      false,
    ],
    ["编辑成功", [{ toolName: "edit_file", isError: false, details: undefined }, false], false],
    [
      "命令的文件变化报告为空",
      [{ toolName: "run_command", isError: false, details: noChanges }, false],
      false,
    ],
    [
      "其他写档工具出错",
      [{ toolName: "take_worker", isError: true, details: marked({ errorKind: "domain" }) }, false],
      false,
    ],
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

test("确定没改动的不拍；其余先写拍摄中标记再后台拍，等待口等它拍完才放行，拍完写带条目号的快照条目", async () => {
  const fake = fakeHost();
  const held = heldCheckpointer();
  const attached = attachCheckpoints({
    bundle: fake.host,
    workspaceRoot: "",
    checkpointer: held.checkpointer,
  });
  assert.ok(attached !== undefined);
  fake.propose("edit_file");
  fake.result("edit_file", "c0", true, marked({ gate: approved, errorKind: "domain" }));
  await fake.gate();
  assert.equal(held.afterCalls(), 0, "确定没改动的不拍");
  assert.deepEqual(fake.entries, []);

  // 文件变化报告为空的命令照拍
  const seq = fake.result("run_command", "c1", false, noChanges);
  assert.deepEqual(fake.rows(), [[SessionEntryType.CheckpointMark, "shooting", "c1", seq]]);
  let passed = false;
  const gating = fake.gate().then(() => {
    passed = true;
  });
  await delay(30);
  assert.equal(passed, false, "快照没拍完，下一次工具不得执行");
  held.finish({ ref: "refs/pigeon/checkpoints/s/1", commit: sha("1"), tree: sha("2") });
  await gating;
  assert.deepEqual(fake.rows().at(-1), [SessionEntryType.Checkpoint, sha("1"), "c1", seq]);
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

test("任何钩子运行之前先等未完成的快照拍完", async () => {
  const fake = fakeHost();
  const ran: string[] = [];
  const hooks = new SessionHooks({
    sessionId: fake.host.adapter.sessionId,
    governanceRoot: tmpdir(),
    workspaceRoot: tmpdir(),
    platform: process.platform,
    hooks: [{ event: "Stop", command: "stop-hook", host: false, layer: "project" }],
    disableAllHooks: false,
    runLocal: async () => {
      ran.push("Stop");
      return { spawned: true, exitCode: 0, timedOut: false, durationMs: 0, stdout: "", stderr: "" };
    },
  });
  fake.host.hooks = hooks;
  const held = heldCheckpointer();
  const attached = attachCheckpoints({
    bundle: fake.host,
    workspaceRoot: "",
    checkpointer: held.checkpointer,
  });
  assert.ok(attached !== undefined);
  fake.result("run_command", "c1", false, noChanges);
  const running = hooks.runEvent("Stop", "", {});
  await delay(30);
  assert.deepEqual(ran, [], "快照没拍完，钩子不得运行");
  held.finish(undefined);
  await running;
  assert.deepEqual(ran, ["Stop"]);
  assert.deepEqual(fake.rows().at(-1), [SessionEntryType.CheckpointMark, "unchanged", "c1", 2]);
  await attached.close();
});

// ---- 真实 git 仓库 ----

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(gitignore: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-cp-async-")));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "pigeon@example.invalid"]);
  git(root, ["config", "user.name", "pigeon-test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, ".gitignore"), gitignore);
  writeFileSync(join(root, "a.txt"), "old\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

// 遍历比大小与修改时间的文件变化报告漏掉的几种改动：报告为空也要拍到
const MISSED_BY_LISTING: Array<{
  name: string;
  posixOnly?: boolean;
  setup?: (root: string) => void;
  change: (root: string) => void;
  check: (root: string, commit: string) => void;
}> = [
  {
    name: "改权限",
    posixOnly: true,
    change: (root) => chmodSync(join(root, "a.txt"), 0o755),
    check: (root, commit) => assert.match(git(root, ["ls-tree", commit, "a.txt"]), /^100755 /),
  },
  {
    name: "新增符号链接",
    posixOnly: true,
    change: (root) => symlinkSync("a.txt", join(root, "link")),
    check: (root, commit) => assert.match(git(root, ["ls-tree", commit, "link"]), /^120000 /),
  },
  {
    name: "改符号链接的指向",
    posixOnly: true,
    setup: (root) => {
      writeFileSync(join(root, "b.txt"), "b\n");
      symlinkSync("a.txt", join(root, "link"));
    },
    change: (root) => {
      rmSync(join(root, "link"));
      symlinkSync("b.txt", join(root, "link"));
    },
    check: (root, commit) => assert.equal(git(root, ["cat-file", "-p", `${commit}:link`]), "b.txt"),
  },
  {
    name: "删除符号链接",
    posixOnly: true,
    setup: (root) => symlinkSync("a.txt", join(root, "link")),
    change: (root) => rmSync(join(root, "link")),
    check: (root, commit) => assert.equal(git(root, ["ls-tree", commit, "link"]), ""),
  },
  {
    name: "改仓库已跟踪的 .pigeon/settings.json",
    setup: (root) => {
      mkdirSync(join(root, ".pigeon"));
      writeFileSync(join(root, ".pigeon", "settings.json"), "{}\n");
      git(root, ["add", "-f", ".pigeon/settings.json"]);
      git(root, ["commit", "-q", "-m", "settings"]);
    },
    change: (root) => writeFileSync(join(root, ".pigeon", "settings.json"), '{"a":1}\n'),
    check: (root, commit) =>
      assert.equal(git(root, ["show", `${commit}:.pigeon/settings.json`]), '{"a":1}\n'),
  },
  {
    name: "改仓库已跟踪的 .pigeon/skills 下的文件",
    setup: (root) => {
      mkdirSync(join(root, ".pigeon", "skills", "s"), { recursive: true });
      writeFileSync(join(root, ".pigeon", "skills", "s", "SKILL.md"), "one\n");
      git(root, ["add", "-f", ".pigeon/skills"]);
      git(root, ["commit", "-q", "-m", "skill"]);
    },
    change: (root) => writeFileSync(join(root, ".pigeon", "skills", "s", "SKILL.md"), "two\n"),
    check: (root, commit) =>
      assert.equal(git(root, ["show", `${commit}:.pigeon/skills/s/SKILL.md`]), "two\n"),
  },
  {
    name: "保留修改时间的同长度覆盖",
    change: (root) => {
      const file = join(root, "a.txt");
      const { atime, mtime } = statSync(file);
      writeFileSync(file, "new\n");
      utimesSync(file, atime, mtime);
    },
    check: (root, commit) => assert.equal(git(root, ["show", `${commit}:a.txt`]), "new\n"),
  },
];

for (const item of MISSED_BY_LISTING) {
  test(`run_command 之后照拍，文件变化报告为空也拍到：${item.name}`, {
    skip: item.posixOnly === true && process.platform === "win32",
  }, async () => {
    const root = makeRepo(".pigeon/state/\n.pigeon/settings.local.json\n");
    try {
      item.setup?.(root);
      const fake = fakeHost();
      const attached = attachCheckpoints({
        bundle: fake.host,
        workspaceRoot: root,
        checkpointer: createCheckpointer({
          workspaceRoot: root,
          sessionId: fake.host.adapter.sessionId,
        }),
      });
      assert.ok(attached !== undefined);
      fake.propose("run_command");
      await fake.gate();
      item.change(root);
      fake.result("run_command", "c1", false, noChanges);
      await fake.gate();
      const last = fake.entries.at(-1);
      assert.ok(last?.customType === SessionEntryType.Checkpoint, JSON.stringify(fake.rows()));
      item.check(root, (last.data as CheckpointData).commit);
      assert.deepEqual(attached.errors(), []);
      await attached.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// ---- 真实运行面 ----

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

async function withSession(
  replies: Parameters<typeof createFakeStreamFn>[0]["replies"],
  body: (input: {
    root: string;
    home: string;
    sessionId: SessionId;
    opened: Awaited<ReturnType<typeof openSessionRuntime>>;
  }) => Promise<void>,
  options: { hooks?: (home: string) => ReturnType<typeof emptySettingsSnapshot>["hooks"] } = {}
): Promise<void> {
  const root = makeRepo(".pigeon/\n");
  const home = mkdtempSync(join(tmpdir(), "pigeon-cp-async-home-"));
  try {
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn: createFakeStreamFn({ replies }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
      ...(options.hooks !== undefined
        ? { settings: { ...emptySettingsSnapshot(root), hooks: options.hooks(home) } }
        : {}),
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

const sessionsOf = (root: string) => join(root, ".pigeon", "state", "sessions");

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

test("快照在 PostToolUse 钩子跑完之后才拍：钩子改的文件进快照", async () => {
  await withSession(
    [
      { text: "看", toolCalls: [{ name: "run_command", args: { command: "node --version" } }] },
      { text: "好" },
    ],
    async ({ root, sessionId, opened }) => {
      await opened.bundle.adapter.run("看版本");
      await opened.checkpoints?.settle();
      await opened.bundle.sessionStore.flush();
      const run = loadStoreSession(sessionsOf(root), sessionId)?.view.runs[0];
      const commit = run?.checkpoints[0]?.data.commit;
      assert.ok(commit !== undefined, "命令之后拍到快照");
      assert.equal(git(root, ["show", `${commit}:hooked.txt`]), "hooked\n");
    },
    {
      hooks: (home) => {
        const script = join(home, "post.mjs");
        writeFileSync(
          script,
          [
            "import { writeFileSync } from 'node:fs';",
            "process.stdin.on('data', () => {}).on('end', () => writeFileSync('hooked.txt', 'hooked\\n'));",
          ].join("\n")
        );
        return [
          {
            event: "PostToolUse",
            matcher: "run_command",
            command: `node "${script}"`,
            host: false,
            layer: "project",
          },
        ];
      },
    }
  );
});

test("分叉之前先等未完成的快照拍完：快照卡住时分叉不往下走，放行后分叉点取到刚拍完的快照", async () => {
  await withSession(EDIT, async ({ root, home, sessionId, opened }) => {
    opened.checkpoints?.stop();
    const real = createCheckpointer({ workspaceRoot: root, sessionId });
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const blocked: Checkpointer = {
      ...real,
      afterChange: async (signal) => {
        await released;
        return real.afterChange(signal);
      },
    };
    const attached = attachCheckpoints({
      bundle: opened.bundle,
      workspaceRoot: root,
      checkpointer: blocked,
    });
    assert.ok(attached !== undefined);
    try {
      const { runId } = await opened.bundle.adapter.run("改");
      // 运行已收尾、快照还卡着：会话文件里只有拍摄中标记
      await opened.bundle.sessionStore.flush();
      const pending = loadStoreSession(sessionsOf(root), sessionId)?.view.runs[0];
      assert.deepEqual(
        [pending?.checkpoints.length, pending?.marks.map((mark) => mark.data.state)],
        [0, ["shooting"]]
      );
      let forked = false;
      const forking = runForkBranch({
        governanceRoot: root,
        sourceSessionId: sessionId,
        sourceStore: opened.bundle.sessionStore,
        // 开工状态块占 Run 的第 1 条消息（决策 363），其后序号整体后移一位
        forkPoint: { runId, runSeq: 4 },
        trigger: "manual",
        checkpointer: blocked,
        settleCheckpoints: attached.settle,
        run: branchRun(home),
      }).finally(() => {
        forked = true;
      });
      await delay(50);
      assert.equal(forked, false, "快照没拍完，分叉不得往下走");
      release();
      const result = await forking;
      assert.equal(git(root, ["show", `${result.checkpoint.commit}:a.txt`]), "new\n");
      assert.equal(readFileSync(join(result.workspace.path, "a.txt"), "utf8"), "new\n");
    } finally {
      release();
      await attached.close();
    }
  });
});

test("进程在拍完之前退出：该分叉点明确报错、不退回更早的快照；首次改动之前的分叉点也报错、不拿改后的现状顶替；不留分叉记录", async () => {
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
    const forkAt = (runSeq: number) =>
      runForkBranch({
        governanceRoot: root,
        sourceSessionId: sessionId,
        sourceStore: opened.bundle.sessionStore,
        forkPoint: { runId, runSeq },
        trigger: "manual",
        run: branchRun(home),
      });
    await assert.rejects(
      () => forkAt(4),
      (error) => error instanceof ForkError && /没有拍成/.test(error.message)
    );
    await assert.rejects(
      () => forkAt(2),
      (error) => error instanceof ForkError && /早于首次改动/.test(error.message)
    );
    const loaded = loadStoreSession(sessionsOf(root), sessionId);
    assert.equal(loaded?.view.forks.length, 0, "不留分叉记录");
  });
});

test("退出时先停运行面再等快照：进行中的命令被中止，它的快照照样拍完落盘", async () => {
  await withSession(
    [
      { text: "跑", toolCalls: [{ name: "run_command", args: { command: "node sleep.mjs" } }] },
      { text: "好" },
    ],
    async ({ root, sessionId, opened }) => {
      writeFileSync(join(root, "sleep.mjs"), "setTimeout(() => {}, 30_000);\n");
      let disposing: Promise<void> | undefined;
      opened.bundle.adapter.subscribe((event) => {
        if (event.kind === "tool.proposed" && disposing === undefined) {
          disposing = disposeRuntime(opened.bundle);
        }
      });
      await opened.bundle.adapter.run("跑").catch(() => undefined);
      await disposing;
      const run = loadStoreSession(sessionsOf(root), sessionId)?.view.runs[0];
      const result = run?.messages.findIndex((ref) => ref.message.role === "toolResult") ?? -1;
      assert.ok(run !== undefined && result >= 0, "命令有工具结果");
      // 命令没改文件：先写拍摄中，快照在会话存储关闭之前拍完、记为文件没变
      assert.deepEqual(
        run.marks.map((mark) => [mark.data.state, mark.data.runSeq]),
        [
          ["shooting", result + 1],
          ["unchanged", result + 1],
        ]
      );
    }
  );
});
