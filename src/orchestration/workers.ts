// worker 生命周期（M5.5 S2，决策 040）：同进程多 Adapter 的并行 worker 编排。对外只有 spawn / cancel /
// status / awaitResult 四个动作与构造时注入的审批回调——这就是 §3.6 的 Job 边界，多进程与跨机器是换实现
// 不换调用方。worker 运行面由装配根以工厂注入（本层不触达 application），worker 内部仍是工具串行与
// run() 互斥。证据顺序：父会话先落 child.spawned（派出意图），再建工作区与运行面；worker 会话关闭后
// 落 child.settled（结构化结果）。派出失败同样以 settled 收口，两族恒配对；缺 settled = 进程死于中途。
// 深度 1：本编排器所在会话自己是 worker 时拒绝再派。上限只有轮次与墙钟，超限与取消都走 interrupt。
// 决策 268：同时在跑的 worker 数可设上限，多派的排队不拒绝——派出记录、工作区与运行面照常在派出时建好，
// 只是开跑（连同墙钟计时）等到有空位；一个会话里人派的与 agent 派的共用同一个编排器，因而一并计算。
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "../approvals/handler.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { RunStopCause } from "../state/session-entries.ts";
import type {
  ChildResult,
  ChildSettledInput,
  ChildSettledStatus,
  ChildSpawnedInput,
  DelegatedPolicy,
  WorkerLimits,
  WorkerRole,
  WorkerWorkspace,
} from "../state/session-payloads.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import { assertPolicySubset, deriveWorkerPolicy, isWorkerRole, WORKER_ROLES } from "./roles.ts";
import {
  addWorktree,
  assertWorkerName,
  changedFiles,
  worktreeBranchFor,
  worktreePathFor,
} from "./worktree.ts";

export const DEFAULT_WORKER_LIMITS: WorkerLimits = { maxTurns: 40, wallClockMs: 30 * 60_000 };
// 自述摘要进 child.settled 的上限（全文在 worker 会话的消息里）
export const WORKER_SUMMARY_MAX_CHARS = 2000;

export class WorkerDepthError extends Error {}
export class WorkerSpawnError extends Error {}

export type WorkerRunStatus = "completed" | "failed" | "aborted" | "unknown";

export interface WorkerRunResult {
  status: WorkerRunStatus;
  errorMessage?: string;
  runId?: RunId;
  emptyReply?: boolean;
}

// 装配根交回的 worker 运行面（PiRuntimeAdapter + 会话文件的最小操作面）
export interface WorkerRuntimeHandle {
  // runId：本次运行的 Run（运行面装起来并真正开跑时在场）；撞上限记录据此落在被中止的那次 Run 上
  // emptyReply：空回复异常结束（决策 170 ②；运行面给出，此时 status 为 failed）
  run(task: string): Promise<WorkerRunResult>;
  // 撞上限时带上原因（决策 182：运行面据此把 Run 收尾的结束方式一次写全）；取消与外部中止不带
  interrupt(cause?: RunStopCause): Promise<void>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  // 末条 assistant 正文
  summary(): string;
  // M6（决策 064）：模型交回的结构化内容（末条 assistant 正文能解析成对象时在场）；
  // 不实现即视为没有结构化结果，既有 worker 行为不变
  structured?(): unknown;
  // M7（决策 077 / 079）：从已有消息续跑（分叉续跑）；不实现即不支持
  continueRun?(): Promise<WorkerRunResult>;
  // 释放运行面并关闭 worker 会话文件
  dispose(): Promise<void>;
}

// 汇聚到父级的审批请求：来源会话与 worker 标签恒在场
export interface WorkerApprovalRequest extends ApprovalRequest {
  readonly sessionId: SessionId;
  readonly worker: { readonly name: string; readonly role: WorkerRole };
}

