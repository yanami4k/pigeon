// 派 worker 工具（决策 264–268、271）：冻结文字逐字、各情形的返回、同时在跑的上限与排队（人派的一并计算）、
// 一次运行 agent 派满即拒绝（人派的不计入）、撞 worker 上限交回部分结果、等待中被中止即取消、多份尝试按验证标签分段。
// 编排器用真实实现，运行面与工作区用内存替身。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Compile } from "typebox/compile";
import {
  WorkerOrchestrator,
  type WorkerOutcome,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
  type WorkspaceProvider,
} from "../orchestration/workers.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import type { OutcomeLabel } from "../state/outcome-label.ts";
import {
  createSpawnWorkerTool,
  DEFAULT_SPAWN_WORKER_LIMITS,
  SPAWN_WORKER_TEXTS,
  SpawnWorkerBudget,
  type SpawnWorkerHost,
  type SpawnWorkerParams,
  SpawnWorkerParamsSchema,
  SpawnWorkerSlot,
  spawnWorkerDescription,
} from "./spawn-worker-tool.ts";

// 冻结原文（说明文字草稿第 2–4 节）
const FROZEN_DESCRIPTION = `派一个 worker 去完成一项独立的子任务，等它做完，把它的分支、改动过的文件与工作摘要交回给你。
worker 从当前提交开工，在自己的 git 工作树与分支里干活；看不到你还没提交的改动，也看不到本会话的对话。要它接着你的改动干，先提交。
要并行，就在同一次回复里多次调用本工具，每次派一个；同时最多跑 4 个，多的排队；一次运行最多派 16 个。
何时派：任务能拆成互不依赖的几块、并行能明显省时间时才派，通常 2 到 4 个就够；简单的活、前后依赖紧的活自己做。每个 worker 都要重新读代码，派得越多花得越多。
任务要写得能独立完成：目标、相关文件、完成的标准都写清楚。worker 不能向你提问，也不能再派 worker。
角色决定 worker 能用的工具：explorer 只能读代码与检索历史会话，适合调查与定位；implementer 能读写文件、不能跑命令，适合按明确的方案改代码；tester 能读文件与跑命令、不能改文件，适合运行与诊断测试。
worker 的改动不会自动并入你的分支：看过交回的分支与摘要后，由你决定合不合、怎么合。`;

const FROZEN_PARAMS = {
  role: "worker 的角色，决定它能用的工具，见工具说明",
  task: "子任务的完整说明：目标、相关文件、完成的标准",
  name: "worker 的名字，用于分支名与状态显示；不给即自动生成",
  attempts:
    "同一任务并行派出的份数；给了即各做一份，做完后按验证命令给每份标上通过、未通过或未知，全部交回",
};

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(git: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-spawn-tool-"));
  roots.push(dir);
  if (git) {
    execFileSync("git", ["init", "-q", dir]);
  }
  return dir;
}

// 运行面替身：complete 立即完成；hang 等放行或中止；endless 一轮接一轮直到被中止；fail 以失败收尾
type Behavior = "complete" | "hang" | "endless" | "fail";

interface Script {
  behavior: Behavior;
  summary?: string;
  tokensPerTurn?: number;
}

class FakeRuntime implements WorkerRuntimeHandle {
  readonly listeners = new Set<(event: EventEnvelope) => void>();
  readonly #stop = Promise.withResolvers<void>();
  readonly #release = Promise.withResolvers<void>();
  #interrupted = false;
  started = false;
  readonly script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  release(): void {
    this.#release.resolve();
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #turn(): void {
    for (const listener of [...this.listeners]) {
      listener({
        kind: "turn.completed",
        payload: { usage: { totalTokens: this.script.tokensPerTurn ?? 0 } },
      } as unknown as EventEnvelope);
    }
  }

