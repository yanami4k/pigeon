// 脚本编排的运行器（决策 294 D、309–314）：一次脚本运行在专用容器里执行脚本（execution/script-sandbox.ts），脚本经积木发来的
// agent 调用在这里接住，交给会话编排器派出普通 worker（打转检测等照常作用于它们），等它结束后把结果交回脚本。
// - 起点（311）：本次脚本开跑时给主工作目录拍一张快照，整次脚本共用，引用保留到本次脚本收回或放弃为止；接力的调用以上游 worker
//   的工作树开工。脚本运行期间不写主工作目录；脚本结束时按脚本交回的清单依次三方叠加收回，整批请示一次。
// - 指纹与续跑（312）：每个调用算一份指纹（script-fingerprint.ts），记在派出与收尾条目上；续跑时从头重执行脚本，指纹对得上且
//   上次已做完的直接复用结果与分支（接力的还要上游是同一个 worker），其余重派；续跑沿用该次开跑时的快照。
// - 失败（313）：agent 总是返回结果；结构化输出不合格式时让该 worker 在原会话改正，至多两次；框架不自动重试。
// - 花费上限（314）：与状态栏同一算法按轮累计本次脚本派出的 worker 的用量；到上限即不再派新的，在跑的做完，脚本以"额度用完"
//   结束；续跑时额度累计此前各次的花费。pigeon run 的总额度照常计入（worker 用的 token 经编排器回报，与脚本无关）。
// - 进度（300、301）：开跑一行计划、log 行进消息区；树形视图取脚本与阶段两层；可停止整个脚本。

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { ScriptLauncher, ScriptProcess } from "../execution/script-sandbox.ts";
import type { OverlayResult } from "../execution/worker-overlay.ts";
import { isWorkerRole, WORKER_ROLES } from "../orchestration/roles.ts";
import { ScriptFingerprints } from "../orchestration/script-fingerprint.ts";
import type {
  WorkerActivity,
  WorkerOrchestrator,
  WorkerOutcome,
  WorkerStartPoint,
} from "../orchestration/workers.ts";
import type { SessionId } from "../state/ids.ts";
import { checkJsonSchema } from "../state/json-schema-check.ts";
import type { ChildSettledStatus, WorkerRole } from "../state/session-payloads.ts";
import type { ScriptKindRegistry } from "./script-approvals.ts";
import { budgetText, type ScriptBudget } from "./script-naming.ts";
import {
  logLine,
  planLine,
  SCRIPT_BUDGET_NO_PRICE,
  SCRIPT_NOTICE_PREFIX,
  type ScriptEnding,
  type SummaryInput,
  schemaAppendix,
  schemaCorrection,
  summaryText,
} from "./script-texts.ts";
import { addUsage, type CostTally, emptyCostTally, type UsageLike } from "./session-cost.ts";

// 结构化输出不合格式时的改正次数上限
export const SCRIPT_OUTPUT_CORRECTIONS = 2;
// 停止整个脚本后，等脚本自己结束的宽限；过了即删掉容器
export const SCRIPT_STOP_GRACE_MS = 10_000;
// 脚本卡住的判定：本次脚本没有 worker 在跑或排队、脚本又没结束，持续这么久即停掉容器（缺省 10 分钟，项目配置可改）
export const SCRIPT_STALL_MS = 10 * 60_000;

// 模型没有价格却给了金额额度：开跑即拒绝（token 额度照常可用）
export class ScriptBudgetError extends Error {}

// 模型的计价口径：usd 为回复自带价格，cny 为 DeepSeek 官方人民币价目，none 为没有价格；undefined 为还看不出来
export type ScriptPricing = "usd" | "cny" | "none" | undefined;

export interface ScriptSpec {
  name: string;
  phases: string[];
  script: string;
  args?: unknown;
}

// 本次脚本共用的主目录快照（引用保留到收回或放弃）
export interface ScriptSnapshot extends WorkerStartPoint {
  ref: string;
}

// 一个调用的记录（本次执行的，或续跑前各次的）：续跑按指纹找它
export interface ScriptCallRecord {
  fingerprint: string;
  sessionId: SessionId;
  name: string;
  worktree: string;
  branch: string;
  base: string;
  relayFrom?: SessionId;
  status: ChildSettledStatus;
  errorKind?: string;
  error?: string;
  // 停在等审批（可补批后续跑）
  blockedAction?: string;
  summary: string;
  changedFiles: string[];
  structured?: unknown;
}

