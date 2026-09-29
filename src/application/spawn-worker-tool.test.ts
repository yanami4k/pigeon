// 派 worker 工具与编排积木工具（决策 264–268、271、294、297、298、300）：定稿文字逐字、派出立即返回、完成通知（不重复）、
// wait_workers 的任一与全部与超时、worker_status / message_worker / stop_worker、同时在跑的上限与排队（人派的一并计算）、
// 不设总数上限（给了上限时满了即拒绝）、多份尝试在后台跑并汇总一条通知。编排器用真实实现，运行面与工作区用内存替身。
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
  createMessageWorkerTool,
  createStopWorkerTool,
  createWaitWorkersTool,
  createWorkerStatusTool,
  MESSAGE_WORKER_DESCRIPTION,
  STOP_WORKER_DESCRIPTION,
  WORKER_STATUS_DESCRIPTION,
  waitWorkersDescription,
  waitWorkersParamsSchema,
} from "./orchestration-tools.ts";
import {
  createSpawnWorkerTool,
  DEFAULT_SPAWN_WORKER_SETTINGS,
  SPAWN_WORKER_TEXTS,
  SpawnWorkerBudget,
  type SpawnWorkerHost,
  type SpawnWorkerParams,
  type SpawnWorkerSettings,
  SpawnWorkerSlot,
  spawnWorkerDescription,
  spawnWorkerParamsSchema,
  workerNoticeText,
} from "./spawn-worker-tool.ts";
import { type NoticeTarget, WORKER_NOTICE_PREFIX, WorkerNotices } from "./worker-notices.ts";

// 定稿原文（含 297 起的改写）：缺省设定（同时 8 个、不设总数上限、层数 1）
const FINAL_DESCRIPTION = `派一个 worker 去完成一项独立的子任务。派出后立即返回它的名字，不等它做完；它结束时会有一条通知进入你的对话，交回它的分支、改动过的文件与工作摘要。
worker 从派出时主工作目录的快照开工（含未提交的改动与未被忽略的新文件），在自己的 git 工作树与分支里干活；看不到本会话的对话。
要并行，就多次调用本工具，每次派一个（可在同一次回复里连续调用）；同时最多跑 8 个，多的排队。派出后可以接着做自己的事，但不要把派出去的活自己再做一遍。需要结果才能往下做时用 wait_workers 等；worker_status 查看进度，message_worker 给在跑的 worker 补充说明，stop_worker 停掉不再需要的。
何时派：任务能拆成互不依赖的几块、并行能明显省时间时才派，通常 2 到 4 个就够；简单的活、前后依赖紧的活自己做。每个 worker 都要重新读代码，派得越多花得越多。
任务要写得能独立完成：目标、相关文件、完成的标准都写清楚。worker 不能向你提问，也不能再派 worker。
角色决定 worker 能用的工具：explorer 只能读代码与检索历史会话，适合调查与定位；implementer 能读写文件、不能跑命令，适合按明确的方案改代码；tester 能读文件与跑命令、不能改文件，适合运行与诊断测试。三种角色另外都能用 web_search 与 web_fetch 查资料。
worker 的改动不会自动并入你的分支：看过交回的分支与摘要后，由你决定合不合、怎么合。`;

const FINAL_PARAMS = {
  role: "worker 的角色，决定它能用的工具，见工具说明",
  task: "子任务的完整说明：目标、相关文件、完成的标准",
  name: "worker 的名字，用于分支名与状态显示；不给即自动生成",
  attempts:
    "同一任务并行派出的份数；给了即各做一份，做完后按验证命令给每份标上通过、未通过或未知，全部交回",
  label: "可选的标签，原样出现在这个 worker 的通知与结果里，便于对应任务清单里的项",
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
  readonly notes: string[] = [];
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

  notify(text: string): void {
    this.notes.push(text);
  }

  async transcript(): Promise<string> {
    return "/virtual/sessions/worker.jsonl";
  }

  summary(): string {
    return this.script.summary ?? "";
  }

  async dispose(): Promise<void> {}
}

// 通知的去处替身：记下递来的通知；delivered 之前可撤回
class FakeTarget implements NoticeTarget {
  readonly queue: Array<{ key: string; text: string }> = [];
  readonly delivered: string[] = [];
  #seq = 0;

