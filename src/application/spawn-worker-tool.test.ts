// 派 worker 工具与编排积木工具（决策 264–268、271、294、297、298、300）：定稿文字逐字、派出立即返回、完成通知（不重复）、
// wait_workers 的任一与全部与超时、worker_status / message_worker / stop_worker、同时在跑的上限与排队（人派的一并计算）、
// 不设总数上限（给了上限时满了即拒绝）、多份尝试在后台跑并汇总一条通知。编排器用真实实现，运行面与工作区用内存替身。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { afterAll, test } from "vitest";
import {
  WorkerOrchestrator,
  type WorkerOutcome,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
  type WorkspaceProvider,
} from "../orchestration/workers.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
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
  workerNoticeMarker,
  workerNoticeText,
} from "./spawn-worker-tool.ts";
import { type NoticeTarget, WORKER_NOTICE_PREFIX, WorkerNotices } from "./worker-notices.ts";

// 定稿原文（含 297 起的改写）：缺省设定（同时 8 个、不设总数上限、层数 1）
const FINAL_DESCRIPTION = `Spawn a worker to complete an independent subtask. It returns the worker's name right after spawning, without waiting for it to finish; when the worker finishes, a notice enters your conversation with its branch, the files it changed, and a summary of its work (an explorer returns only the summary).
implementer and tester start from a snapshot of the main working directory at spawn time (including uncommitted changes and new files that are not ignored) and work in their own git worktree and branch; explorer gets no worktree and reads your current workspace directly, read-only, so it sees content that is still changing and may read files that are being modified. No worker can see this session's conversation.
To work in parallel, call this tool several times, one worker per call (you can make several calls in the same reply); at most 8 run at once, and the rest queue. After spawning you can go on with your own work, but do not redo the work you handed off. When you need a result before you can continue, wait with wait_workers; check progress with worker_status, give a running worker more instructions with message_worker, and stop workers you no longer need with stop_worker.
When to spawn: only when the task splits into independent pieces and running them in parallel clearly saves time; 2 to 4 workers is usually enough. Do simple work and tightly sequential work yourself. Every worker has to read the code again, so the more you spawn, the more it costs.
Write the task so it can be completed on its own: state the goal, the relevant files, and the criteria for done. A worker cannot ask you questions, and it cannot spawn workers of its own.
Without tools, the role decides which tools a worker can use: explorer can only read code and search past sessions, suited to investigating and locating things; implementer can read and write files but cannot run commands, suited to changing code by a clear plan; tester can read files and run commands but cannot change files, suited to running and diagnosing tests; all three roles can also use web_search and web_fetch to look things up.
For a different combination, give tools: you can choose only from the tools you can use now (except tools for spawning workers, writing memory, and the task list), and a worker does not have any tool you leave out. You can also narrow a tool with scopes: read_file, edit_file, write_file, grep, glob are limited to the given paths, and run_command can only run single commands that start with a given prefix and do not go through a shell; calls outside the scope are rejected. A worker's commands follow the same approval rules as yours.
A worker's changes are not merged into your branch automatically: after reviewing the returned branch and summary, you decide whether and how to merge them.`;

const FINAL_PARAMS = {
  role: "The worker's role; without tools, it decides which tools the worker can use (see the tool description)",
  task: "The full description of the subtask: goal, relevant files, and criteria for done",
  name: "The worker's name, used in the branch name and status display; generated automatically if omitted",
  attempts:
    "How many copies of the same task to spawn in parallel; if given, each worker does its own copy, and when all are done the changes and summary of each are returned for you to compare",
  label:
    "Optional label that appears as is in this worker's notices and results, to help match it to an item in the task list",
};