  async run() {
    this.started = true;
    const runId = newRunId();
    switch (this.script.behavior) {
      case "complete":
        this.#turn();
        return { status: "completed" as const, runId };
      case "fail":
        return { status: "failed" as const, errorMessage: "炸了", runId };
      case "hang":
        await Promise.race([this.#release.promise, this.#stop.promise]);
        if (this.#interrupted) {
          return { status: "aborted" as const, runId };
        }
        this.#turn();
        return { status: "completed" as const, runId };
      case "endless":
        while (!this.#interrupted) {
          this.#turn();
          await new Promise((resolve) => setImmediate(resolve));
        }
        return { status: "aborted" as const, runId };
    }
  }

  async interrupt(): Promise<void> {
    this.#interrupted = true;
    this.#stop.resolve();
  }

  summary(): string {
    return this.script.summary ?? "";
  }

  async dispose(): Promise<void> {}
}

interface Harness {
  orchestrator: WorkerOrchestrator;
  runtimes: Map<string, FakeRuntime>;
  budget: SpawnWorkerBudget;
  host: SpawnWorkerHost;
  tool: ReturnType<typeof createSpawnWorkerTool>;
  tokens: number[];
}

function harness(options: {
  scriptFor: (request: WorkerRuntimeRequest) => Script;
  files?: string[];
  git?: boolean;
  maxConcurrent?: number;
  maxAgentSpawns?: number;
  runKey?: () => string | undefined;
  maxTurns?: number;
  wallClockMs?: number;
  spawnAttempts?: SpawnWorkerHost["spawnAttempts"];
}): Harness {
  const root = tempDir(options.git ?? true);
  const runtimes = new Map<string, FakeRuntime>();
  const tokens: number[] = [];
  const workspaces: WorkspaceProvider = {
    plan: ({ name }) => ({
      kind: "git-worktree",
      path: join(root, ".pigeon", "worktrees", name),
      branch: `pigeon/${name}`,
    }),
    create: () => {},
    changedFiles: () => options.files ?? [],
  };
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: root,
    session: { sessionId: newSessionId() },
    parentPolicy: {
      allow: ["read_file", "edit_file", "run_command"],
      deny: [],
      approvalMode: "yolo",
    },
    parentLog: { appendChildSpawned: () => {}, appendChildSettled: () => {} },
    createRuntime: (request) => {
      const runtime = new FakeRuntime(options.scriptFor(request));
      runtimes.set(request.name, runtime);
      return runtime;
    },
    approvals: async () => ({ approved: true }),
    workspaces,
    maxConcurrent: options.maxConcurrent ?? DEFAULT_SPAWN_WORKER_LIMITS.maxConcurrent,
    onWorkerTokens: (_id, count) => {
      tokens.push(count);
    },
    defaultLimits: {
      maxTurns: options.maxTurns ?? 40,
      wallClockMs: options.wallClockMs ?? 60_000,
    },
  });
  const budget = new SpawnWorkerBudget({
    maxAgentSpawns: options.maxAgentSpawns ?? DEFAULT_SPAWN_WORKER_LIMITS.maxAgentSpawns,
    ...(options.runKey !== undefined ? { runKey: options.runKey } : {}),
  });
  const host: SpawnWorkerHost = {
    orchestrator,
    governanceRoot: root,
    budget,
    spawnAttempts:
      options.spawnAttempts ??
      (async () => {
        throw new Error("本用例不派多份尝试");
      }),
  };
  const slot = new SpawnWorkerSlot();
  slot.bind(host);
  return { orchestrator, runtimes, budget, host, tool: createSpawnWorkerTool(slot), tokens };
}

async function call(h: Harness, params: SpawnWorkerParams, signal?: AbortSignal): Promise<string> {
  const result = await h.tool.execute("call", params, signal);
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === "text");
  return block.text;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !check(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(check(), "等待的条件没有成立");
}

test("工具说明与参数说明逐字为冻结原文；执行模式可并行", () => {
  const tool = createSpawnWorkerTool(new SpawnWorkerSlot());
  assert.equal(tool.name, "spawn_worker");
  assert.equal(tool.description, FROZEN_DESCRIPTION);
  assert.equal(spawnWorkerDescription(DEFAULT_SPAWN_WORKER_LIMITS), FROZEN_DESCRIPTION);
  assert.equal(tool.executionMode, "parallel");
  const properties = SpawnWorkerParamsSchema.properties;
  for (const [key, description] of Object.entries(FROZEN_PARAMS)) {
    assert.equal(
      (properties[key as keyof typeof properties] as { description?: string }).description,
      description,
      key
    );
  }
  assert.deepEqual([...SpawnWorkerParamsSchema.required].sort(), ["role", "task"]);
  // role 为三个角色的枚举（冻结参数表的类型）
  const check = Compile(SpawnWorkerParamsSchema);
  for (const role of ["explorer", "implementer", "tester"]) {
    assert.equal(check.Check({ role, task: "看" }), true, role);
  }
  assert.equal(check.Check({ role: "reviewer", task: "看" }), false);
  const attempts = properties.attempts as unknown as { minimum?: number; maximum?: number };
  assert.equal(attempts.minimum, 2);
  assert.equal(attempts.maximum, 4);
});