  notify(text: string): string {
    this.#seq += 1;
    const key = `k${this.#seq}`;
    this.queue.push({ key, text });
    return key;
  }

  withdrawNotice(key: string): boolean {
    const index = this.queue.findIndex((entry) => entry.key === key);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  noticeDelivered(key: string): boolean {
    return this.delivered.includes(key);
  }

  pendingNotices(): number {
    return this.queue.length;
  }

  // 模拟进下一轮：待递的都递出
  deliverAll(): string[] {
    const texts = this.queue.map((entry) => entry.text);
    this.delivered.push(...this.queue.map((entry) => entry.key));
    this.queue.length = 0;
    return texts;
  }
}

interface Harness {
  orchestrator: WorkerOrchestrator;
  runtimes: Map<string, FakeRuntime>;
  budget: SpawnWorkerBudget;
  host: SpawnWorkerHost;
  target: FakeTarget;
  notices: WorkerNotices;
  settings: SpawnWorkerSettings;
  tool: ReturnType<typeof createSpawnWorkerTool>;
  wait: ReturnType<typeof createWaitWorkersTool>;
  status: ReturnType<typeof createWorkerStatusTool>;
  message: ReturnType<typeof createMessageWorkerTool>;
  stop: ReturnType<typeof createStopWorkerTool>;
  tokens: number[];
  wakes: number;
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
  const sessionId = newSessionId();
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: root,
    session: { sessionId },
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
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
    onWorkerTokens: (_id, count) => {
      tokens.push(count);
    },
    defaultLimits: {
      maxTurns: options.maxTurns ?? 40,
      wallClockMs: options.wallClockMs ?? 60_000,
    },
  });
  const settings: SpawnWorkerSettings = {
    ...DEFAULT_SPAWN_WORKER_SETTINGS,
    ...(options.maxAgentSpawns !== undefined ? { maxAgentSpawns: options.maxAgentSpawns } : {}),
  };
  const budget = new SpawnWorkerBudget({
    ...(options.maxAgentSpawns !== undefined ? { maxAgentSpawns: options.maxAgentSpawns } : {}),
    ...(options.runKey !== undefined ? { runKey: options.runKey } : {}),
  });
  const target = new FakeTarget();
  const counter = { wakes: 0 };
  const notices = new WorkerNotices({
    orchestrator,
    parentSessionId: sessionId,
    target,
    text: (outcome) => workerNoticeText(outcome, budget.exhausted, settings),
    wake: () => {
      counter.wakes += 1;
    },
  });
  const host: SpawnWorkerHost = {
    orchestrator,
    governanceRoot: root,
    budget,
    notices,
    spawnAttempts:
      options.spawnAttempts ??
      (async () => {
        throw new Error("本用例不派多份尝试");
      }),
  };
  const slot = new SpawnWorkerSlot(settings);
  slot.bind(host);
  const h = {
    orchestrator,
    runtimes,
    budget,
    host,
    target,
    notices,
    settings,
    tool: createSpawnWorkerTool(slot),
    wait: createWaitWorkersTool(slot),
    status: createWorkerStatusTool(slot),
    message: createMessageWorkerTool(slot),
    stop: createStopWorkerTool(slot),
    tokens,
    get wakes() {
      return counter.wakes;
    },
  };
  return h;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === "text");
  return block.text ?? "";
}

async function call(h: Harness, params: SpawnWorkerParams): Promise<string> {
  return textOf(await h.tool.execute("call", params));
}