const roots: string[] = [];
afterAll(() => {
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
  // 递来的话随即进它的下一轮；不给即在它结束之前都没进对话
  consumesMessages?: boolean;
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

  notify(text: string): string {
    this.notes.push(text);
    return `note-${this.notes.length}`;
  }

  noticeDelivered(): boolean {
    return this.script.consumesMessages === true;
  }

  readonly withdrawn: string[] = [];
  withdrawNotice(key: string): boolean {
    this.withdrawn.push(key);
    return true;
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
      path: join(root, ".pigeon", "state", "worktrees", name),
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
    workspaceRoot: root,
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

test("spawn_worker 的说明与参数说明逐字为定稿原文；执行模式串行", () => {
  const tool = createSpawnWorkerTool(new SpawnWorkerSlot());
  assert.equal(tool.name, "spawn_worker");
  assert.equal(spawnWorkerDescription(DEFAULT_SPAWN_WORKER_SETTINGS), FINAL_DESCRIPTION);
  // 工具上挂的说明即按槽的设置生成的那份（接线）
  assert.equal(tool.description, spawnWorkerDescription(DEFAULT_SPAWN_WORKER_SETTINGS));
  assert.equal(tool.executionMode, "sequential");
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
    "Optional label that appears as is in this worker's notices and results"
  );
});

test("说明随配置变化：同时在跑的上限、给了才出现的总数上限、放开嵌套时写明还能往下派几层", () => {
  const text = spawnWorkerDescription({
    ...DEFAULT_SPAWN_WORKER_SETTINGS,
    maxConcurrent: 2,
    maxAgentSpawns: 5,
  });
  assert.ok(text.includes("at most 2 run at once, and the rest queue"), text);
  assert.ok(text.includes(" At most 5 workers can be spawned per run."), text);
  // 不给总数上限（缺省）时不提这一句
  assert.ok(
    !spawnWorkerDescription(DEFAULT_SPAWN_WORKER_SETTINGS).includes("can be spawned per run")
  );
  const nested = spawnWorkerDescription({ ...DEFAULT_SPAWN_WORKER_SETTINGS, maxDepth: 3 });
  assert.ok(
    nested.includes(
      "A worker cannot ask you questions; it can itself spawn workers up to 2 more levels down."
    ),
    nested
  );
  // 第二层的 worker 再派：新 worker 在第三层，已到底
  const second = spawnWorkerDescription({
    ...DEFAULT_SPAWN_WORKER_SETTINGS,
    maxDepth: 3,
    depth: 2,
  });
  assert.ok(
    second.includes("A worker cannot ask you questions, and it cannot spawn workers of its own."),
    second
  );
  assert.throws(() => new SpawnWorkerSlot({ ...DEFAULT_SPAWN_WORKER_SETTINGS, maxConcurrent: 0 }));
});

test("另外四件工具的说明逐字为定稿原文；wait_workers 的最长等待跟着 worker 的时间上限配置", () => {
  assert.equal(
    waitWorkersDescription(DEFAULT_SPAWN_WORKER_SETTINGS),
    "Wait for workers to finish and return their results. workers gives the names of the workers to wait for; if omitted, waits for all that are still running. With mode any, returns as soon as any one finishes; with all, returns only when all have finished. If they have not finished by timeout_seconds, returns their status at that point, and unfinished workers keep running. Workers that have already finished are returned immediately. Each result states the status (completed, failed, timed out, hit a limit, cancelled, stalled), the error kind, the last output, the changed files, and where the session record is."
  );
  const params = waitWorkersParamsSchema(DEFAULT_SPAWN_WORKER_SETTINGS)
    .properties as unknown as Record<string, { description?: string }>;
  assert.equal(
    params.workers?.description,
    "Names of the workers to wait for; if omitted, all that are still running"
  );
  assert.equal(
    params.mode?.description,
    "any: return as soon as any one finishes; all: return only when all have finished (default)"
  );
  assert.equal(
    params.timeout_seconds?.description,
    "Maximum seconds to wait (default 300, at most 1800)"
  );
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
    "Show worker status: name, role, label, state, and the turns and time used; finished workers include a summary of the result. If workers is omitted, lists all. To wait for results, use wait_workers; do not poll by calling this tool repeatedly."
  );
  assert.equal(
    MESSAGE_WORKER_DESCRIPTION,
    "Send a running worker additional instructions or a correction; it sees them in its next turn. Finished workers cannot receive messages."
  );
  assert.equal(
    STOP_WORKER_DESCRIPTION,
    "Stop a running or queued worker; the changes it has made stay on its branch, and its result is returned as usual."
  );
});

test("固定情形的返回文字逐字为定稿原文", () => {
  assert.equal(
    SPAWN_WORKER_TEXTS.spawned({ name: "w", role: "explorer", branch: "pigeon/w", label: "T1" }),
    "Spawned worker w (explorer) on branch pigeon/w, label T1. You will get a notice when it finishes; when you need its result before you can continue, wait with wait_workers."
  );
  // 决策 377：只读的 explorer 不提分支与改动文件
  assert.equal(
    SPAWN_WORKER_TEXTS.readOnly.spawned({ name: "w", role: "explorer" }),
    "Spawned worker w (explorer); it reads your workspace read-only and has no branch. You will get a notice when it finishes; when you need its result before you can continue, wait with wait_workers."
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.readOnly.awaitingApproval({ name: "w", role: "explorer" }, "读 x", {
      kind: "unattended",
    }),
    "Worker w (explorer) stopped while waiting for approval of: 读 x; an unattended run has nobody to approve. Once a person approves, it can continue."
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.attemptsSpawned(["a-1", "a-2"]),
    "Spawned 2 copies in parallel: a-1, a-2. When all of them finish, one notice will return the changes and summary of each."
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.stalled({ name: "w", role: "tester", branch: "pigeon/w" }, 10),
    "Worker w (tester) stalled: no new model reply or tool result for 10 minutes, so it was interrupted. The branch pigeon/w may have partial changes."
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.awaitingApproval(
      { name: "w", role: "tester", branch: "pigeon/w" },
      "跑命令 npm test",
      { kind: "timeout", minutes: 7 }
    ),
    "Worker w (tester) stopped while waiting for approval of: 跑命令 npm test; nobody approved within 7 minutes. The branch pigeon/w has the work done so far; once a person approves, it can continue."
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.awaitingApproval(
      { name: "w", role: "tester", branch: "pigeon/w" },
      "跑命令 npm test",
      { kind: "unattended" }
    ),
    "Worker w (tester) stopped while waiting for approval of: 跑命令 npm test; an unattended run has nobody to approve. The branch pigeon/w has the work done so far; once a person approves, it can continue."
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.spawnLimit(16),
    "This run has reached the limit of 16 spawned workers. Do not spawn more; use the results you have, or finish the work yourself."
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.budgetExhausted,
    "This run's budget is used up, so no more workers can be spawned; the running workers have been stopped."
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.notGit,
    "The current workspace is not a git repository, so workers cannot be spawned."
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.unknownRole("reviewer"),
    "There is no role reviewer; choose from: explorer, implementer, tester."
  );
  assert.equal(
    SPAWN_WORKER_TEXTS.emptyTask,
    "task cannot be empty: state the goal, the relevant files, and the criteria for done."
  );
});

test("派出立即返回：worker 还在跑时工具已交回名字与分支，不等它做完", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "hang", summary: "好" }) });
  const text = await call(h, { role: "implementer", task: "改 a", name: "fix-a", label: "T1" });
  assert.equal(
    text,
    SPAWN_WORKER_TEXTS.spawned({
      name: "fix-a",
      role: "implementer",
      branch: "pigeon/fix-a",
      label: "T1",
    })
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
  const fixA = h.orchestrator.status().find((worker) => worker.name === "fix-a")?.sessionId;
  const completed = SPAWN_WORKER_TEXTS.completed({
    name: "fix-a",
    role: "implementer",
    branch: "pigeon/fix-a",
    files: ["a.ts", "b.ts"],
    summary: "改好了",
  });
  // 末行为可识别的 worker 会话号（续接时据它判定通知是否已递出）
  assert.equal(
    h.target.queue[0]?.text,
    `${WORKER_NOTICE_PREFIX}Label T1: ${completed}\n${workerNoticeMarker(fixA ?? "")}`
  );
  assert.equal(h.wakes, 1);
  await call(h, { role: "explorer", task: "看看", name: "long" });
  await until(() => h.target.pendingNotices() === 2);
  const id = h.orchestrator.status().find((worker) => worker.name === "long")?.sessionId;
  assert.ok(
    h.target.queue[1]?.text.endsWith(
      ` (summary truncated; the full text is in worker session ${id})\n(worker session ${id})`
    )
  );
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
  await call(turns, { role: "tester", task: "查", name: "w" });
  await until(() => turns.target.pendingNotices() === 1);
  const limitHit = SPAWN_WORKER_TEXTS.limitHit(
    { name: "w", role: "tester", branch: "pigeon/w", files: ["x.ts"], summary: "做了一半" },
    "turn"
  );
  assert.equal(
    turns.target.queue[0]?.text,
    `${WORKER_NOTICE_PREFIX}${limitHit}\n${workerNoticeMarker(turns.orchestrator.status()[0]?.sessionId ?? "")}`
  );
  const clock = harness({ scriptFor: () => ({ behavior: "hang" }), wallClockMs: 20 });
  await call(clock, { role: "tester", task: "跑", name: "t" });
  const timedOut = await wait(clock, { workers: ["t"] });
  assert.ok(
    timedOut.startsWith("Worker t (tester): status timed out; error kind wall-clock-limit."),
    timedOut
  );
  const failed = harness({ scriptFor: () => ({ behavior: "fail" }) });
  await call(failed, { role: "implementer", task: "改", name: "bad" });
  const failedText = await wait(failed, { workers: ["bad"] });
  assert.ok(
    failedText.startsWith("Worker bad (implementer): status failed; error kind run-failed (炸了)."),
    failedText
  );
  assert.ok(failedText.includes("Session record: /virtual/sessions/worker.jsonl"), failedText);
  const cancelled = harness({ scriptFor: () => ({ behavior: "hang" }) });
  await call(cancelled, { role: "implementer", task: "改", name: "slow" });
  assert.equal(
    textOf(await cancelled.stop.execute("s", { worker: "slow" })),
    "Stopped worker slow; the changes it has made stay on its branch, and its result is returned as usual."
  );
  await until(() => cancelled.target.pendingNotices() === 1);
  const cancelledText = SPAWN_WORKER_TEXTS.cancelled({
    name: "slow",
    role: "implementer",
    branch: "pigeon/slow",
  });
  assert.equal(
    cancelled.target.queue[0]?.text,
    `${WORKER_NOTICE_PREFIX}${cancelledText}\n${workerNoticeMarker(cancelled.orchestrator.status()[0]?.sessionId ?? "")}`
  );
  assert.equal(
    textOf(await cancelled.stop.execute("s", { worker: "slow" })),
    "Worker slow has already finished; there is no need to stop it."
  );
});