test("固定情形的返回文字逐字为冻结原文", () => {
  assert.equal(
    SPAWN_WORKER_TEXTS.spawnLimit(16),
    "本次运行派出的 worker 已达 16 个上限。不要再派；用已有的结果，或自己完成。"
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.budgetExhausted,
    "本次运行的额度已用完，不能再派 worker；正在跑的 worker 已停止。"
  );
  assert.equal(SPAWN_WORKER_TEXTS.notGit, "当前工作区不是 git 仓库，不能派 worker。");
  assert.equal(
    SPAWN_WORKER_TEXTS.unknownRole("reviewer"),
    "没有角色 reviewer；可选：explorer、implementer、tester。"
  );
  assert.equal(SPAWN_WORKER_TEXTS.emptyTask, "task 不能为空：写清目标、相关文件与完成的标准。");
});

test("完成：等到 worker 收尾，交回分支、改动文件与摘要；摘要截断时补上会话号", async () => {
  const h = harness({
    scriptFor: ({ name }) => ({
      behavior: "complete",
      summary: name === "long" ? "长".repeat(2100) : "改好了",
    }),
    files: ["a.ts", "b.ts"],
  });
  // 内存工作区没有起点提供者：不带起点那一行（带起点的文字见 workers-start.test.ts）
  assert.equal(
    await call(h, { role: "implementer", task: "改 a", name: "fix-a" }),
    "worker fix-a（implementer）已完成。分支：pigeon/fix-a。改动的文件（2）：a.ts、b.ts。摘要：改好了"
  );
  const long = await call(h, { role: "explorer", task: "看看", name: "long" });
  const id = h.orchestrator.status().find((worker) => worker.name === "long")?.sessionId;
  assert.ok(id !== undefined);
  assert.ok(long.startsWith("worker long（explorer）已完成。分支：pigeon/long。"), long);
  assert.ok(long.endsWith(`（摘要已截断，全文在 worker 会话 ${id} 里）`), long);
});

test("撞上 worker 自己的轮数或时间上限：交回已做的部分，按没有做完返回", async () => {
  const turns = harness({
    scriptFor: () => ({ behavior: "endless", summary: "做了一半" }),
    files: ["x.ts"],
    maxTurns: 3,
  });
  assert.equal(
    await call(turns, { role: "explorer", task: "查", name: "w" }),
    "worker w（explorer）撞上轮数上限，没有做完。分支：pigeon/w。已改动的文件（1）：x.ts。摘要：做了一半"
  );
  const clock = harness({
    scriptFor: () => ({ behavior: "hang", summary: "" }),
    wallClockMs: 20,
  });
  assert.equal(
    await call(clock, { role: "tester", task: "跑", name: "t" }),
    "worker t（tester）撞上时间上限，没有做完。分支：pigeon/t。已改动的文件（0）：无。摘要："
  );
});

test("失败与被取消：等待中被中止即取消本次派出的 worker", async () => {
  const failed = harness({ scriptFor: () => ({ behavior: "fail" }) });
  assert.equal(
    await call(failed, { role: "implementer", task: "改", name: "bad" }),
    "worker bad（implementer）失败：炸了。分支 pigeon/bad 上可能有部分改动。"
  );
  const h = harness({ scriptFor: () => ({ behavior: "hang" }) });
  const controller = new AbortController();
  const pending = call(h, { role: "implementer", task: "改", name: "slow" }, controller.signal);
  await until(() => h.runtimes.get("slow")?.started === true);
  controller.abort();
  assert.equal(
    await pending,
    "worker slow（implementer）被取消。分支 pigeon/slow 上可能有部分改动。"
  );
  assert.equal(h.orchestrator.status()[0]?.state, "cancelled");
});