async function wait(
  h: Harness,
  params: { workers?: string[]; mode?: "any" | "all"; timeout_seconds?: number }
): Promise<string> {
  return textOf(await h.wait.execute("wait", params));
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 4000 && !check(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(check(), "等待的条件没有成立");
}

const settled = (h: Harness, name: string) =>
  h.orchestrator.status().find((worker) => worker.name === name)?.outcome !== undefined;

test("spawn_worker 的说明与参数说明逐字为定稿原文；执行模式可并行", () => {
  const tool = createSpawnWorkerTool(new SpawnWorkerSlot());
  assert.equal(tool.name, "spawn_worker");
  assert.equal(tool.description, FINAL_DESCRIPTION);
  assert.equal(spawnWorkerDescription(DEFAULT_SPAWN_WORKER_SETTINGS), FINAL_DESCRIPTION);
  assert.equal(tool.executionMode, "parallel");
  const schema = spawnWorkerParamsSchema(true);
  const properties = schema.properties;
  for (const [key, description] of Object.entries(FINAL_PARAMS)) {
    assert.equal(
      (properties[key as keyof typeof properties] as { description?: string }).description,
      description,
      key
    );
  }
  assert.deepEqual([...schema.required].sort(), ["role", "task"]);
  const check = Compile(schema);
  for (const role of ["explorer", "implementer", "tester"]) {
    assert.equal(check.Check({ role, task: "看" }), true, role);
  }
  assert.equal(check.Check({ role: "reviewer", task: "看" }), false);
  const attempts = properties.attempts as unknown as { minimum?: number; maximum?: number };
  assert.equal(attempts.minimum, 2);
  assert.equal(attempts.maximum, 4);
  // 任务清单关着时 label 的说明不提清单
  assert.equal(
    (spawnWorkerParamsSchema(false).properties.label as { description?: string }).description,
    "可选的标签，原样出现在这个 worker 的通知与结果里"
  );
});

test("说明随配置变化：同时在跑的上限、给了才出现的总数上限、放开嵌套时写明还能往下派几层", () => {
  const text = spawnWorkerDescription({
    ...DEFAULT_SPAWN_WORKER_SETTINGS,
    maxConcurrent: 2,
    maxAgentSpawns: 5,
  });
  assert.ok(
    text.includes(
      "同时最多跑 2 个，多的排队。派出后可以接着做自己的事，但不要把派出去的活自己再做一遍。需要结果才能往下做时用 wait_workers 等；worker_status 查看进度，message_worker 给在跑的 worker 补充说明，stop_worker 停掉不再需要的。一次运行最多派 5 个。"
    ),
    text
  );
  const nested = spawnWorkerDescription({ ...DEFAULT_SPAWN_WORKER_SETTINGS, maxDepth: 3 });
  assert.ok(nested.includes("worker 不能向你提问；它还能往下再派 2 层 worker。"), nested);
  // 第二层的 worker 再派：新 worker 在第三层，已到底
  const second = spawnWorkerDescription({
    ...DEFAULT_SPAWN_WORKER_SETTINGS,
    maxDepth: 3,
    depth: 2,
  });
  assert.ok(second.includes("worker 不能向你提问，也不能再派 worker。"), second);
  assert.throws(() => new SpawnWorkerSlot({ ...DEFAULT_SPAWN_WORKER_SETTINGS, maxConcurrent: 0 }));
});

test("另外四件工具的说明逐字为定稿原文；wait_workers 的最长等待跟着 worker 的时间上限配置", () => {
  assert.equal(
    waitWorkersDescription(DEFAULT_SPAWN_WORKER_SETTINGS),
    "等 worker 结束并交回结果。workers 给出要等的 worker 名字，不给即等所有还在跑的；mode 为 any 时任一个结束就返回，为 all 时全部结束才返回；到 timeout_seconds 仍未结束即返回当时的状态，没结束的 worker 继续跑。已经结束的 worker 立即交回。每个结果写明状态（完成、失败、超时、撞上限、取消、卡住）、错误类型、最后一段输出、改动的文件与会话记录位置。"
  );
  const params = waitWorkersParamsSchema(DEFAULT_SPAWN_WORKER_SETTINGS)
    .properties as unknown as Record<string, { description?: string }>;
  assert.equal(params.workers?.description, "要等的 worker 名字；不给即所有还在跑的");
  assert.equal(params.mode?.description, "any：任一个结束即返回；all：全部结束才返回（缺省）");
  assert.equal(params.timeout_seconds?.description, "最多等多少秒（缺省 300，最多 1800）");
  assert.equal(
    (
      waitWorkersParamsSchema({ workerWallClockMs: 600_000 }).properties.timeout_seconds as {
        maximum?: number;
      }
    ).maximum,
    600
  );
  assert.equal(
    WORKER_STATUS_DESCRIPTION,
    "查看 worker 的状态：名字、角色、标签、状态、已用轮数与时间；已结束的附结果摘要。workers 不给即列出全部。要等结果用 wait_workers，不要反复调用本工具轮询。"
  );
  assert.equal(
    MESSAGE_WORKER_DESCRIPTION,
    "给一个还在跑的 worker 发一段补充说明或更正，它在下一轮看到。已结束的 worker 收不到。"
  );
  assert.equal(
    STOP_WORKER_DESCRIPTION,
    "停掉一个还在跑或排队的 worker；它已做的改动留在分支上，结果照常交回。"
  );
});

test("固定情形的返回文字逐字为定稿原文", () => {
  assert.equal(
    SPAWN_WORKER_TEXTS.spawned({ name: "w", role: "explorer", branch: "pigeon/w", label: "T1" }),
    "已派出 worker w（explorer），分支 pigeon/w，标签 T1。它结束时会有通知；需要结果才能往下做时用 wait_workers 等。"
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.attemptsSpawned(["a-1", "a-2"]),
    "已并行派出 2 份：a-1、a-2。全部结束并验证后会有一条通知，给出每份的验证标签。"
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.stalled({ name: "w", role: "tester", branch: "pigeon/w" }, 10),
    "worker w（tester）卡住：10 分钟没有新的模型回复或工具结果，已中断。分支 pigeon/w 上可能有部分改动。"
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.awaitingApproval(
      { name: "w", role: "tester", branch: "pigeon/w" },
      "跑命令 npm test",
      { kind: "timeout", minutes: 7 }
    ),
    "worker w（tester）停在等审批：要跑命令 npm test，7 分钟内无人批准。分支 pigeon/w 上有已做的部分；人补批后它可以接着做。"
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.awaitingApproval(
      { name: "w", role: "tester", branch: "pigeon/w" },
      "跑命令 npm test",
      { kind: "unattended" }
    ),
    "worker w（tester）停在等审批：要跑命令 npm test，无人值守运行没有人审批。分支 pigeon/w 上有已做的部分；人补批后它可以接着做。"
  );
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

test("派出立即返回：worker 还在跑时工具已交回名字与分支，不等它做完", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "hang", summary: "好" }) });
  const text = await call(h, { role: "implementer", task: "改 a", name: "fix-a", label: "T1" });
  assert.equal(
    text,
    "已派出 worker fix-a（implementer），分支 pigeon/fix-a，标签 T1。它结束时会有通知；需要结果才能往下做时用 wait_workers 等。"
  );
  assert.equal(h.orchestrator.status()[0]?.state, "running");
  assert.equal(h.target.pendingNotices(), 0);
  h.runtimes.get("fix-a")?.release();
  await until(() => settled(h, "fix-a"));
});