test("wait_workers：all 等全部、any 等任一、超时交回当时状态且没结束的继续跑", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "hang", summary: "好了" }), files: ["a.ts"] });
  await call(h, { role: "tester", task: "一", name: "one", label: "A" });
  await call(h, { role: "tester", task: "二", name: "two" });
  // 超时：两个都没结束
  const timedOut = await wait(h, { timeout_seconds: 1 });
  assert.ok(timedOut.startsWith("Waited 1 second; some workers have not finished."), timedOut);
  assert.ok(
    timedOut.includes("Worker one (tester) has not finished yet (running, 0 turns, "),
    timedOut
  );
  assert.ok(timedOut.includes("and is still running."), timedOut);
  assert.equal(h.orchestrator.status().filter((worker) => worker.state === "running").length, 2);
  // any：放行 one 即返回 one 的完整结果
  const anyWait = wait(h, { mode: "any" });
  h.runtimes.get("one")?.release();
  const anyText = await anyWait;
  assert.ok(
    anyText.startsWith(
      "Worker one (tester), label A: status completed.\nBranch: pigeon/one. Changed files (1): a.ts.\nLast output: 好了"
    ),
    anyText
  );
  assert.ok(anyText.includes("Worker two (tester) has not finished yet"), anyText);
  // all：放行 two 后返回
  const allWait = wait(h, { workers: ["two"] });
  h.runtimes.get("two")?.release();
  assert.ok((await allWait).startsWith("Worker two (tester): status completed."));
  // 没有要等的
  assert.equal(
    await wait(h, {}),
    "No workers to wait for: all have finished or none have been spawned."
  );
  assert.equal(
    await wait(h, { workers: ["nope"] }),
    "There is no worker named nope; use the name that spawn_worker returned."
  );
});