test("派出前的检查：角色写错、task 为空、不是 git 仓库，都按冻结文字回话且不派出", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "complete" }) });
  assert.equal(
    // 兜底：role 在 schema 里是枚举，写错通常由上游参数校验先拒绝；这里绕过校验直接调
    await call(h, { role: "reviewer" as SpawnWorkerParams["role"], task: "看" }),
    "没有角色 reviewer；可选：explorer、implementer、tester。"
  );
  assert.equal(
    await call(h, { role: "explorer", task: "  " }),
    "task 不能为空：写清目标、相关文件与完成的标准。"
  );
  const plain = harness({ scriptFor: () => ({ behavior: "complete" }), git: false });
  assert.equal(
    await call(plain, { role: "explorer", task: "看" }),
    "当前工作区不是 git 仓库，不能派 worker。"
  );
  assert.equal(h.orchestrator.status().length, 0);
  assert.equal(plain.orchestrator.status().length, 0);
  assert.equal(h.budget.spawned(), 0);
});

test("同时最多 4 个：多派的排队不拒绝，人用 /spawn 派的一并计算", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "hang", summary: "好" }) });
  // 人先派 2 个
  h.orchestrator.spawn({ role: "explorer", task: "人派", name: "human-1" });
  h.orchestrator.spawn({ role: "explorer", task: "人派", name: "human-2" });
  // agent 同一次回复派 4 个
  const calls = [1, 2, 3, 4].map((i) =>
    call(h, { role: "explorer", task: `agent ${i}`, name: `agent-${i}` })
  );
  await until(() => h.orchestrator.status().length === 6);
  await until(
    () => h.orchestrator.status().filter((worker) => worker.state === "running").length === 4
  );
  const states = () =>
    Object.fromEntries(h.orchestrator.status().map((worker) => [worker.name, worker.state]));
  assert.deepEqual(states(), {
    "human-1": "running",
    "human-2": "running",
    "agent-1": "running",
    "agent-2": "running",
    "agent-3": "queued",
    "agent-4": "queued",
  });
  // 排队中的还没开跑
  assert.equal(h.runtimes.get("agent-3")?.started, false);
  // 人派的一个收尾，排队的第一个接着开跑
  h.runtimes.get("human-1")?.release();
  await until(() => states()["agent-3"] === "running");
  assert.equal(states()["agent-4"], "queued");
  for (const runtime of h.runtimes.values()) {
    runtime.release();
  }
  await until(() => [...h.runtimes.values()].every((runtime) => runtime.started));
  for (const runtime of h.runtimes.values()) {
    runtime.release();
  }
  const texts = await Promise.all(calls);
  assert.ok(
    texts.every((text) => text.includes("已完成")),
    texts.join("\n")
  );
});

test("排队中取消：不开跑，按被取消收尾，空位账目对平", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "hang" }), maxConcurrent: 1 });
  const first = h.orchestrator.spawn({ role: "explorer", task: "一", name: "one" });
  const second = h.orchestrator.spawn({ role: "explorer", task: "二", name: "two" });
  await until(() => h.runtimes.get("one")?.started === true);
  await h.orchestrator.cancel(second);
  const outcome = await h.orchestrator.awaitResult(second);
  assert.equal(outcome.status, "cancelled");
  assert.equal(h.runtimes.get("two")?.started, false);
  h.runtimes.get("one")?.release();
  assert.equal((await h.orchestrator.awaitResult(first)).status, "completed");
  // 空位回到 1：再派一个能立即开跑
  const third = h.orchestrator.spawn({ role: "explorer", task: "三", name: "three" });
  await until(() => h.runtimes.get("three")?.started === true);
  h.runtimes.get("three")?.release();
  assert.equal((await h.orchestrator.awaitResult(third)).status, "completed");
});