test("完成通知：worker 结束时一条带标签的通知递给派出方并叫醒它；摘要截断时补上会话号", async () => {
  const h = harness({
    scriptFor: ({ name }) => ({
      behavior: "complete",
      summary: name === "long" ? "长".repeat(2100) : "改好了",
    }),
    files: ["a.ts", "b.ts"],
  });
  await call(h, { role: "implementer", task: "改 a", name: "fix-a", label: "T1" });
  await until(() => h.target.pendingNotices() === 1);
  assert.equal(
    h.target.queue[0]?.text,
    `${WORKER_NOTICE_PREFIX}标签 T1：worker fix-a（implementer）已完成。分支：pigeon/fix-a。改动的文件（2）：a.ts、b.ts。摘要：改好了`
  );
  assert.equal(h.wakes, 1);
  await call(h, { role: "explorer", task: "看看", name: "long" });
  await until(() => h.target.pendingNotices() === 2);
  const id = h.orchestrator.status().find((worker) => worker.name === "long")?.sessionId;
  assert.ok(h.target.queue[1]?.text.endsWith(`（摘要已截断，全文在 worker 会话 ${id} 里）`));
  // 人派的（human）与程序派的（program）不发通知
  h.orchestrator.spawn({ role: "explorer", task: "人派", name: "by-human", origin: "human" });
  h.orchestrator.spawn({ role: "explorer", task: "程序派", name: "by-program" });
  await until(() => settled(h, "by-human") && settled(h, "by-program"));
  assert.equal(h.target.pendingNotices(), 2);
});