// 交回脚本的结果
export interface ScriptAgentResult {
  ok: boolean;
  status: string;
  ref: string;
  name?: string;
  label?: string;
  phase?: string;
  branch?: string;
  files?: string[];
  summary?: string;
  output?: unknown;
  error?: string;
  errorKind?: string;
  reused?: boolean;
}

// 重启后从会话里找回的一次脚本运行
export interface RestoredScriptRun {
  spec: ScriptSpec;
  budget?: ScriptBudget;
  records: ScriptCallRecord[];
  // 派出过的全部 worker 名（含中途断掉、没有收尾的）：新派的名字从其后排，不撞旧分支
  names: string[];
  spent: CostTally;
}

export interface CollectTarget {
  name: string;
  worktree: string;
  base: string;
}

export interface ScriptRunnerDeps {
  orchestrator: Pick<
    WorkerOrchestrator,
    "spawn" | "awaitResult" | "cancel" | "resume" | "observe" | "status"
  >;
  // 容器（Docker 不可用即抛错）
  launcher: () => Promise<ScriptLauncher>;
  // 拍本次脚本的主目录快照并挂上引用（不是 git 仓库即抛错）；读回与放弃
  snapshot: (runId: string) => ScriptSnapshot;
  readSnapshot: (runId: string) => ScriptSnapshot | undefined;
  releaseSnapshot: (runId: string) => void;
  // 把一个 worker 自己的改动三方叠进主工作目录
  overlay: (target: CollectTarget) => OverlayResult;
  // 整批收回的请示：放手模式或已放权时直接批
  approveCollect: (input: {
    runId: string;
    title: string;
    workers: string[];
    // 决策 340：各 worker 的叠回目标（据此判定叠回内容是否写到受保护路径 .pigeon）
    targets?: readonly CollectTarget[];
  }) => Promise<boolean>;
  // 重启后按运行号从会话里找回（只限本会话）
  restore?: (runId: string) => Promise<RestoredScriptRun | undefined>;
  // 脚本开跑时登记一条待发的汇总（pigeon run 据此等它），返回发出的函数
  announce: () => (text: string) => void;
  // 消息区的一行（计划行、log 行）
  emit?: (line: string) => void;
  // 树形视图刷新
  onChange?: () => void;
  // 主会话的模型接入（计价口径同状态栏）
  provider?: string;
  // pigeon run 的总额度已用完（不再派）
  hostExhausted?: () => boolean;
  newRunId?: () => string;
  stopGraceMs?: number;
  // 模型的计价口径（金额额度开跑前核对）；不给即不核对
  pricing?: () => ScriptPricing;
  // 脚本卡住的判定时长（缺省 SCRIPT_STALL_MS）
  stallMs?: number;
}

type NotStarted = "budget" | "stopped";

interface CallState {
  fingerprint: string;
  task: string;
  role: WorkerRole;
  label?: string;
  phase?: string;
  schema?: unknown;
  reused: boolean;
  running: boolean;
  sessionId?: SessionId;
  record?: ScriptCallRecord;
  result?: ScriptAgentResult;
  notStarted?: NotStarted;
}

interface ScriptRun {
  runId: string;
  spec: ScriptSpec;
  budget?: ScriptBudget;
  snapshot: ScriptSnapshot;
  running: boolean;
  ending?: ScriptEnding;
  history: Map<string, ScriptCallRecord>;
  // 本次执行
  calls: Map<string, CallState>;
  fingerprints: ScriptFingerprints;
  phaseOrder: string[];
  phaseWorkers: Map<string, SessionId[]>;
  spent: CostTally;
  exhausted: boolean;
  stopped: boolean;
  // 卡住监控停掉的
  stalled: boolean;
  allowedKinds: Set<string>;
  nextIndex: number;
  proc?: ScriptProcess;
  done: Promise<void>;
}

// 298 的六种说法（加未派出）
const STATUS_WORDS: Partial<Record<string, string>> = {
  completed: "完成",
  "wall-clock-limit": "超时",
  "turn-limit": "撞上限",
  "token-limit": "撞上限",
  cancelled: "取消",
  aborted: "取消",
  stalled: "卡住",
  "not-started": "未派出",
};

function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? "失败";
}

function defaultRunId(): string {
  return `s${randomBytes(4).toString("hex").slice(0, 7)}`;
}

// 花费的短写法（与状态栏同一口径的三部分）
export function spentText(tally: CostTally): string {
  const parts: string[] = [];
  if (tally.cost > 0) parts.push(`$${tally.cost.toFixed(2)}`);
  if (tally.cny > 0) parts.push(`¥${tally.cny.toFixed(2)}`);
  if (tally.unpricedTokens > 0) parts.push(`${tally.unpricedTokens} token（无价格）`);
  return parts.length > 0 ? parts.join(" + ") : "0";
}