export interface WorkerRuntimeRequest {
  sessionId: SessionId;
  name: string;
  role: WorkerRole;
  task: string;
  policy: DelegatedPolicy;
  governanceRoot: string;
  workspace: WorkerWorkspace;
  lineage: { parentSessionId: SessionId; parentRunId?: RunId };
  // 已带来源标签的审批入口（转发到编排器的审批回调）
  approvalHandler: ApprovalHandler;
  // M8（决策 087）：本 worker 的上限（与派出记录同一组值）——装配层据此把预算冻结进注入快照，
  // 回放才能沿用被验证那次尝试的预算
  limits?: WorkerLimits;
}

export type WorkerRuntimeFactory = (request: WorkerRuntimeRequest) => WorkerRuntimeHandle;

// 隔离工作区提供者：第一版为 git 工作树；测试注入内存实现。
// M6.5 S2（决策 057）：baseRef 为起点提交（Eval 任务的 ref），缺省 HEAD
export interface WorkspaceProviderInput {
  sessionId: SessionId;
  name: string;
  role: WorkerRole;
  baseRef?: string;
}

export interface WorkspaceProvider {
  plan(input: WorkspaceProviderInput): WorkerWorkspace;
  create(workspace: WorkerWorkspace, input: WorkspaceProviderInput): void;
  changedFiles(workspace: WorkerWorkspace): string[];
}

// 仓库根与治理根分开传（M6.5 S2）：工作树与分支建在仓库根上，目录放在治理根的 .pigeon/worktrees 下。
// 主会话派 worker 时两者同为主仓库根；Eval 的治理根是输出目录
export function gitWorktreeWorkspaces(roots: {
  repoRoot: string;
  governanceRoot: string;
}): WorkspaceProvider {
  return {
    // 无工作区形状只属于已退役的只读角色（决策 137），现有角色一律开 git 工作树
    plan: ({ sessionId, name }) => ({
      kind: "git-worktree",
      path: worktreePathFor(roots.governanceRoot, sessionId, name),
      branch: worktreeBranchFor(name),
    }),
    create: (_workspace, { sessionId, name, baseRef }) => {
      addWorktree({
        repoRoot: roots.repoRoot,
        governanceRoot: roots.governanceRoot,
        sessionId,
        name,
        ...(baseRef !== undefined ? { baseRef } : {}),
      });
    },
    changedFiles: (workspace) =>
      workspace.kind === "git-worktree" ? changedFiles(workspace.path) : [],
  };
}

// 父会话的派出与收尾落盘口（装配根接到父会话的会话存储）
export interface ChildFamilySink {
  appendChildSpawned(input: ChildSpawnedInput): unknown;
  appendChildSettled(input: ChildSettledInput): unknown;
}

export interface WorkerOrchestratorOptions {
  governanceRoot: string;
  // 本编排器所在会话；parentSessionId 在场 = 本会话自己是 worker
  session: { sessionId: SessionId; parentSessionId?: SessionId };
  parentPolicy: ToolPolicyLike;
  parentLog: ChildFamilySink;
  createRuntime: WorkerRuntimeFactory;
  approvals: (request: WorkerApprovalRequest) => Promise<ApprovalDecision>;
  // 派出时父会话的活动 Run（人以 /spawn 派出时无）
  activeRunId?: () => RunId | undefined;
  // 决策 268：同时在跑的 worker 上限（缺省不限）；多派的排队
  maxConcurrent?: number;
  // 决策 268：worker 每收尾一轮回报本轮用的 token（计入本次运行的总额度）
  onWorkerTokens?: (sessionId: SessionId, tokens: number) => void;
  workspaces?: WorkspaceProvider;
  defaultLimits?: Partial<WorkerLimits>;
  now?: () => number;
}

export interface SpawnRequest {
  role: string;
  task: string;
  name?: string;
  limits?: Partial<WorkerLimits>;
  // M7（决策 069）：并行派发同一任务时的共享任务标识，写入派出记录
  taskKey?: string;
}

// queued：已派出、等空位开跑（决策 268）
export type WorkerState = "queued" | "running" | ChildSettledStatus;