test("各种结束状态：撞上限、超时、失败、取消各有通知；结构化结果的状态为 298 的六种说法", async () => {
  const turns = harness({
    scriptFor: () => ({ behavior: "endless", summary: "做了一半" }),
    files: ["x.ts"],
    maxTurns: 3,
  });
  await call(turns, { role: "explorer", task: "查", name: "w" });
  await until(() => turns.target.pendingNotices() === 1);
  assert.equal(
    turns.target.queue[0]?.text,
    `${WORKER_NOTICE_PREFIX}worker w（explorer）撞上轮数上限，没有做完。分支：pigeon/w。已改动的文件（1）：x.ts。摘要：做了一半`
  );
  const clock = harness({ scriptFor: () => ({ behavior: "hang" }), wallClockMs: 20 });
  await call(clock, { role: "tester", task: "跑", name: "t" });
  const timedOut = await wait(clock, { workers: ["t"] });
  assert.ok(
    timedOut.startsWith("worker t（tester）：状态 超时；错误类型 wall-clock-limit。"),
    timedOut
  );
  const failed = harness({ scriptFor: () => ({ behavior: "fail" }) });
  await call(failed, { role: "implementer", task: "改", name: "bad" });
  const failedText = await wait(failed, { workers: ["bad"] });
  assert.ok(
    failedText.startsWith("worker bad（implementer）：状态 失败；错误类型 run-failed（炸了）。"),
    failedText
  );
  assert.ok(failedText.includes("会话记录：/virtual/sessions/worker.jsonl"), failedText);
  const cancelled = harness({ scriptFor: () => ({ behavior: "hang" }) });
  await call(cancelled, { role: "implementer", task: "改", name: "slow" });
  assert.equal(
    textOf(await cancelled.stop.execute("s", { worker: "slow" })),
    "已停掉 worker slow；它已做的改动留在分支上，结果照常交回。"
  );
  await until(() => cancelled.target.pendingNotices() === 1);
  assert.equal(
    cancelled.target.queue[0]?.text,
    `${WORKER_NOTICE_PREFIX}worker slow（implementer）被取消。分支 pigeon/slow 上可能有部分改动。`
  );
  assert.equal(
    textOf(await cancelled.stop.execute("s", { worker: "slow" })),
    "worker slow 已结束，不需要停。"
  );
});

test("wait_workers：all 等全部、any 等任一、超时交回当时状态且没结束的继续跑", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "hang", summary: "好了" }), files: ["a.ts"] });
  await call(h, { role: "explorer", task: "一", name: "one", label: "A" });
  await call(h, { role: "explorer", task: "二", name: "two" });
  // 超时：两个都没结束
  const timedOut = await wait(h, { timeout_seconds: 1 });
  assert.ok(timedOut.startsWith("等了 1 秒，仍有 worker 没结束。"), timedOut);
  assert.ok(timedOut.includes("worker one（explorer）还没结束（进行中，0 轮，"), timedOut);
  assert.ok(timedOut.includes("继续在跑。"), timedOut);
  assert.equal(h.orchestrator.status().filter((worker) => worker.state === "running").length, 2);
  // any：放行 one 即返回 one 的完整结果
  const anyWait = wait(h, { mode: "any" });
  h.runtimes.get("one")?.release();
  const anyText = await anyWait;
  assert.ok(
    anyText.startsWith(
      "worker one（explorer），标签 A：状态 完成。\n分支：pigeon/one。改动的文件（1）：a.ts。\n最后一段输出：好了"
    ),
    anyText
  );
  assert.ok(anyText.includes("worker two（explorer）还没结束"), anyText);
  // all：放行 two 后返回
  const allWait = wait(h, { workers: ["two"] });
  h.runtimes.get("two")?.release();
  assert.ok((await allWait).startsWith("worker two（explorer）：状态 完成。"));
  // 没有要等的
  assert.equal(await wait(h, {}), "没有要等的 worker：都已结束或还没派出。");
  assert.equal(
    await wait(h, { workers: ["nope"] }),
    "没有名为 nope 的 worker；用 spawn_worker 交回的名字。"
  );
});