// 额度的同一单位上已花了多少：人民币、美元，或全部 token
export function spentIn(tally: CostTally, unit: ScriptBudget["unit"]): number {
  switch (unit) {
    case "cny":
      return tally.cny;
    case "usd":
      return tally.cost;
    default:
      return tally.pricedTokens + tally.cnyTokens + tally.unpricedTokens;
  }
}

function failureResult(
  ref: string,
  call: Pick<CallState, "label" | "phase">,
  errorKind: string,
  error: string,
  status = "not-started"
): ScriptAgentResult {
  return {
    ok: false,
    status,
    ref,
    ...(call.label !== undefined ? { label: call.label } : {}),
    ...(call.phase !== undefined ? { phase: call.phase } : {}),
    errorKind,
    error,
  };
}

function recordOf(
  outcome: WorkerOutcome,
  fingerprint: string,
  relayFrom: SessionId | undefined
): ScriptCallRecord | undefined {
  const workspace = outcome.workspace;
  if (workspace.kind !== "git-worktree" || workspace.baseCommit === undefined) return undefined;
  return {
    fingerprint,
    sessionId: outcome.sessionId,
    name: outcome.name,
    worktree: workspace.path,
    branch: workspace.branch,
    base: workspace.baseCommit,
    ...(relayFrom !== undefined ? { relayFrom } : {}),
    status: outcome.status,
    ...(outcome.errorKind !== undefined ? { errorKind: outcome.errorKind } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    ...(outcome.blocked !== undefined ? { blockedAction: outcome.blocked.action } : {}),
    summary: outcome.result?.summary ?? "",
    changedFiles: outcome.result?.changedFiles ?? [],
    ...(outcome.result?.structured !== undefined ? { structured: outcome.result.structured } : {}),
  };
}

// 同一指纹的多条记录里取哪条：做完的优先，否则取后到的
function better(current: ScriptCallRecord | undefined, next: ScriptCallRecord): ScriptCallRecord {
  if (current !== undefined && current.status === "completed" && next.status !== "completed") {
    return current;
  }
  return next;
}

export class ScriptRuns implements ScriptKindRegistry {
  readonly #deps: ScriptRunnerDeps;
  readonly #runs = new Map<string, ScriptRun>();
  readonly #runOfSession = new Map<SessionId, ScriptRun>();
  readonly #turnStarts = new Map<SessionId, number>();
  readonly #unobserve: () => void;

  constructor(deps: ScriptRunnerDeps) {
    this.#deps = deps;
    this.#unobserve = deps.orchestrator.observe((activity) => this.#onActivity(activity), {
      eventsOnly: true,
    });
  }

  dispose(): void {
    this.#unobserve();
  }

  // ---- 审批的同类放行（ScriptKindRegistry）----

  title(runId: string): string | undefined {
    const run = this.#runs.get(runId);
    return run?.running === true ? run.spec.name : undefined;
  }

  allows(runId: string, key: string): boolean {
    return this.#runs.get(runId)?.allowedKinds.has(key) === true;
  }

  allow(runId: string, key: string): void {
    this.#runs.get(runId)?.allowedKinds.add(key);
  }

  // ---- 查询 ----

  has(runId: string): boolean {
    return this.#runs.has(runId);
  }

  isRunning(runId: string): boolean {
    return this.#runs.get(runId)?.running === true;
  }

  // 在跑的脚本（界面上停止时不给运行号即停它们）
  running(): string[] {
    return [...this.#runs.values()].filter((run) => run.running).map((run) => run.runId);
  }

  // 等一次运行结束（测试与 pigeon run 用）
  settled(runId: string): Promise<void> {
    return this.#runs.get(runId)?.done ?? Promise.resolve();
  }

  spec(runId: string): ScriptSpec | undefined {
    return this.#runs.get(runId)?.spec;
  }

  budget(runId: string): ScriptBudget | undefined {
    return this.#runs.get(runId)?.budget;
  }

  // 树形视图：脚本与阶段两层（worker 按阶段列出）
  nodes(): Array<{
    id: string;
    title: string;
    state: string;
    phases: Array<{ id: string; title: string; state: string; workers: SessionId[] }>;
  }> {
    const statuses = new Map(
      this.#deps.orchestrator.status().map((status) => [status.sessionId, status])
    );
    return [...this.#runs.values()].map((run) => ({
      id: run.runId,
      title: `${run.spec.name} (${run.runId})`,
      state: run.running
        ? run.stopped
          ? "stopping"
          : "running"
        : run.ending?.kind === "completed"
          ? "done"
          : (run.ending?.kind ?? "done"),
      phases: run.phaseOrder
        .filter((title) => (run.phaseWorkers.get(title)?.length ?? 0) > 0)
        .map((title) => {
          const workers = run.phaseWorkers.get(title) ?? [];
          const live = workers.some((id) => {
            const state = statuses.get(id)?.state;
            return state === "running" || state === "queued";
          });
          return {
            id: `${run.runId}/${title}`,
            title,
            state: live ? "running" : "done",
            workers: [...workers],
          };
        }),
    }));
  }

  // ---- 开跑、续跑、停止、放弃 ----

  async start(spec: ScriptSpec, budget: ScriptBudget | undefined): Promise<string> {
    this.#checkBudget(budget);
    const launcher = await this.#deps.launcher();
    const runId = (this.#deps.newRunId ?? defaultRunId)();
    const snapshot = this.#deps.snapshot(runId);
    const run = this.#newRun(runId, spec, budget, snapshot);
    this.#runs.set(runId, run);
    this.#execute(run, launcher);
    return runId;
  }

  // 续跑：spec 缺省沿用上次的；budget 给了即换成它（调高后续跑）
  async resume(
    runId: string,
    override: { spec?: ScriptSpec; budget?: ScriptBudget } = {}
  ): Promise<"resumed" | "unknown" | "running"> {
    let run = this.#runs.get(runId);
    if (run?.running === true) return "running";
    if (run === undefined) {
      const restored = await this.#deps.restore?.(runId);
      const snapshot = this.#deps.readSnapshot(runId);
      if (restored === undefined || snapshot === undefined) return "unknown";
      run = this.#newRun(runId, restored.spec, restored.budget, snapshot);
      for (const record of restored.records) {
        run.history.set(record.fingerprint, better(run.history.get(record.fingerprint), record));
      }
      for (const name of restored.names) {
        run.nextIndex = Math.max(run.nextIndex, indexOfName(runId, name));
      }
      run.spent = restored.spent;
      this.#runs.set(runId, run);
    }
    this.#checkBudget(override.budget ?? run.budget);
    const launcher = await this.#deps.launcher();
    this.#refresh(run);
    if (override.spec !== undefined) run.spec = override.spec;
    if (override.budget !== undefined) run.budget = override.budget;
    this.#execute(run, launcher);
    return "resumed";
  }

  // 金额额度要模型有价格：没有价格即拒绝（token 额度不看价格；还看不出来的不拦）
  #checkBudget(budget: ScriptBudget | undefined): void {
    if (budget === undefined || budget.unit === "tokens") return;
    if (this.#deps.pricing?.() === "none") {
      throw new ScriptBudgetError(SCRIPT_BUDGET_NO_PRICE);
    }
  }

  // 停止整个脚本：在跑的 worker 停下，其余调用不再派，结果照 313 交回
  async stop(runId: string): Promise<boolean> {
    const run = this.#runs.get(runId);
    if (run === undefined || !run.running) return false;
    run.stopped = true;
    this.#deps.onChange?.();
    const live = [...run.calls.values()].filter((call) => call.running && call.sessionId);
    await Promise.allSettled(
      live.map((call) => this.#deps.orchestrator.cancel(call.sessionId as SessionId))
    );
    const proc = run.proc;
    const grace = setTimeout(() => {
      if (run.running) void proc?.kill();
    }, this.#deps.stopGraceMs ?? SCRIPT_STOP_GRACE_MS);
    grace.unref?.();
    return true;
  }

  // 放弃：不再续跑，删掉快照引用（重启后按运行号同样可放弃）
  drop(runId: string): "dropped" | "running" | "unknown" {
    const run = this.#runs.get(runId);
    if (run?.running === true) return "running";
    if (run === undefined && this.#deps.readSnapshot(runId) === undefined) return "unknown";
    this.#deps.releaseSnapshot(runId);
    this.#runs.delete(runId);
    this.#deps.onChange?.();
    return "dropped";
  }

  // 续跑前按编排器的现状刷新记录：上次结束之后人补批续做完的 worker，以最新的收尾为准
  #refresh(run: ScriptRun): void {
    const outcomes = new Map(
      this.#deps.orchestrator
        .status()
        .flatMap((status) =>
          status.outcome !== undefined ? [[status.sessionId, status.outcome] as const] : []
        )
    );
    for (const [fingerprint, record] of run.history) {
      const outcome = outcomes.get(record.sessionId);
      if (outcome === undefined) continue;
      const latest = recordOf(outcome, fingerprint, record.relayFrom);
      if (latest !== undefined) run.history.set(fingerprint, latest);
    }
  }

  #newRun(
    runId: string,
    spec: ScriptSpec,
    budget: ScriptBudget | undefined,
    snapshot: ScriptSnapshot
  ): ScriptRun {
    return {
      runId,
      spec,
      ...(budget !== undefined ? { budget } : {}),
      snapshot,
      running: false,
      history: new Map(),
      calls: new Map(),
      fingerprints: new ScriptFingerprints(),
      phaseOrder: [],
      phaseWorkers: new Map(),
      spent: emptyCostTally(),
      exhausted: false,
      stopped: false,
      stalled: false,
      allowedKinds: new Set(),
      nextIndex: 0,
      done: Promise.resolve(),
    };
  }

  // ---- 执行 ----

  #execute(run: ScriptRun, launcher: ScriptLauncher): void {
    run.running = true;
    delete run.ending;
    run.stopped = false;
    run.stalled = false;
    run.calls = new Map();
    run.fingerprints = new ScriptFingerprints();
    run.phaseOrder = [...run.spec.phases];
    run.phaseWorkers = new Map();
    run.allowedKinds = new Set();
    run.exhausted = this.#overBudget(run);
    const post = this.#deps.announce();
    const budget = budgetText(run.budget);
    this.#deps.emit?.(
      planLine({
        name: run.spec.name,
        runId: run.runId,
        phases: run.spec.phases,
        ...(Array.isArray(run.spec.args) ? { items: run.spec.args.length } : {}),
        ...(budget !== undefined ? { budget } : {}),
      })
    );
    this.#deps.onChange?.();
    const finished = Promise.withResolvers<void>();
    run.done = finished.promise;
    void this.#drive(run, launcher)
      .then(
        (summary) => post(`${SCRIPT_NOTICE_PREFIX}${summary}`),
        (error: unknown) =>
          post(
            `${SCRIPT_NOTICE_PREFIX}脚本 ${run.spec.name}（运行号 ${run.runId}）出错：${
              error instanceof Error ? error.message : String(error)
            }。`
          )
      )
      .finally(() => {
        run.running = false;
        run.allowedKinds = new Set();
        this.#deps.onChange?.();
        finished.resolve();
      });
  }

  async #drive(run: ScriptRun, launcher: ScriptLauncher): Promise<string> {
    const proc = launcher({ runId: run.runId });
    run.proc = proc;
    const pending = new Set<Promise<void>>();
    // 卡住监控（宿主侧计时，脚本自身死循环、执行环境阻塞时同样有效）：没有调用在等 worker 时开始计时，有调用进来即停表
    const stallMs = this.#deps.stallMs ?? SCRIPT_STALL_MS;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const armStall = (): void => {
      clearTimeout(stallTimer);
      if (ended || pending.size > 0) return;
      stallTimer = setTimeout(() => {
        if (ended || pending.size > 0) return;
        run.stalled = true;
        void proc.kill();
      }, stallMs);
      stallTimer.unref?.();
    };
    const end = new Promise<{ value?: unknown; error?: string }>((resolve) => {
      proc.onMessage((message) => {
        switch (message.t) {
          case "call": {
            const task = this.#agent(run, message.payload).then((value) =>
              proc.send({ t: "result", id: message.id, value })
            );
            pending.add(task);
            armStall();
            void task.finally(() => {
              pending.delete(task);
              armStall();
            });
            break;
          }
          case "phase":
            this.#notePhase(run, message.text);
            break;
          case "log":
            this.#deps.emit?.(logLine(run.spec.name, message.text));
            break;
          case "done":
            resolve({ value: message.value });
            break;
          case "error":
            resolve({ error: message.message });
            break;
        }
      });
      void proc.exited.then((exit) =>
        resolve({
          error: `执行器退出（退出码 ${exit.code ?? "无"}）${
            exit.stderr.trim() !== ""
              ? `：${exit.stderr.trim().split("\n").slice(-3).join(" ")}`
              : ""
          }`,
        })
      );
    });
    proc.send({ t: "start", source: run.spec.script, args: run.spec.args ?? null });
    armStall();
    const outcome = await end;
    ended = true;
    clearTimeout(stallTimer);
    // 脚本结束时还在跑的调用：做完再收尾
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
    await proc.kill().catch(() => {});
    delete run.proc;
    const notStarted = [...run.calls.values()].filter(
      (call) => call.notStarted === "budget"
    ).length;
    const ending: ScriptEnding = run.stopped
      ? { kind: "stopped" }
      : run.stalled
        ? { kind: "stalled", minutes: Math.max(1, Math.round(stallMs / 60_000)) }
        : outcome.error !== undefined
          ? { kind: "error", reason: outcome.error }
          : notStarted > 0
            ? { kind: "budget" }
            : { kind: "completed" };
    run.ending = ending;
    const collection =
      ending.kind === "completed"
        ? await this.#collect(run, outcome.value)
        : ({ kind: "skipped", reason: "脚本没有正常结束" } as const);
    return summaryText(this.#summary(run, ending, collection, outcome.value, notStarted));
  }

  #notePhase(run: ScriptRun, title: string): void {
    if (!run.phaseOrder.includes(title)) run.phaseOrder.push(title);
    this.#deps.onChange?.();
  }

  #placeInPhase(run: ScriptRun, phase: string | undefined, sessionId: SessionId): void {
    const title = phase ?? "-";
    if (!run.phaseOrder.includes(title)) run.phaseOrder.push(title);
    const list = run.phaseWorkers.get(title) ?? [];
    if (!list.includes(sessionId)) list.push(sessionId);
    run.phaseWorkers.set(title, list);
    this.#deps.onChange?.();
  }

  #overBudget(run: ScriptRun): boolean {
    const budget = run.budget;
    return budget !== undefined && spentIn(run.spent, budget.unit) >= budget.amount;
  }

  // 按轮累计本次脚本派出的 worker 的用量（与状态栏同一算法）
  #onActivity(activity: WorkerActivity): void {
    if (activity.kind !== "event") return;
    const { event, worker } = activity;
    const run = this.#runOfSession.get(worker.sessionId);
    if (run === undefined) return;
    if (event.kind === "turn.started") {
      this.#turnStarts.set(worker.sessionId, event.timestamp);
      return;
    }
    if (event.kind !== "turn.completed") return;
    const usage = (event.payload as { usage?: UsageLike } | undefined)?.usage;
    if (usage === undefined) return;
    const startMs = this.#turnStarts.get(worker.sessionId);
    addUsage(run.spent, usage, {
      ...(this.#deps.provider !== undefined ? { provider: this.#deps.provider } : {}),
      ...(startMs !== undefined ? { startMs } : {}),
      endMs: event.timestamp,
    });
    if (!run.exhausted && this.#overBudget(run)) {
      run.exhausted = true;
    }
  }

  // 一个 agent 调用：校验、算指纹、复用或派出、等结束、改正输出格式
  async #agent(run: ScriptRun, payload: unknown): Promise<ScriptAgentResult> {
    const input = (payload ?? {}) as {
      task?: unknown;
      label?: unknown;
      phase?: unknown;
      role?: unknown;
      schema?: unknown;
      relay?: unknown;
    };
    const label =
      typeof input.label === "string" && input.label.trim() !== "" ? input.label.trim() : undefined;
    const phase = typeof input.phase === "string" ? input.phase : undefined;
    const where = {
      ...(label !== undefined ? { label } : {}),
      ...(phase !== undefined ? { phase } : {}),
    };
    const task = typeof input.task === "string" ? input.task.trim() : "";
    const role = input.role === undefined ? "implementer" : String(input.role);
    const badRef = `bad-${run.calls.size + 1}`;
    if (task === "") {
      return failureResult(badRef, where, "bad-call", "任务不能为空");
    }
    if (!isWorkerRole(role)) {
      return failureResult(
        badRef,
        where,
        "bad-call",
        `没有角色 ${role}；可选：${WORKER_ROLES.join("、")}`
      );
    }
    const schema = input.schema;
    if (
      schema !== undefined &&
      (typeof schema !== "object" || schema === null || Array.isArray(schema))
    ) {
      return failureResult(badRef, where, "bad-call", "schema 须为一个 JSON Schema 对象");
    }
    let upstream: CallState | undefined;
    if (input.relay !== undefined) {
      upstream = run.calls.get(String(input.relay));
      if (upstream?.result?.ok !== true || upstream.record === undefined) {
        return failureResult(
          badRef,
          where,
          "relay-unavailable",
          "接力的上游没有做完（relay 须为本次脚本里一次成功的 agent 结果）"
        );
      }
    }
    const fingerprint = run.fingerprints.next({
      task,
      role,
      ...(schema !== undefined ? { schema } : {}),
      ...(upstream !== undefined ? { relay: upstream.fingerprint } : {}),
    });
    const call: CallState = {
      fingerprint,
      task,
      role,
      ...where,
      ...(schema !== undefined ? { schema } : {}),
      reused: false,
      running: false,
    };
    run.calls.set(fingerprint, call);
    const relayFrom = upstream?.record?.sessionId;
    const prior = run.history.get(fingerprint);
    if (prior !== undefined && this.#reusable(prior, schema, relayFrom)) {
      call.reused = true;
      call.record = prior;
      call.sessionId = prior.sessionId;
      this.#placeInPhase(run, phase, prior.sessionId);
      call.result = this.#resultOf(call, prior);
      return call.result;
    }
    if (run.stopped) {
      call.notStarted = "stopped";
      call.result = failureResult(fingerprint, where, "stopped", "脚本已停止，没有派出");
      return call.result;
    }
    if (run.exhausted || this.#deps.hostExhausted?.() === true) {
      call.notStarted = "budget";
      call.result = failureResult(fingerprint, where, "budget-exhausted", "额度用完，没有派出");
      return call.result;
    }
    run.nextIndex += 1;
    const name = `${run.runId}-${run.nextIndex}`;
    let sessionId: SessionId;
    try {
      sessionId = this.#deps.orchestrator.spawn({
        role,
        task: schema !== undefined ? `${task}${schemaAppendix(schema)}` : task,
        name,
        ...(label !== undefined ? { label } : {}),
        origin: "program",
        start:
          upstream?.record !== undefined
            ? { from: upstream.record.worktree }
            : { point: run.snapshot },
        script: {
          runId: run.runId,
          fingerprint,
          ...(relayFrom !== undefined ? { relayFrom } : {}),
        },
      });
    } catch (error) {
      call.result = failureResult(
        fingerprint,
        where,
        "spawn-failed",
        error instanceof Error ? error.message : String(error),
        "failed"
      );
      return call.result;
    }
    call.sessionId = sessionId;
    call.running = true;
    this.#runOfSession.set(sessionId, run);
    this.#placeInPhase(run, phase, sessionId);
    let outcome = await this.#deps.orchestrator.awaitResult(sessionId);
    // 结构化输出不合格式：在原会话里改正，至多两次
    let problems = schema !== undefined ? this.#problems(schema, outcome) : [];
    for (
      let attempt = 0;
      problems.length > 0 &&
      outcome.status === "completed" &&
      attempt < SCRIPT_OUTPUT_CORRECTIONS &&
      !run.stopped;
      attempt += 1
    ) {
      this.#deps.orchestrator.resume(sessionId, { message: schemaCorrection(problems, schema) });
      outcome = await this.#deps.orchestrator.awaitResult(sessionId);
      problems = this.#problems(schema, outcome);
    }
    call.running = false;
    const record = recordOf(outcome, fingerprint, relayFrom);
    if (record === undefined) {
      call.result = failureResult(
        fingerprint,
        where,
        outcome.errorKind ?? "no-worktree",
        outcome.error ?? "worker 没有工作树",
        outcome.status
      );
      return call.result;
    }
    call.record = record;
    run.history.set(fingerprint, better(run.history.get(fingerprint), record));
    call.result = this.#resultOf(call, record);
    if (call.result.ok && problems.length > 0) {
      call.result = {
        ...call.result,
        ok: false,
        errorKind: "output-invalid",
        error: `输出不合格式（已让它改正 ${SCRIPT_OUTPUT_CORRECTIONS} 次）：${problems.join("；")}`,
      };
    }
    return call.result;
  }

  #problems(schema: unknown, outcome: WorkerOutcome): string[] {
    if (outcome.status !== "completed") return [];
    const structured = outcome.result?.structured;
    if (structured === undefined) {
      return ["最后一条回复里没有可解析的 JSON 对象"];
    }
    return checkJsonSchema(schema, structured);
  }

  // 续跑复用：上次做完、工作树还在、输出仍合格式，接力的上游是同一个 worker
  #reusable(record: ScriptCallRecord, schema: unknown, relayFrom: SessionId | undefined): boolean {
    if (record.status !== "completed" || !existsSync(record.worktree)) return false;
    if (record.relayFrom !== relayFrom) return false;
    if (schema !== undefined) {
      if (record.structured === undefined) return false;
      if (checkJsonSchema(schema, record.structured).length > 0) return false;
    }
    return true;
  }

  #resultOf(call: CallState, record: ScriptCallRecord): ScriptAgentResult {
    const ok = record.status === "completed";
    return {
      ok,
      status: record.status,
      ref: call.fingerprint,
      name: record.name,
      ...(call.label !== undefined ? { label: call.label } : {}),
      ...(call.phase !== undefined ? { phase: call.phase } : {}),
      branch: record.branch,
      files: record.changedFiles,
      summary: record.summary,
      ...(record.structured !== undefined ? { output: record.structured } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.errorKind !== undefined ? { errorKind: record.errorKind } : {}),
      ...(call.reused ? { reused: true } : {}),
    };
  }

  // 按脚本交回的清单收回：清单为 return 值的 collect（agent 的结果或 worker 名）
  async #collect(run: ScriptRun, value: unknown): Promise<SummaryInput["collection"]> {
    const listed =
      value !== null &&
      typeof value === "object" &&
      Array.isArray((value as { collect?: unknown }).collect)
        ? (value as { collect: unknown[] }).collect
        : [];
    const calls = [...run.calls.values()];
    const targets: CollectTarget[] = [];
    for (const item of listed) {
      const call =
        item !== null && typeof item === "object"
          ? run.calls.get(String((item as { ref?: unknown }).ref))
          : calls.find((entry) => entry.record?.name === String(item));
      const record = call?.record;
      if (call?.result?.ok !== true || record === undefined) continue;
      if (targets.some((target) => target.name === record.name)) continue;
      targets.push({ name: record.name, worktree: record.worktree, base: record.base });
    }
    if (targets.length === 0) {
      return { kind: "skipped", reason: "没有要收回的" };
    }
    const approved = await this.#deps.approveCollect({
      runId: run.runId,
      title: run.spec.name,
      workers: targets.map((target) => target.name),
      targets,
    });
    if (!approved) {
      return { kind: "skipped", reason: "人没有批准" };
    }
    const applied: string[] = [];
    const conflicts: string[] = [];
    const deletedByWorker: string[] = [];
    for (const target of targets) {
      try {
        const result = this.#deps.overlay(target);
        applied.push(...result.applied);
        conflicts.push(...result.conflicts);
        deletedByWorker.push(...result.deletedByWorker);
      } catch (error) {
        conflicts.push(
          `${target.name}（收回失败：${error instanceof Error ? error.message : String(error)}）`
        );
      }
    }
    // 收回之后不再需要快照引用（worker 分支仍指向它的后代）
    try {
      this.#deps.releaseSnapshot(run.runId);
    } catch {
      // 删引用失败不改变收回结果
    }
    return { kind: "done", applied, conflicts, deletedByWorker };
  }

  #summary(
    run: ScriptRun,
    ending: ScriptEnding,
    collection: SummaryInput["collection"],
    returned: unknown,
    notStarted: number
  ): SummaryInput {
    const calls = [...run.calls.values()];
    const withWorker = calls.filter(
      (call) => call.record !== undefined || call.sessionId !== undefined
    );
    const who = (call: CallState): string => {
      const name =
        call.record?.name ?? (call.task.length > 20 ? `${call.task.slice(0, 20)}…` : call.task);
      return call.label !== undefined ? `${name}（${call.label}）` : name;
    };
    const failures: SummaryInput["failures"][number][] = [];
    const awaiting: SummaryInput["awaitingApproval"][number][] = [];
    for (const call of calls) {
      const result = call.result;
      if (result === undefined || result.ok || call.notStarted === "budget") continue;
      if (call.record?.blockedAction !== undefined) {
        awaiting.push({ who: who(call), action: call.record.blockedAction });
        continue;
      }
      failures.push({
        who: who(call),
        status: statusWord(result.status),
        reason: result.error ?? result.errorKind ?? "原因不明",
      });
    }
    return {
      name: run.spec.name,
      runId: run.runId,
      ending,
      workers: withWorker.length,
      succeeded: withWorker.filter((call) => call.result?.ok === true).length,
      failed: withWorker.filter((call) => call.result?.ok !== true).length,
      reused: calls.filter((call) => call.reused).length,
      spent: spentText(run.spent),
      failures,
      awaitingApproval: awaiting,
      ...(ending.kind === "budget" ? { notStarted } : {}),
      // 额度用完、被停或卡住：不自动收回，列出已做完的 worker 与分支
      ...(ending.kind === "budget" || ending.kind === "stopped" || ending.kind === "stalled"
        ? {
            done: withWorker.flatMap((call) =>
              call.result?.ok === true && call.record !== undefined
                ? [{ name: call.record.name, branch: call.record.branch }]
                : []
            ),
          }
        : {}),
      collection,
      ...(returned !== undefined && returned !== null ? { returned } : {}),
    };
  }
}

// worker 名里的序号（<运行号>-<n>）
function indexOfName(runId: string, name: string): number {
  const prefix = `${runId}-`;
  if (!name.startsWith(prefix)) return 0;
  const index = Number(name.slice(prefix.length));
  return Number.isInteger(index) ? index : 0;
}