test("同一结果不出现两遍：等着的 worker 结束不另发通知；已结束未递出的撤回通知；已递出的等待只交回一句", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "hang", summary: "好了" }) });
  await call(h, { role: "explorer", task: "一", name: "awaited" });
  // ① 等待期间结束：不发通知，等待交回完整结果
  const pending = wait(h, { workers: ["awaited"] });
  h.runtimes.get("awaited")?.release();
  assert.ok((await pending).startsWith("Worker awaited (explorer): status completed."));
  assert.equal(h.target.pendingNotices(), 0);
  assert.equal(h.wakes, 0);
  // ② 已结束、通知还没递出：等待撤回通知、交回完整结果
  await call(h, { role: "explorer", task: "二", name: "queued" });
  h.runtimes.get("queued")?.release();
  await until(() => h.target.pendingNotices() === 1);
  assert.ok(
    (await wait(h, { workers: ["queued"] })).startsWith(
      "Worker queued (explorer): status completed."
    )
  );
  assert.equal(h.target.pendingNotices(), 0);
  // ③ 通知已递出：等待照常交回，但只写一句
  await call(h, { role: "explorer", task: "三", name: "told" });
  h.runtimes.get("told")?.release();
  await until(() => h.target.pendingNotices() === 1);
  assert.equal(h.target.deliverAll().length, 1);
  assert.equal(
    await wait(h, { workers: ["told"] }),
    "Worker told (explorer) has finished (completed); see the earlier notice for its result."
  );
});