test("同一结果不出现两遍：等着的 worker 结束不另发通知；已结束未递出的撤回通知；已递出的等待只交回一句", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "hang", summary: "好了" }) });
  await call(h, { role: "explorer", task: "一", name: "awaited" });
  // ① 等待期间结束：不发通知，等待交回完整结果
  const pending = wait(h, { workers: ["awaited"] });
  h.runtimes.get("awaited")?.release();
  assert.ok((await pending).startsWith("worker awaited（explorer）：状态 完成。"));
  assert.equal(h.target.pendingNotices(), 0);
  assert.equal(h.wakes, 0);
  // ② 已结束、通知还没递出：等待撤回通知、交回完整结果
  await call(h, { role: "explorer", task: "二", name: "queued" });
  h.runtimes.get("queued")?.release();
  await until(() => h.target.pendingNotices() === 1);
  assert.ok(
    (await wait(h, { workers: ["queued"] })).startsWith("worker queued（explorer）：状态 完成。")
  );
  assert.equal(h.target.pendingNotices(), 0);
  // ③ 通知已递出：等待照常交回，但只写一句
  await call(h, { role: "explorer", task: "三", name: "told" });
  h.runtimes.get("told")?.release();
  await until(() => h.target.pendingNotices() === 1);
  assert.equal(h.target.deliverAll().length, 1);
  assert.equal(
    await wait(h, { workers: ["told"] }),
    "worker told（explorer）已结束（完成），结果见此前的通知。"
  );
});

test("worker_status 与 message_worker：列出状态与标签、已结束的附摘要；递话进在跑 worker 的下一轮，已结束的收不到", async () => {
  const h = harness({
    scriptFor: ({ name }) => ({
      behavior: name === "done" ? "complete" : "hang",
      summary: "结论在此",
    }),
  });
  await call(h, { role: "explorer", task: "一", name: "busy", label: "L" });
  await call(h, { role: "explorer", task: "二", name: "done" });
  await until(() => settled(h, "done"));
  const status = textOf(await h.status.execute("st", {}));
  assert.ok(status.includes("busy（explorer），标签 L：进行中，0 轮，已用 "), status);
  assert.ok(status.includes("done（explorer）：完成，1 轮，用时 "), status);
  assert.ok(status.includes("结果摘要：结论在此"), status);
  assert.equal(
    textOf(await h.message.execute("m", { worker: "busy", message: "顺便看看 b.ts" })),
    "已把话递给 worker busy，它在下一轮看到。"
  );
  assert.deepEqual(h.runtimes.get("busy")?.notes, ["[来自派出方的消息] 顺便看看 b.ts"]);
  assert.equal(
    textOf(await h.message.execute("m", { worker: "done", message: "x" })),
    "worker done 已结束，收不到消息。"
  );
  h.runtimes.get("busy")?.release();
});

test("派出前的检查：角色写错、task 为空、不是 git 仓库，都按定稿文字回话且不派出", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "complete" }) });
  assert.equal(
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

test("同时在跑缺省 8 个：多派的排队不拒绝，人派的一并计算；不设总数上限", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "hang", summary: "好" }) });
  assert.equal(h.orchestrator.maxConcurrent, 8);
  h.orchestrator.spawn({ role: "explorer", task: "人派", name: "human-1", origin: "human" });
  h.orchestrator.spawn({ role: "explorer", task: "人派", name: "human-2", origin: "human" });
  for (let i = 1; i <= 8; i += 1) {
    assert.ok(
      (await call(h, { role: "explorer", task: `agent ${i}`, name: `agent-${i}` })).startsWith(
        "已派出"
      )
    );
  }
  const states = () =>
    Object.fromEntries(h.orchestrator.status().map((worker) => [worker.name, worker.state]));
  assert.equal(h.orchestrator.status().filter((worker) => worker.state === "running").length, 8);
  assert.equal(states()["agent-7"], "queued");
  assert.equal(states()["agent-8"], "queued");
  assert.equal(h.runtimes.get("agent-7")?.started, false);
  h.runtimes.get("human-1")?.release();
  await until(() => states()["agent-7"] === "running");
  assert.equal(states()["agent-8"], "queued");
  // 不设总数上限：一次运行里再派 30 个都照收
  for (let i = 9; i <= 38; i += 1) {
    assert.ok(
      (await call(h, { role: "explorer", task: `agent ${i}`, name: `agent-${i}` })).startsWith(
        "已派出"
      )
    );
  }
  assert.equal(h.budget.spawned(), 38);
  for (const runtime of h.runtimes.values()) runtime.release();
  await until(() =>
    h.orchestrator
      .status()
      .every((worker) => worker.outcome !== undefined || worker.state === "queued")
  );
  for (let round = 0; round < 10; round += 1) {
    for (const runtime of h.runtimes.values()) runtime.release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await until(() => h.orchestrator.status().every((worker) => worker.outcome !== undefined));
});