test("一次运行 agent 最多派 16 个：满了按冻结文字拒绝；人派的不计入；换一次运行重新计", async () => {
  let run = "run-1";
  const h = harness({ scriptFor: () => ({ behavior: "complete" }), runKey: () => run });
  for (let i = 1; i <= 5; i += 1) {
    await h.orchestrator.awaitResult(
      h.orchestrator.spawn({ role: "explorer", task: "人派", name: `human-${i}` })
    );
  }
  for (let i = 1; i <= 16; i += 1) {
    assert.ok(
      (await call(h, { role: "explorer", task: `第 ${i} 个` })).includes("已完成"),
      String(i)
    );
  }
  assert.equal(
    await call(h, { role: "explorer", task: "第 17 个" }),
    "本次运行派出的 worker 已达 16 个上限。不要再派；用已有的结果，或自己完成。"
  );
  assert.equal(h.orchestrator.status().length, 21);
  // 人派的照常
  const human = h.orchestrator.spawn({ role: "explorer", task: "人派", name: "human-6" });
  assert.equal((await h.orchestrator.awaitResult(human)).status, "completed");
  // 换一次运行（终端界面里的下一条输入）从零计
  run = "run-2";
  assert.ok((await call(h, { role: "explorer", task: "新一次运行" })).includes("已完成"));
  assert.equal(h.budget.spawned(), 1);
});

test("本次运行的额度用完：拒绝再派，交回额度用完的文字", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "complete" }) });
  h.budget.markExhausted();
  assert.equal(
    await call(h, { role: "explorer", task: "看" }),
    "本次运行的额度已用完，不能再派 worker；正在跑的 worker 已停止。"
  );
  assert.equal(h.orchestrator.status().length, 0);
});

test("worker 每一轮的 token 回报给额度的持有方", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "endless", tokensPerTurn: 7 }), maxTurns: 3 });
  await call(h, { role: "explorer", task: "看" });
  assert.deepEqual(h.tokens, [7, 7, 7]);
});

test("多份尝试：走并行同任务派发，按验证标签每份一段交回，计入派出个数", async () => {
  const labels: OutcomeLabel[] = ["Passed", "Failed", "Unknown"];
  let requested: { role: string; task: string; count: number } | undefined;
  const h = harness({
    scriptFor: () => ({ behavior: "complete" }),
    maxAgentSpawns: 4,
    spawnAttempts: async (request) => {
      requested = { role: request.role, task: request.task, count: request.count };
      const outcomes: WorkerOutcome[] = labels.map((_, index) => ({
        sessionId: newSessionId() as SessionId,
        name: `implementer-${index + 1}`,
        role: "implementer",
        status: index === 2 ? "turn-limit" : "completed",
        turns: 1,
        result: {
          branch: `pigeon/implementer-${index + 1}`,
          changedFiles: ["a.ts"],
          summary: `第 ${index + 1} 份`,
          summaryTruncated: false,
        },
        workspace: {
          kind: "git-worktree",
          path: `/w/${index + 1}`,
          branch: `pigeon/implementer-${index + 1}`,
        },
      }));
      request.onSpawned(outcomes.map((outcome) => outcome.sessionId));
      return {
        outcomes,
        labels: new Map(
          outcomes.map((outcome, index) => [outcome.sessionId, labels[index] ?? "Unknown"])
        ),
      };
    },
  });
  const text = await call(h, { role: "implementer", task: "修 a", attempts: 3 });
  assert.deepEqual(requested, { role: "implementer", task: "修 a", count: 3 });
  assert.equal(
    text,
    [
      "第 1 份（通过）：worker implementer-1（implementer）已完成。分支：pigeon/implementer-1。改动的文件（1）：a.ts。摘要：第 1 份",
      "第 2 份（未通过）：worker implementer-2（implementer）已完成。分支：pigeon/implementer-2。改动的文件（1）：a.ts。摘要：第 2 份",
      "第 3 份（未知）：worker implementer-3（implementer）撞上轮数上限，没有做完。分支：pigeon/implementer-3。已改动的文件（1）：a.ts。摘要：第 3 份",
    ].join("\n\n")
  );
  assert.equal(h.budget.spawned(), 3);
  // 余量 1，再要 2 份即拒绝
  assert.equal(
    await call(h, { role: "implementer", task: "再修", attempts: 2 }),
    SPAWN_WORKER_TEXTS.spawnLimit(4)
  );
});

test("上限数值可配置：说明里的两个数随配置变化", () => {
  const text = spawnWorkerDescription({ maxConcurrent: 2, maxAgentSpawns: 8 });
  assert.ok(text.includes("同时最多跑 2 个，多的排队；一次运行最多派 8 个。"));
  assert.throws(() => new SpawnWorkerSlot({ maxConcurrent: 0, maxAgentSpawns: 16 }));
});