test("worker_status 与 message_worker：列出状态与标签、已结束的附摘要；递话进在跑 worker 的下一轮，已结束的收不到", async () => {
  const h = harness({
    scriptFor: ({ name }) => ({
      behavior: name === "done" ? "complete" : "hang",
      summary: "结论在此",
      consumesMessages: true,
    }),
  });
  await call(h, { role: "explorer", task: "一", name: "busy", label: "L" });
  await call(h, { role: "explorer", task: "二", name: "done" });
  await until(() => settled(h, "done"));
  const status = textOf(await h.status.execute("st", {}));
  assert.ok(status.includes("busy (explorer), label L: running, 0 turns, "), status);
  assert.ok(status.includes("done (explorer): completed, 1 turn, took "), status);
  assert.ok(status.includes("Result summary: 结论在此"), status);
  assert.equal(
    textOf(await h.message.execute("m", { worker: "busy", message: "顺便看看 b.ts" })),
    "Delivered the message to worker busy; it will see it in its next turn."
  );
  assert.deepEqual(h.runtimes.get("busy")?.notes, [
    "[Message from the agent that spawned you] 顺便看看 b.ts",
  ]);
  assert.equal(
    textOf(await h.message.execute("m", { worker: "done", message: "x" })),
    "Worker done has finished and cannot receive messages."
  );
  h.runtimes.get("busy")?.release();
});

test("派出前的检查：角色写错、task 为空、不是 git 仓库，都按定稿文字回话且不派出", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "complete" }) });
  assert.equal(
    await call(h, { role: "reviewer" as SpawnWorkerParams["role"], task: "看" }),
    SPAWN_WORKER_TEXTS.unknownRole("reviewer")
  );
  assert.equal(await call(h, { role: "explorer", task: "  " }), SPAWN_WORKER_TEXTS.emptyTask);
  const plain = harness({ scriptFor: () => ({ behavior: "complete" }), git: false });
  assert.equal(await call(plain, { role: "explorer", task: "看" }), SPAWN_WORKER_TEXTS.notGit);
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
        "Spawned worker"
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
        "Spawned worker"
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
    assert.ok(
      (await call(h, { role: "explorer", task: `第 ${i} 个` })).startsWith("Spawned worker")
    );
  }
  assert.equal(
    await call(h, { role: "explorer", task: "第 4 个" }),
    SPAWN_WORKER_TEXTS.spawnLimit(3)
  );
  run = "run-2";
  assert.ok((await call(h, { role: "explorer", task: "新一次运行" })).startsWith("Spawned worker"));
  assert.equal(h.budget.spawned(), 1);
});