export interface WorkerStatus {
  sessionId: SessionId;
  name: string;
  role: WorkerRole;
  state: WorkerState;
  turns: number;
  // 无工作区的 worker 没有分支（只读的 Reviewer 已退役，决策 137；现有角色一律开工作树）
  branch?: string;
  startedAt: number;
  workspace: WorkerWorkspace;
}

export interface WorkerOutcome {
  sessionId: SessionId;
  name: string;
  role: WorkerRole;
  status: ChildSettledStatus;
  error?: string;
  turns: number;
  result?: ChildResult;
  workspace: WorkerWorkspace;
}

interface WorkerEntry {
  sessionId: SessionId;
  name: string;
  role: WorkerRole;
  workspace: WorkerWorkspace;
  runtime: WorkerRuntimeHandle;
  state: WorkerState;
  turns: number;
  startedAt: number;
  cancelRequested: boolean;
  limitHit?: "turn-limit" | "wall-clock-limit" | "token-limit";
  tokens: number;
  done: Promise<WorkerOutcome>;
}

export class WorkerOrchestrator {
  readonly #options: WorkerOrchestratorOptions;
  readonly #workspaces: WorkspaceProvider;
  readonly #now: () => number;
  readonly #workers = new Map<SessionId, WorkerEntry>();
  // 排队中的 worker：按派出顺序等空位（决策 268）
  readonly #queue: Array<{ sessionId: SessionId; start: () => void }> = [];
  #running = 0;
  // 不改变结果的内部故障（settled 写盘失败、结果回收失败等）
  readonly #errors: unknown[] = [];