test("给了总数上限（--worker-limit）：满了按定稿文字拒绝；人派的不计入；换一次运行重新计", async () => {
  let run = "run-1";
  const h = harness({
    scriptFor: () => ({ behavior: "complete" }),
    runKey: () => run,
    maxAgentSpawns: 3,
  });
  h.orchestrator.spawn({ role: "explorer", task: "人派", name: "human-1", origin: "human" });
  for (let i = 1; i <= 3; i += 1) {
    assert.ok((await call(h, { role: "explorer", task: `第 ${i} 个` })).startsWith("已派出"));
  }
  assert.equal(
    await call(h, { role: "explorer", task: "第 4 个" }),
    "本次运行派出的 worker 已达 3 个上限。不要再派；用已有的结果，或自己完成。"
  );
  run = "run-2";
  assert.ok((await call(h, { role: "explorer", task: "新一次运行" })).startsWith("已派出"));
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
  await call(h, { role: "explorer", task: "看", name: "w" });
  await until(() => settled(h, "w"));
  assert.deepEqual(h.tokens, [7, 7, 7]);
});

test("多份尝试：派出即返回名单，后台跑完按验证标签汇总一条通知；已由 wait 交回的一份只写一句", async () => {
  const labels: OutcomeLabel[] = ["Passed", "Failed", "Unknown"];
  let requested: { role: string; task: string; count: number; label?: string } | undefined;
  const gate = Promise.withResolvers<void>();
  const ids = labels.map(() => newSessionId() as SessionId);
  const h = harness({
    scriptFor: () => ({ behavior: "complete" }),
    spawnAttempts: async (request) => {
      requested = {
        role: request.role,
        task: request.task,
        count: request.count,
        ...(request.label !== undefined ? { label: request.label } : {}),
      };
      request.onSpawned(ids);
      await gate.promise;
      const outcomes: WorkerOutcome[] = labels.map((_, index) => ({
        sessionId: ids[index] as SessionId,
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
      return {
        outcomes,
        labels: new Map(
          outcomes.map((outcome, index) => [outcome.sessionId, labels[index] ?? "Unknown"])
        ),
      };
    },
  });
  const text = await call(h, { role: "implementer", task: "修 a", attempts: 3, label: "T2" });
  assert.deepEqual(requested, { role: "implementer", task: "修 a", count: 3, label: "T2" });
  assert.equal(
    text,
    `已并行派出 3 份：${ids.join("、")}。全部结束并验证后会有一条通知，给出每份的验证标签。`
  );
  assert.equal(h.target.pendingNotices(), 0);
  // 第 2 份已由 wait_workers 交回（组内记下）
  h.notices.claim(ids[1] as SessionId);
  gate.resolve();
  await until(() => h.target.pendingNotices() === 1);
  assert.equal(
    h.target.queue[0]?.text,
    WORKER_NOTICE_PREFIX +
      "标签 T2：" +
      [
        "第 1 份（通过）：worker implementer-1（implementer）已完成。分支：pigeon/implementer-1。改动的文件（1）：a.ts。摘要：第 1 份",
        "第 2 份（未通过）：worker implementer-2 的结果已由 wait_workers 交回。",
        "第 3 份（未知）：worker implementer-3（implementer）撞上轮数上限，没有做完。分支：pigeon/implementer-3。已改动的文件（1）：a.ts。摘要：第 3 份",
      ].join("\n\n")
  );
  assert.equal(h.budget.spawned(), 3);
});