test("本次运行的额度用完：拒绝再派，交回额度用完的文字", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "complete" }) });
  h.budget.markExhausted();
  assert.equal(await call(h, { role: "explorer", task: "看" }), SPAWN_WORKER_TEXTS.budgetExhausted);
  assert.equal(h.orchestrator.status().length, 0);
});

test("worker 每一轮的 token 回报给额度的持有方", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "endless", tokensPerTurn: 7 }), maxTurns: 3 });
  await call(h, { role: "explorer", task: "看", name: "w" });
  await until(() => settled(h, "w"));
  assert.deepEqual(h.tokens, [7, 7, 7]);
});

test("多份尝试：派出即返回名单，后台跑完交回各份汇总一条通知；已由 wait 交回的一份只写一句", async () => {
  let requested: { role: string; task: string; count: number; label?: string } | undefined;
  const gate = Promise.withResolvers<void>();
  const ids = [1, 2, 3].map(() => newSessionId() as SessionId);
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
      const outcomes: WorkerOutcome[] = ids.map((id, index) => ({
        sessionId: id,
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
        // 决策 322：各份的收尾钩子输出随汇总交回
        ...(index === 0 ? { hookOutputs: ["还差错误路径用例"] } : {}),
        workspace: {
          kind: "git-worktree",
          path: `/w/${index + 1}`,
          branch: `pigeon/implementer-${index + 1}`,
        },
      }));
      return { outcomes };
    },
  });
  const text = await call(h, { role: "implementer", task: "修 a", attempts: 3, label: "T2" });
  assert.deepEqual(requested, { role: "implementer", task: "修 a", count: 3, label: "T2" });
  assert.equal(text, SPAWN_WORKER_TEXTS.attemptsSpawned(ids));
  assert.equal(h.target.pendingNotices(), 0);
  // 第 2 份已由 wait_workers 交回（组内记下）
  h.notices.claim(ids[1] as SessionId);
  gate.resolve();
  await until(() => h.target.pendingNotices() === 1);
  const facts = (index: number) => ({
    name: `implementer-${index}`,
    role: "implementer",
    branch: `pigeon/implementer-${index}`,
    files: ["a.ts"],
    summary: `第 ${index} 份`,
  });
  // 各份按「第 N 份：」起头、空行相隔、各带会话标记；第 2 份只写一句（attemptClaimed 的唯一逐字检查）
  assert.equal(
    h.target.queue[0]?.text,
    WORKER_NOTICE_PREFIX +
      "Label T2: " +
      [
        `${SPAWN_WORKER_TEXTS.attempt(1)}${SPAWN_WORKER_TEXTS.completed(facts(1))}\nHook output:\n  还差错误路径用例\n${workerNoticeMarker(ids[0] as SessionId)}`,
        `Copy 2: The result of worker implementer-2 was already returned by wait_workers.\n${workerNoticeMarker(ids[1] as SessionId)}`,
        `${SPAWN_WORKER_TEXTS.attempt(3)}${SPAWN_WORKER_TEXTS.limitHit(facts(3), "turn")}\n${workerNoticeMarker(ids[2] as SessionId)}`,
      ].join("\n\n")
  );
  assert.equal(h.budget.spawned(), 3);
});

test("message_worker 未送达：worker 在下一轮之前结束（最后一轮之后才递到），如实交回未送达并撤回，不静默丢掉", async () => {
  const h = harness({ scriptFor: () => ({ behavior: "hang", summary: "收尾了" }) });
  await call(h, { role: "explorer", task: "一", name: "closing" });
  const pending = h.message.execute("m", { worker: "closing", message: "再看看 b.ts" });
  // 它没再开下一轮就结束
  h.runtimes.get("closing")?.release();
  const result = await pending;
  assert.equal(
    textOf(result),
    "Not delivered: worker closing has finished or is wrapping up. For this message to take effect, spawn another worker or do it yourself."
  );
  assert.equal(result.details.delivered, false);
  assert.deepEqual(h.runtimes.get("closing")?.withdrawn, ["note-1"]);
});