  constructor(options: WorkerOrchestratorOptions) {
    const max = options.maxConcurrent;
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
      throw new WorkerSpawnError(`同时在跑的 worker 上限需要正整数：${max}`);
    }
    this.#options = options;
    this.#workspaces =
      options.workspaces ??
      gitWorktreeWorkspaces({
        repoRoot: options.governanceRoot,
        governanceRoot: options.governanceRoot,
      });
    this.#now = options.now ?? Date.now;
  }

  spawn(request: SpawnRequest): SessionId {
    const { session } = this.#options;
    if (session.parentSessionId !== undefined) {
      throw new WorkerDepthError("深度 1：worker 会话不能再派 worker");
    }
    if (!isWorkerRole(request.role)) {
      throw new WorkerSpawnError(`未知角色：${request.role}（可用：${WORKER_ROLES.join("、")}）`);
    }
    const role = request.role;
    const task = request.task.trim();
    if (task === "") {
      throw new WorkerSpawnError("任务不能为空");
    }
    const name = request.name ?? this.#nextName(role);
    assertWorkerName(name);
    if ([...this.#workers.values()].some((worker) => worker.name === name)) {
      throw new WorkerSpawnError(`worker 名已被占用：${name}`);
    }
    const policy = deriveWorkerPolicy(this.#options.parentPolicy, role);
    assertPolicySubset(policy, this.#options.parentPolicy);
    const limits: WorkerLimits = {
      ...DEFAULT_WORKER_LIMITS,
      ...this.#options.defaultLimits,
      ...request.limits,
    };
    const sessionId = newSessionId();
    const workspace = this.#workspaces.plan({ sessionId, name, role });
    const parentRunId = this.#options.activeRunId?.();
    // 派出意图先落盘：写不进就不派（异常原样上抛，零工作区零运行面）
    this.#options.parentLog.appendChildSpawned({
      childSessionId: sessionId,
      name,
      role,
      task,
      ...(request.taskKey !== undefined ? { taskKey: request.taskKey } : {}),
      policy,
      limits,
      workspace,
      spawnedAt: this.#now(),
      ...(parentRunId !== undefined ? { runId: parentRunId } : {}),
    });
    let runtime: WorkerRuntimeHandle;
    try {
      this.#workspaces.create(workspace, { sessionId, name, role });
      runtime = this.#options.createRuntime({
        sessionId,
        name,
        role,
        task,
        policy,
        governanceRoot: this.#options.governanceRoot,
        workspace,
        lineage: {
          parentSessionId: session.sessionId,
          ...(parentRunId !== undefined ? { parentRunId } : {}),
        },
        approvalHandler: (approval) =>
          this.#options.approvals({ ...approval, sessionId, worker: { name, role } }),
        limits,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#appendSettled({
        childSessionId: sessionId,
        name,
        status: "spawn-failed",
        error: message,
        turns: 0,
      });
      throw new WorkerSpawnError(`派出 worker ${name} 失败：${message}`, { cause: error });
    }
    const done = Promise.withResolvers<WorkerOutcome>();
    const entry: WorkerEntry = {
      sessionId,
      name,
      role,
      workspace,
      runtime,
      state: "queued",
      turns: 0,
      startedAt: this.#now(),
      cancelRequested: false,
      tokens: 0,
      done: done.promise,
    };
    this.#workers.set(sessionId, entry);
    const start = (): void => {
      this.#drive(entry, task, limits)
        .finally(() => this.#release())
        .then(done.resolve, done.reject);
    };
    // 有空位即同步开跑（与不设上限时的行为一致）；否则按派出顺序排队
    if (this.#tryAcquire()) {
      entry.state = "running";
      start();
    } else {
      this.#queue.push({ sessionId, start });
    }
    return sessionId;
  }

  // 取消走 interrupt（abort → waitForIdle）；排队中的直接出队、不开跑；已收尾的 worker 无操作
  async cancel(sessionId: SessionId): Promise<void> {
    const entry = this.#require(sessionId);
    if (entry.state !== "running" && entry.state !== "queued") {
      return;
    }
    entry.cancelRequested = true;
    const queued = this.#queue.findIndex((item) => item.sessionId === sessionId);
    if (queued >= 0) {
      const [item] = this.#queue.splice(queued, 1);
      // 出队的 worker 不占空位：先记一个再由收尾释放，账目对平
      this.#running += 1;
      item?.start();
      return;
    }
    await entry.runtime.interrupt();
  }

  status(): WorkerStatus[] {
    return [...this.#workers.values()].map((entry) => ({
      sessionId: entry.sessionId,
      name: entry.name,
      role: entry.role,
      state: entry.state,
      turns: entry.turns,
      ...(entry.workspace.kind === "git-worktree" ? { branch: entry.workspace.branch } : {}),
      startedAt: entry.startedAt,
      workspace: entry.workspace,
    }));
  }

  awaitResult(sessionId: SessionId): Promise<WorkerOutcome> {
    return this.#require(sessionId).done;
  }

  errors(): unknown[] {
    return this.#errors.slice();
  }

  // 占一个空位：未设上限或有空位即占下
  #tryAcquire(): boolean {
    const max = this.#options.maxConcurrent;
    if (max === undefined || this.#running < max) {
      this.#running += 1;
      return true;
    }
    return false;
  }

  // 收尾让出空位：队首的接着开跑（空位直接转交，计数不变）
  #release(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      next.start();
      return;
    }
    this.#running -= 1;
  }

  async #drive(entry: WorkerEntry, task: string, limits: WorkerLimits): Promise<WorkerOutcome> {
    const { runtime } = entry;
    // 排队期间被取消：不开跑，按取消收尾（结果回收与释放照常）
    const skipRun = entry.cancelRequested;
    if (!skipRun) {
      entry.state = "running";
      entry.startedAt = this.#now();
    }
    const stop = (reason: "turn-limit" | "wall-clock-limit" | "token-limit") => {
      if (entry.limitHit !== undefined || entry.cancelRequested) {
        return;
      }
      entry.limitHit = reason;
      // 只发中止请求；撞上限记录等运行确以中止收尾后再写（072 修订）
      runtime.interrupt(reason).catch((error: unknown) => {
        this.#errors.push(error);
      });
    };
    const unsubscribe = runtime.subscribe((event) => {
      if (event.kind === "turn.completed") {
        entry.turns += 1;
        // M6（决策 064 子裁决 ④）：累计 token 上限（取 turn.completed 的用量；缺省不限）
        const usage = (event.payload as { usage?: { totalTokens?: number } } | undefined)?.usage;
        const turnTokens = usage?.totalTokens ?? 0;
        entry.tokens += turnTokens;
        if (turnTokens > 0) {
          try {
            this.#options.onWorkerTokens?.(entry.sessionId, turnTokens);
          } catch (error) {
            this.#errors.push(error);
          }
        }
        if (entry.turns >= limits.maxTurns) {
          stop("turn-limit");
        } else if (limits.maxTokens !== undefined && entry.tokens >= limits.maxTokens) {
          stop("token-limit");
        }
      }
    });
    const timer = skipRun
      ? undefined
      : setTimeout(() => stop("wall-clock-limit"), limits.wallClockMs);
    let status: ChildSettledStatus;
    let error: string | undefined;
    try {
      const run: WorkerRunResult = skipRun ? { status: "aborted" } : await runtime.run(task);
      if (run.status === "completed") {
        status = "completed";
      } else if (run.status === "aborted") {
        // 上限中止在运行终态上只表现为中止；撞上限的原因随中止请求交给运行面，由 Run 收尾条目记下（072 修订）
        status = entry.cancelRequested ? "cancelled" : (entry.limitHit ?? "aborted");
      } else {
        status = "failed";
        error = run.errorMessage ?? "运行以未知终态结束";
      }
    } catch (caught) {
      status = "failed";
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
    // 结果回收（失败与中止同样回收：工作树里可能已有部分工作）
    let result: ChildResult | undefined;
    try {
      const summary = runtime.summary();
      // M6（决策 064）：无工作区的 worker 没有分支与改动文件；结构化结果在场时随收尾一并回收
      const structured = runtime.structured?.();
      result = {
        ...(entry.workspace.kind === "git-worktree"
          ? {
              branch: entry.workspace.branch,
              changedFiles: this.#workspaces.changedFiles(entry.workspace),
            }
          : {}),
        summary: summary.slice(0, WORKER_SUMMARY_MAX_CHARS),
        summaryTruncated: summary.length > WORKER_SUMMARY_MAX_CHARS,
        ...(structured !== undefined ? { structured } : {}),
      };
    } catch (caught) {
      this.#errors.push(caught);
    }
    try {
      await runtime.dispose();
    } catch (caught) {
      this.#errors.push(caught);
    }
    entry.state = status;
    const outcome: WorkerOutcome = {
      sessionId: entry.sessionId,
      name: entry.name,
      role: entry.role,
      workspace: entry.workspace,
      status,
      turns: entry.turns,
      ...(error !== undefined ? { error } : {}),
      ...(result !== undefined ? { result } : {}),
    };
    this.#appendSettled({
      childSessionId: entry.sessionId,
      name: entry.name,
      status,
      turns: entry.turns,
      ...(error !== undefined ? { error } : {}),
      ...(result !== undefined ? { result } : {}),
    });
    return outcome;
  }

  // settled 写盘失败不改变 worker 结果：进内部故障清单，父会话留"缺 settled"的可见缺口
  #appendSettled(input: Omit<ChildSettledInput, "settledAt">): void {
    try {
      this.#options.parentLog.appendChildSettled({ ...input, settledAt: this.#now() });
    } catch (error) {
      this.#errors.push(error);
    }
  }

  #require(sessionId: SessionId): WorkerEntry {
    const entry = this.#workers.get(sessionId);
    if (entry === undefined) {
      throw new WorkerSpawnError(`未知 worker：${sessionId}`);
    }
    return entry;
  }

  #nextName(role: WorkerRole): string {
    const taken = new Set([...this.#workers.values()].map((worker) => worker.name));
    let index = 1;
    while (taken.has(`${role}-${index}`)) {
      index += 1;
    }
    return `${role}-${index}`;
  }
}
