// worker 生命周期（M5.5 S2，决策 040）：同进程多 Adapter 的并行 worker 编排。对外的动作是派出 spawn、取消 cancel、
// 状态 status、等单个结果 awaitResult，以及决策 294、297 补上的等待 wait、发消息 send、补批续做 resume 与生命周期订阅
// subscribe——这就是 §3.6 的 Job 边界，多进程与跨机器是换实现不换调用方。worker 运行面由装配根以工厂注入（本层不触达
// application），worker 内部仍是工具串行与 run() 互斥。证据顺序：派出方的会话先落 child.spawned（派出意图），再建工作区与
// 运行面；worker 会话关闭后落 child.settled（结构化结果）。派出失败同样以 settled 收口，两族恒配对；缺 settled = 进程死于中途。
// 决策 294 的五个接口在本层：派出可带标签并在各事件与结果里原样带回；生命周期统一经 subscribe 发事件；各动作可被程序直接调用；
// 并发额度只在这里管（人派、模型派与程序派共用）；worker 的结果与工作树在派出方这一轮结束后仍保留，可稍后收回。
// 决策 299：层数缺省 1（只有主会话能派），配置放开时各层共用本编排器与同一份并发额度；等待中的 worker 把自己的空位借出，
// 免得上层占满额度等下层而互相卡死。
// 决策 300：同时在跑的上限缺省 8，多派的排队不拒绝——派出记录、工作区与运行面照常在派出时建好，只是开跑（连同墙钟计时）
// 等到有空位；不设总数上限。
// 决策 298：结束时交回结构化结果（状态、错误类型、最后一段输出、已改文件、会话记录位置），不自动重试；卡住监控——长时间
// 没有新的模型回复或工具结果即中断、报卡住（等审批期间不计）；观察者接入点留给打转检测（293）。
// 决策 303：worker 需请示的动作经审批回调汇到派出方，请求带上 worker 的名字；等满审批时限无人批、或处于无人值守（pigeon run）
// 即不再等，worker 停下、以可恢复的失败交回，其余 worker 照常；之后可经 resume 补批续做。
// 决策 301：只读观察口 observe——界面据此看各 worker 的运行事件、流式正文与工具结果（编排面板、树形视图、进入 worker 会话）；
// 没有观察者时不订阅流式正文与工具结果，pigeon run 与跑批的行为不变。
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "../approvals/handler.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { LoopRound } from "../state/loop-guard.ts";
import type { RunStopCause } from "../state/session-entries.ts";
import type {
  ChildResult,
  ChildSettledInput,
  ChildSettledStatus,
  ChildSpawnedInput,
  DelegatedPolicy,
  ScriptSpawnTag,
  WorkerErrorKind,
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
// 决策 300：同时在跑的 worker 上限缺省
export const DEFAULT_MAX_CONCURRENT_WORKERS = 8;
// 决策 299：缺省只有一层（主会话派出的 worker 不能再派）
export const DEFAULT_MAX_WORKER_DEPTH = 1;
// 决策 298：卡住判定——这么久没有新的模型回复或工具结果即中断（等审批期间不计）
export const DEFAULT_WORKER_STALL_MS = 10 * 60_000;
// 决策 303：worker 的审批请求等这么久无人批即作为可恢复错误交回
export const DEFAULT_WORKER_APPROVAL_TIMEOUT_MS = 5 * 60_000;
// 决策 298（验收修订）：自带超时的工具——执行期间（提出到结束）卡住监控暂停计时，由工具自己的超时兜底；其余工具照常计时
export const DEFAULT_SELF_TIMED_TOOLS: readonly string[] = [
  "run_command",
  "web_search",
  "web_fetch",
];
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
  // 收尾钩子的输出（决策 322：SubagentStop 的拦截理由与补充上下文，逐轮累计；多份尝试的汇总随结果交回）
  hookOutputs?: string[];
}

// 派出方的派出与收尾落盘口（装配根接到派出方会话的会话存储）
export interface ChildFamilySink {
  appendChildSpawned(input: ChildSpawnedInput): unknown;
  appendChildSettled(input: ChildSettledInput): unknown;
}

// 装配根交回的 worker 运行面（PiRuntimeAdapter + 会话文件的最小操作面）
export interface WorkerRuntimeHandle {
  // runId：本次运行的 Run（运行面装起来并真正开跑时在场）；撞上限记录据此落在被中止的那次 Run 上
  // emptyReply：空回复异常结束（决策 170 ②；运行面给出，此时 status 为 failed）
  run(task: string): Promise<WorkerRunResult>;
  // 撞上限时带上原因（决策 182：运行面据此把 Run 收尾的结束方式一次写全）；取消与外部中止不带
  interrupt(cause?: RunStopCause): Promise<void>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  // 决策 305：整轮观察口（一轮的工具调用与返回结果）；不实现即观察者拿不到整轮，打转检测对这个 worker 不起作用
  subscribeRounds?(listener: (round: LoopRound & { runId: RunId }) => void): () => void;
  // 末条 assistant 正文
  summary(): string;
  // M6（决策 064）：模型交回的结构化内容（末条 assistant 正文能解析成对象时在场）；
  // 不实现即视为没有结构化结果，既有 worker 行为不变
  structured?(): unknown;
  // M7（决策 077 / 079）：从已有消息续跑（分叉续跑）；不实现即不支持
  continueRun?(): Promise<WorkerRunResult>;
  // 决策 294、297：给在跑的 worker 递一段话，进它的下一轮；不实现即不支持发消息
  // 返回撤回与查询用的键；noticeDelivered / withdrawNotice 用它查是否已进对话、撤回还没递出的
  notify?(text: string): string | undefined;
  noticeDelivered?(key: string): boolean;
  withdrawNotice?(key: string): boolean;
  // 决策 324：运行面就绪（MCP 启动可能异步）——入口层在第一条输入之前跑 SessionStart 等钩子用。
  // 返回类型在编排层不指明（application 层的 RuntimeBundle 依赖本层，不能反向引用）：由 application 装配方收窄。
  // 不实现即运行面同步就绪（调用方自行从 onBundle 拿）
  ready?(): Promise<unknown>;
  // 决策 298：会话记录位置（worker 会话文件的路径）；不实现即结果里不带
  transcript?(): Promise<string | undefined>;
  // 决策 299：本 worker 再派出时的落盘口（它自己的会话存储）；不实现即不能作派出方
  childLog?(): ChildFamilySink | undefined;
  // 决策 301：只读观察口——流式正文增量与工具结果（界面实时显示 worker 的对话）；不实现即只有运行事件
  subscribeStream?(listener: (delta: WorkerStreamDelta) => void): () => void;
  subscribeToolResults?(listener: (result: WorkerToolResult) => void): () => void;
  // 释放运行面并关闭 worker 会话文件
  dispose(): Promise<void>;
}

// 决策 301：worker 的流式正文增量（与运行面的流式观察口同形）
export interface WorkerStreamDelta {
  runId: RunId;
  kind: "text" | "thinking";
  delta: string;
}

// 决策 301：worker 的工具结果（与运行面的工具结果观察口同形）
export interface WorkerToolResult {
  runId: RunId;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
  details: unknown;
}

// 汇聚到派出方的审批请求：来源会话与 worker 标签恒在场
export interface WorkerApprovalRequest extends ApprovalRequest {
  readonly sessionId: SessionId;
  readonly worker: { readonly name: string; readonly role: WorkerRole; readonly label?: string };
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
  // 决策 299：本 worker 所在层（主会话派出的为 1）；装配层据此决定它能不能再派（层数未满才给派出的工具）
  depth?: number;
  // 决策 303：补批续做——装配层按已有会话文件还原对话再装运行面（同一个会话号、同一个工作树）
  resume?: boolean;
}

export type WorkerRuntimeFactory = (request: WorkerRuntimeRequest) => WorkerRuntimeHandle;

// 决策 279：worker 的起点——主工作目录连同未提交改动拍成的快照（没有未提交改动时就是 HEAD）。
// 由装配根注入（快照的做法在执行层，本层不触达），派出时记进工作区形状的 baseCommit 与派出记录
export interface WorkerStartPoint {
  // 起点提交：快照提交或 HEAD
  commit: string;
  // 是否另拍了快照（有未提交改动）
  snapshot: boolean;
  // 快照带入的未提交文件（仓库相对路径）；没有快照时为空
  files: string[];
}

// release：起点的引用只需护住"拍好快照到建好工作树"这一段——worker 分支建好即指向起点提交，提交不会被回收；
// 编排器在建工作区之后（成败都）调用它，由提供者删掉单独的引用（决策 279 修订）。
// from：派出方是 worker 时（决策 299）为它的工作树路径，起点拍它的工作树；缺省拍主工作目录
export type WorkerStartPointProvider = (input: {
  sessionId: SessionId;
  name: string;
  role: WorkerRole;
  from?: string;
}) => WorkerStartPoint & { release?: () => void };

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

// 仓库根与治理根分开传（M6.5 S2）：工作树与分支建在仓库根上，目录放在治理根的 .pigeon/state/worktrees 下。
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

// 谁派出的：主 agent 的工具（agent）、人的命令（human）、程序直接调用（program）。完成通知只发给 agent 派出的
export type WorkerOrigin = "agent" | "human" | "program";

// 生命周期事件里的 worker 身份（决策 294：标签原样带回）
export interface WorkerRef {
  sessionId: SessionId;
  name: string;
  role: WorkerRole;
  label?: string;
  origin: WorkerOrigin;
  // 所在层：主会话派出的为 1
  depth: number;
  // 派出方会话（主会话或上一层 worker）
  parentSessionId: SessionId;
  // 决策 312：脚本编排派出的（运行号与指纹）
  script?: ScriptSpawnTag;
}

// 决策 294：worker 生命周期统一发的事件——派出（进队或直接开跑）、开跑、需请示被搁下、收尾（带结构化结果）、续做
export type WorkerLifecycleEvent =
  | { kind: "worker.spawned"; worker: WorkerRef; queued: boolean; at: number }
  | { kind: "worker.started"; worker: WorkerRef; at: number }
  | {
      kind: "worker.blocked";
      worker: WorkerRef;
      errorKind: "approval-timeout" | "approval-unattended";
      action: string;
      at: number;
    }
  | { kind: "worker.settled"; worker: WorkerRef; outcome: WorkerOutcome; at: number }
  | { kind: "worker.resumed"; worker: WorkerRef; approved: boolean; at: number };

// 决策 301：观察口交出的一条 worker 活动——运行事件、流式正文增量或工具结果，带 worker 身份
export type WorkerActivity =
  | { kind: "event"; worker: WorkerRef; event: EventEnvelope }
  | { kind: "delta"; worker: WorkerRef; delta: WorkerStreamDelta }
  | { kind: "tool-result"; worker: WorkerRef; result: WorkerToolResult };

// 决策 303：补批续做时交给 worker 的话（界面在人另附的话前面同样用它）
export function resumeApprovalText(action: string): string {
  return `人已批准你之前等待审批的调用（${action}）。请重新发起这个调用，然后接着完成任务。`;
}

// 决策 298 与 293 的接入点：观察 worker 的运行事件，需要时叫停它。打转检测（305–307）以观察者接入：
// 工厂另拿到 worker 的运行面，经它的整轮观察口判定、经通知递提醒
export interface WorkerWatcherControl {
  // 叫停：worker 以失败收尾，错误类型与原因照给出的记
  stop(errorKind: WorkerErrorKind, message: string): void;
}

export interface WorkerWatcher {
  observe(event: EventEnvelope): void;
  dispose?(): void;
}

export type WorkerWatcherFactory = (
  worker: WorkerRef,
  control: WorkerWatcherControl,
  runtime: WorkerRuntimeHandle
) => WorkerWatcher;

export interface WorkerOrchestratorOptions {
  governanceRoot: string;
  // 本编排器所在会话；parentSessionId 在场 = 本会话自己是 worker（depth 缺省即 1，否则 0）
  session: { sessionId: SessionId; parentSessionId?: SessionId; depth?: number };
  parentPolicy: ToolPolicyLike;
  parentLog: ChildFamilySink;
  createRuntime: WorkerRuntimeFactory;
  approvals: (request: WorkerApprovalRequest) => Promise<ApprovalDecision>;
  // 派出时父会话的活动 Run（人以 /spawn 派出时无）
  activeRunId?: () => RunId | undefined;
  // 决策 300：同时在跑的 worker 上限（缺省 8）；多派的排队
  maxConcurrent?: number;
  // 决策 299：最多几层（缺省 1）
  maxDepth?: number;
  // 决策 298：卡住判定的时长（缺省 10 分钟）
  stallMs?: number;
  // 自带超时的工具名（缺省 DEFAULT_SELF_TIMED_TOOLS）：执行期间卡住监控暂停
  selfTimedTools?: readonly string[];
  // 决策 303：审批请求的等待时限（缺省 5 分钟）
  approvalTimeoutMs?: number;
  // 决策 303：无人值守（pigeon run）——worker 需请示时不等，直接作为可恢复错误交回
  unattended?: boolean;
  // 决策 293 的接入点：每个 worker 开跑时各建一份观察者
  watchers?: readonly WorkerWatcherFactory[];
  // 决策 268：worker 每收尾一轮回报本轮用的 token（计入本次运行的总额度）
  onWorkerTokens?: (sessionId: SessionId, tokens: number) => void;
  workspaces?: WorkspaceProvider;
  // 决策 279：worker 的起点（主工作目录的快照）；缺省不给 = 工作区提供者自己的缺省（git 工作树为 HEAD）
  startPoint?: WorkerStartPointProvider;
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
  // 决策 294：标签，原样写进派出记录并在各事件与结果里带回
  label?: string;
  // 缺省 program（程序直接调用）；工具与命令各自标明
  origin?: WorkerOrigin;
  // 决策 299：派出方是 worker 时为它的会话号（缺省 = 本编排器所在会话）
  from?: SessionId;
  // 决策 311：另给起点——point 为脚本整次共用的主目录快照（直接用，不另拍）；from 为接力的上游 worker 的工作树（拍它开工）。
  // 缺省照 279 拍主工作目录（或派出方 worker 的工作树）
  start?: { point: WorkerStartPoint } | { from: string };
  // 决策 312：脚本编排派出的调用——运行号、指纹与接力的上游，写进派出与收尾条目
  script?: ScriptSpawnTag;
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
  // 决策 279：起点（注入了起点提供者时在场）
  start?: WorkerStartPoint;
  label?: string;
  // 以下三项编排器恒给（替身构造的状态可缺）
  origin?: WorkerOrigin;
  depth?: number;
  parentSessionId?: SessionId;
  // 决策 312：脚本编排派出的在场
  script?: ScriptSpawnTag;
  // 已收尾的在场：结构化结果
  outcome?: WorkerOutcome;
  // 续接时从会话记录重建的、之前的运行派出的 worker（权威链审计 ②）：settled 为之前的运行中已收尾，
  // interrupted 为只有派出、没有收尾（随上次进程退出而中断）。只供查询与取用，不在本进程运行、不占并发额度
  previousRun?: "settled" | "interrupted";
}

// 对之前运行的 worker 发取消、发消息、补批续做时的说明（不报"找不到"）
export function previousRunWorkerText(
  status: Pick<WorkerStatus, "name" | "previousRun">,
  action: "cancel" | "send" | "resume"
): string {
  const base =
    status.previousRun === "interrupted"
      ? `worker ${status.name} 是之前的运行派出的，随上次进程退出而中断`
      : `worker ${status.name} 是之前的运行派出的，已在之前的运行中收尾`;
  switch (action) {
    case "cancel":
      return `${base}，不在运行，无需取消。`;
    case "send":
      return `${base}，不在运行，收不到消息。`;
    case "resume":
      return `${base}；续接后不能对它补批续做，要接着做请另派一个 worker。`;
  }
}

// 决策 303：搁下的请示——补批续做时据此放行同一个调用
export interface BlockedApproval {
  errorKind: "approval-timeout" | "approval-unattended";
  toolName: string;
  args: unknown;
  // 人读的动作描述
  action: string;
}

export interface WorkerOutcome {
  sessionId: SessionId;
  name: string;
  role: WorkerRole;
  status: ChildSettledStatus;
  error?: string;
  // 决策 298：错误类型（非完成时在场）
  errorKind?: WorkerErrorKind;
  // 可恢复：补批后能续做（决策 303）
  recoverable?: boolean;
  blocked?: BlockedApproval;
  turns: number;
  result?: ChildResult;
  workspace: WorkerWorkspace;
  // 决策 279：起点（注入了起点提供者时在场）
  start?: WorkerStartPoint;
  label?: string;
  // 编排器恒给（替身构造的结果可缺）
  origin?: WorkerOrigin;
  // 决策 298：会话记录位置（运行面给出时在场）
  transcript?: string;
  // 收尾钩子的输出（SubagentStop 的拦截理由与补充上下文，逐轮累计；322：多份尝试交回各份的钩子输出）
  hookOutputs?: string[];
  durationMs?: number;
}

// 决策 294 ③：等待的结果——已收尾的结构化结果与仍在跑的状态
export interface WaitResult {
  settled: WorkerOutcome[];
  pending: WorkerStatus[];
  timedOut: boolean;
}

interface WorkerEntry {
  sessionId: SessionId;
  name: string;
  role: WorkerRole;
  task: string;
  policy: DelegatedPolicy;
  limits: WorkerLimits;
  workspace: WorkerWorkspace;
  start?: WorkerStartPoint;
  label?: string;
  origin: WorkerOrigin;
  depth: number;
  parentSessionId: SessionId;
  parentRunId?: RunId;
  parentLog: ChildFamilySink;
  script?: ScriptSpawnTag;
  runtime: WorkerRuntimeHandle;
  state: WorkerState;
  turns: number;
  startedAt: number;
  cancelRequested: boolean;
  limitHit?: "turn-limit" | "wall-clock-limit" | "token-limit";
  // 卡住监控或观察者叫停
  stopped?: { status: ChildSettledStatus; errorKind: WorkerErrorKind; message: string };
  blocked?: BlockedApproval;
  // 补批续做时放行的一次调用
  preApproved?: { toolName: string; args: string };
  pendingApprovals: number;
  // 占着一个空位（在跑且没有借出）
  holdsSlot: boolean;
  tokens: number;
  outcome?: WorkerOutcome;
  done: Promise<WorkerOutcome>;
}

function refOf(entry: WorkerEntry): WorkerRef {
  return {
    sessionId: entry.sessionId,
    name: entry.name,
    role: entry.role,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    origin: entry.origin,
    depth: entry.depth,
    parentSessionId: entry.parentSessionId,
    ...(entry.script !== undefined ? { script: entry.script } : {}),
  };
}

// 请示的人读描述：命令档写命令串，网络档写网站，其余写工具与路径
function describeAction(request: ApprovalRequest): string {
  const args = request.args as { command?: unknown; path?: unknown } | undefined;
  if (request.command !== undefined) {
    return `跑命令 ${request.command}`;
  }
  if (typeof args?.command === "string") {
    return `跑命令 ${args.command}`;
  }
  if (request.host !== undefined) {
    return `访问网站 ${request.host}`;
  }
  if (typeof args?.path === "string") {
    return `用 ${request.toolName} 处理 ${args.path}`;
  }
  return `调用 ${request.toolName}`;
}

function argsKey(args: unknown): string {
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "";
  }
}

export class WorkerOrchestrator {
  readonly #options: WorkerOrchestratorOptions;
  readonly #workspaces: WorkspaceProvider;
  readonly #now: () => number;
  readonly #depth: number;
  readonly #maxConcurrent: number;
  readonly #maxDepth: number;
  readonly #workers = new Map<SessionId, WorkerEntry>();
  // 续接时从会话记录重建的之前运行的 worker（只读：不运行、不占空位）
  readonly #previous = new Map<SessionId, WorkerStatus>();
  // 等空位的：按先后开跑（排队的 worker 与借出空位后要收回的等待方）
  readonly #queue: Array<{ key: SessionId; start: () => void }> = [];
  #running = 0;
  readonly #listeners = new Set<(event: WorkerLifecycleEvent) => void>();
  // 决策 301：worker 活动的观察者（界面）
  readonly #observers = new Set<(activity: WorkerActivity) => void>();
  // 其中只看运行事件的
  readonly #eventsOnly = new Set<(activity: WorkerActivity) => void>();
  // 不改变结果的内部故障（settled 写盘失败、结果回收失败等）
  readonly #errors: unknown[] = [];

  constructor(options: WorkerOrchestratorOptions) {
    const max = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_WORKERS;
    if (!Number.isInteger(max) || max < 1) {
      throw new WorkerSpawnError(`同时在跑的 worker 上限需要正整数：${max}`);
    }
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_WORKER_DEPTH;
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new WorkerSpawnError(`worker 层数上限需要正整数：${maxDepth}`);
    }
    this.#options = options;
    this.#maxConcurrent = max;
    this.#maxDepth = maxDepth;
    this.#depth = options.session.depth ?? (options.session.parentSessionId !== undefined ? 1 : 0);
    this.#workspaces =
      options.workspaces ??
      gitWorktreeWorkspaces({
        repoRoot: options.governanceRoot,
        governanceRoot: options.governanceRoot,
      });
    this.#now = options.now ?? Date.now;
  }

  get maxConcurrent(): number {
    return this.#maxConcurrent;
  }

  get maxDepth(): number {
    return this.#maxDepth;
  }

  // 决策 294 ②：订阅生命周期事件；监听器抛错只进内部故障清单
  subscribe(listener: (event: WorkerLifecycleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // 决策 301：观察各 worker 的运行事件、流式正文与工具结果（只读）；观察者抛错只进内部故障清单。
  // 在 worker 开跑之前订阅才看得到它的流式正文与工具结果（界面在绑定会话时即订阅）
  // eventsOnly：只看运行事件（脚本编排按轮次计花费），不因此订阅流式正文与工具结果（pigeon run 的行为不变）
  observe(
    listener: (activity: WorkerActivity) => void,
    options: { eventsOnly?: boolean } = {}
  ): () => void {
    this.#observers.add(listener);
    if (options.eventsOnly === true) this.#eventsOnly.add(listener);
    return () => {
      this.#observers.delete(listener);
      this.#eventsOnly.delete(listener);
    };
  }

  // 派出方为 from 时能否再派（层数未满）
  canSpawnFrom(from?: SessionId): boolean {
    return this.#depthOf(from) + 1 <= this.#maxDepth;
  }

  spawn(request: SpawnRequest): SessionId {
    const { session } = this.#options;
    const fromEntry = request.from !== undefined ? this.#require(request.from) : undefined;
    const depth = this.#depthOf(request.from) + 1;
    if (depth > this.#maxDepth) {
      throw new WorkerDepthError(
        this.#maxDepth === 1
          ? "深度 1：worker 会话不能再派 worker"
          : `层数已满（最多 ${this.#maxDepth} 层）：这一层的 worker 不能再派 worker`
      );
    }
    const parentLog =
      fromEntry !== undefined ? fromEntry.runtime.childLog?.() : this.#options.parentLog;
    if (parentLog === undefined) {
      throw new WorkerSpawnError(`worker ${fromEntry?.name ?? ""} 不能作派出方（没有落盘口）`);
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
    if (
      [...this.#workers.values(), ...this.#previous.values()].some((worker) => worker.name === name)
    ) {
      throw new WorkerSpawnError(`worker 名已被占用：${name}`);
    }
    const basePolicy = fromEntry !== undefined ? fromEntry.policy : this.#options.parentPolicy;
    const policy = deriveWorkerPolicy(basePolicy, role, { orchestration: depth < this.#maxDepth });
    assertPolicySubset(policy, basePolicy);
    const limits: WorkerLimits = {
      ...DEFAULT_WORKER_LIMITS,
      ...this.#options.defaultLimits,
      ...request.limits,
    };
    const sessionId = newSessionId();
    const label =
      request.label !== undefined && request.label.trim() !== "" ? request.label.trim() : undefined;
    // 决策 279：先拍工作目录的快照当起点（拍不成即不派：没有派出记录、零工作区零运行面）
    let startPoint: WorkerStartPoint | undefined;
    let releaseStart: (() => void) | undefined;
    const given = request.start;
    if (given !== undefined && "point" in given) {
      // 决策 311：脚本整次共用的快照，引用由脚本持有到收回或放弃
      startPoint = given.point;
    } else if (given !== undefined && this.#options.startPoint === undefined) {
      throw new WorkerSpawnError(`派出 worker ${name} 失败：没有起点提供者，不能接力开工`);
    } else if (this.#options.startPoint !== undefined) {
      try {
        const from =
          given !== undefined
            ? given.from
            : fromEntry?.workspace.kind === "git-worktree"
              ? fromEntry.workspace.path
              : undefined;
        const { release, ...point } = this.#options.startPoint({
          sessionId,
          name,
          role,
          ...(from !== undefined ? { from } : {}),
        });
        startPoint = point;
        releaseStart = release;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new WorkerSpawnError(`派出 worker ${name} 失败：拍工作目录快照失败：${message}`, {
          cause: error,
        });
      }
    }
    const planned = this.#workspaces.plan({ sessionId, name, role });
    const workspace: WorkerWorkspace =
      planned.kind === "git-worktree" && startPoint !== undefined
        ? { ...planned, baseCommit: startPoint.commit }
        : planned;
    const parentSessionId = fromEntry?.sessionId ?? session.sessionId;
    const parentRunId = fromEntry === undefined ? this.#options.activeRunId?.() : undefined;
    // 派出意图先落盘：写不进就不派（异常原样上抛，零工作区零运行面）
    parentLog.appendChildSpawned({
      childSessionId: sessionId,
      name,
      role,
      task,
      ...(request.taskKey !== undefined ? { taskKey: request.taskKey } : {}),
      ...(label !== undefined ? { label } : {}),
      policy,
      limits,
      workspace,
      spawnedAt: this.#now(),
      ...(parentRunId !== undefined ? { runId: parentRunId } : {}),
      ...(request.script !== undefined ? { script: request.script } : {}),
    });
    let runtime: WorkerRuntimeHandle;
    try {
      this.#workspaces.create(workspace, {
        sessionId,
        name,
        role,
        ...(startPoint !== undefined ? { baseRef: startPoint.commit } : {}),
      });
      this.#releaseStart(releaseStart);
      releaseStart = undefined;
      runtime = this.#createRuntime({
        sessionId,
        name,
        role,
        task,
        policy,
        workspace,
        parentSessionId,
        ...(parentRunId !== undefined ? { parentRunId } : {}),
        limits,
        depth,
        ...(label !== undefined ? { label } : {}),
        ...(request.script !== undefined ? { script: request.script } : {}),
        resume: false,
      });
    } catch (error) {
      this.#releaseStart(releaseStart);
      const message = error instanceof Error ? error.message : String(error);
      this.#appendSettled(parentLog, {
        childSessionId: sessionId,
        name,
        status: "spawn-failed",
        error: message,
        errorKind: "spawn-failed",
        turns: 0,
        ...(request.script !== undefined
          ? {
              script: { runId: request.script.runId, fingerprint: request.script.fingerprint },
            }
          : {}),
      });
      throw new WorkerSpawnError(`派出 worker ${name} 失败：${message}`, { cause: error });
    }
    const entry: WorkerEntry = {
      sessionId,
      name,
      role,
      task,
      policy,
      limits,
      workspace,
      ...(startPoint !== undefined ? { start: startPoint } : {}),
      ...(label !== undefined ? { label } : {}),
      origin: request.origin ?? "program",
      depth,
      parentSessionId,
      ...(parentRunId !== undefined ? { parentRunId } : {}),
      parentLog,
      ...(request.script !== undefined ? { script: request.script } : {}),
      runtime,
      state: "queued",
      turns: 0,
      startedAt: this.#now(),
      cancelRequested: false,
      pendingApprovals: 0,
      holdsSlot: false,
      tokens: 0,
      done: Promise.resolve() as unknown as Promise<WorkerOutcome>,
    };
    this.#workers.set(sessionId, entry);
    this.#launch(entry, task);
    return sessionId;
  }

  // 续接时登记之前运行的 worker（权威链审计 ②）：查询状态、等结果与取用照常可用；不运行、不计入同时在跑的上限，
  // 取消、发消息、补批续做给出明确说明。与本进程派出的同号即不登记
  restorePrevious(workers: readonly WorkerStatus[]): void {
    for (const worker of workers) {
      if (worker.previousRun === undefined || this.#workers.has(worker.sessionId)) continue;
      this.#previous.set(worker.sessionId, worker);
    }
  }

  // 取消走 interrupt（abort → waitForIdle）；排队中的直接出队、不开跑；已收尾的 worker 无操作
  async cancel(sessionId: SessionId): Promise<void> {
    this.#rejectPrevious(sessionId, "cancel");
    const entry = this.#require(sessionId);
    if (entry.state !== "running" && entry.state !== "queued") {
      return;
    }
    entry.cancelRequested = true;
    const queued = this.#queue.findIndex((item) => item.key === sessionId);
    if (queued >= 0) {
      const [item] = this.#queue.splice(queued, 1);
      // 出队的 worker 不占空位：先记一个再由收尾释放，账目对平
      this.#running += 1;
      entry.holdsSlot = true;
      item?.start();
      return;
    }
    await entry.runtime.interrupt();
  }

  status(): WorkerStatus[] {
    return [
      ...this.#previous.values(),
      ...[...this.#workers.values()].map((entry) => this.#statusOf(entry)),
    ];
  }

  awaitResult(sessionId: SessionId): Promise<WorkerOutcome> {
    const previous = this.#previous.get(sessionId)?.outcome;
    if (previous !== undefined) return Promise.resolve(previous);
    return this.#require(sessionId).done;
  }

  // 决策 297：等任一或全部指定 worker 收尾，带超时；已收尾的立即交回。waiter 为在跑的 worker（嵌套时的派出方）时，
  // 等待期间把它的空位借出，等完再收回（收回时没有空位即排队）
  async wait(
    sessionIds: readonly SessionId[],
    options: { mode: "any" | "all"; timeoutMs: number; signal?: AbortSignal; waiter?: SessionId }
  ): Promise<WaitResult> {
    // 之前运行的 worker 已是定局：结果立即交回，其余照常等
    const previous = sessionIds.flatMap((id) => {
      const outcome = this.#previous.get(id)?.outcome;
      return outcome !== undefined ? [outcome] : [];
    });
    if (previous.length > 0) {
      const live = sessionIds.filter((id) => !this.#previous.has(id));
      const rest =
        options.mode === "any" || live.length === 0
          ? {
              settled: [],
              pending: live.map((id) => this.#statusOf(this.#require(id))),
              timedOut: false,
            }
          : await this.wait(live, options);
      return {
        settled: [...previous, ...rest.settled],
        pending: rest.pending,
        timedOut: rest.timedOut,
      };
    }
    const entries = sessionIds.map((id) => this.#require(id));
    const settledNow = entries.filter((entry) => entry.outcome !== undefined);
    const alreadyDone =
      entries.length === 0 ||
      (options.mode === "any" ? settledNow.length > 0 : settledNow.length === entries.length);
    if (!alreadyDone) {
      const lender = options.waiter !== undefined ? this.#workers.get(options.waiter) : undefined;
      const lent = lender?.holdsSlot === true;
      if (lent && lender !== undefined) {
        lender.holdsSlot = false;
        this.#release();
      }
      try {
        const dones = entries.map((entry) => entry.done.then(() => undefined));
        const target = options.mode === "any" ? Promise.race(dones) : Promise.all(dones);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        await Promise.race([
          target,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, options.timeoutMs));
          }),
          new Promise<void>((resolve) => {
            if (options.signal === undefined) return;
            onAbort = resolve;
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        clearTimeout(timer);
        if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
      } finally {
        if (lent && lender !== undefined) {
          await this.#acquire(lender.sessionId);
          // 等待期间 worker 已收尾（被取消等）：收回的空位随即让出
          if (lender.state === "running") {
            lender.holdsSlot = true;
          } else {
            this.#release();
          }
        }
      }
    }
    const settled = entries.flatMap((entry) =>
      entry.outcome !== undefined ? [entry.outcome] : []
    );
    const pending = entries
      .filter((entry) => entry.outcome === undefined)
      .map((entry) => this.#statusOf(entry));
    const timedOut =
      entries.length > 0 &&
      (options.mode === "any" ? settled.length === 0 : pending.length > 0) &&
      options.signal?.aborted !== true;
    return { settled, pending, timedOut };
  }

  // 决策 294、297：给在跑的 worker 递一段话，进它的下一轮
  // 交回是否送达：进了它的下一轮为 delivered；它在那之前结束（最后一轮之后才递到、正在收尾）为 undelivered，没递出的撤回，
  // 不静默丢掉（验收修订）。运行面不支持查询送达的，递出即按 delivered
  send(sessionId: SessionId, text: string): Promise<"delivered" | "undelivered"> {
    this.#rejectPrevious(sessionId, "send");
    const entry = this.#require(sessionId);
    if (entry.state !== "running" && entry.state !== "queued") {
      throw new WorkerSpawnError(`worker ${entry.name} 已收尾，收不到消息`);
    }
    const runtime = entry.runtime;
    if (runtime.notify === undefined) {
      throw new WorkerSpawnError(`worker ${entry.name} 的运行面不支持发消息`);
    }
    const key = runtime.notify(text);
    const delivered = runtime.noticeDelivered;
    if (key === undefined || delivered === undefined) {
      return Promise.resolve("delivered");
    }
    if (delivered.call(runtime, key)) {
      return Promise.resolve("delivered");
    }
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result: "delivered" | "undelivered"): void => {
        if (finished) return;
        finished = true;
        unsubscribe();
        resolve(result);
      };
      const unsubscribe = runtime.subscribe(() => {
        if (delivered.call(runtime, key)) finish("delivered");
      });
      entry.done.then(
        () => {
          if (finished) return;
          if (delivered.call(runtime, key)) {
            finish("delivered");
            return;
          }
          runtime.withdrawNotice?.(key);
          finish("undelivered");
        },
        () => finish("undelivered")
      );
    });
  }

  // 决策 303：补批续做——已收尾的 worker 回到同一个会话与工作树接着做。approve 为真且它是因请示搁下的，放行它重新发起的
  // 同一个调用（只放行一次）；message 为续做时交给它的话（缺省按是否补批给出）。重新占额度，收尾照常发事件、写收尾记录
  resume(sessionId: SessionId, options: { approve?: boolean; message?: string } = {}): void {
    this.#rejectPrevious(sessionId, "resume");
    const entry = this.#require(sessionId);
    if (entry.outcome === undefined) {
      throw new WorkerSpawnError(`worker ${entry.name} 还没收尾，不需要续做`);
    }
    const approve = options.approve === true && entry.blocked !== undefined;
    const blocked = entry.blocked;
    const text =
      options.message ??
      (approve && blocked !== undefined ? resumeApprovalText(blocked.action) : "请接着完成任务。");
    const runtime = this.#createRuntime({
      sessionId: entry.sessionId,
      name: entry.name,
      role: entry.role,
      task: entry.task,
      policy: entry.policy,
      workspace: entry.workspace,
      parentSessionId: entry.parentSessionId,
      ...(entry.parentRunId !== undefined ? { parentRunId: entry.parentRunId } : {}),
      limits: entry.limits,
      depth: entry.depth,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.script !== undefined ? { script: entry.script } : {}),
      resume: true,
    });
    entry.runtime = runtime;
    entry.state = "queued";
    entry.cancelRequested = false;
    delete entry.limitHit;
    delete entry.stopped;
    delete entry.blocked;
    delete entry.outcome;
    if (approve && blocked !== undefined) {
      entry.preApproved = { toolName: blocked.toolName, args: argsKey(blocked.args) };
    }
    this.#emit({
      kind: "worker.resumed",
      worker: refOf(entry),
      approved: approve,
      at: this.#now(),
    });
    this.#launch(entry, text);
  }

  errors(): unknown[] {
    return this.#errors.slice();
  }

  #depthOf(from?: SessionId): number {
    if (from === undefined) {
      return this.#depth;
    }
    return this.#require(from).depth;
  }

  #createRuntime(input: {
    sessionId: SessionId;
    name: string;
    role: WorkerRole;
    task: string;
    policy: DelegatedPolicy;
    workspace: WorkerWorkspace;
    parentSessionId: SessionId;
    parentRunId?: RunId;
    limits: WorkerLimits;
    depth: number;
    label?: string;
    script?: ScriptSpawnTag;
    resume: boolean;
  }): WorkerRuntimeHandle {
    const { sessionId, name, role, label, script } = input;
    return this.#options.createRuntime({
      sessionId,
      name,
      role,
      task: input.task,
      policy: input.policy,
      governanceRoot: this.#options.governanceRoot,
      workspace: input.workspace,
      lineage: {
        parentSessionId: input.parentSessionId,
        ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
      },
      approvalHandler: (approval) =>
        this.#approve({
          ...approval,
          sessionId,
          worker: { name, role, ...(label !== undefined ? { label } : {}) },
          // 决策 303（脚本部分）：脚本派出的 worker 的请求带上运行号，由装配方补上脚本名与同类
          ...(script !== undefined ? { script: { runId: script.runId } } : {}),
        }),
      limits: input.limits,
      depth: input.depth,
      ...(input.resume ? { resume: true } : {}),
    });
  }

  // 派出后开跑或排队：有空位即同步开跑（与不设上限时的行为一致）；否则按先后排队
  #launch(entry: WorkerEntry, input: string): void {
    const done = Promise.withResolvers<WorkerOutcome>();
    entry.done = done.promise;
    // 收尾的结果不被等待时也不报未处理拒绝
    done.promise.catch(() => {});
    const start = (): void => {
      entry.holdsSlot = true;
      this.#drive(entry, input)
        .finally(() => {
          if (entry.holdsSlot) {
            entry.holdsSlot = false;
            this.#release();
          }
        })
        .then(done.resolve, done.reject);
    };
    const immediate = this.#tryAcquire();
    this.#emit({
      kind: "worker.spawned",
      worker: refOf(entry),
      queued: !immediate,
      at: this.#now(),
    });
    if (immediate) {
      entry.state = "running";
      start();
    } else {
      this.#queue.push({ key: entry.sessionId, start });
    }
  }

  // 决策 303：审批汇到派出方——补批放行、无人值守即搁下、等满时限即搁下；等审批期间不计卡住
  async #approve(request: WorkerApprovalRequest): Promise<ApprovalDecision> {
    const entry = this.#workers.get(request.sessionId);
    if (entry === undefined) {
      return this.#options.approvals(request);
    }
    const pre = entry.preApproved;
    if (
      pre !== undefined &&
      pre.toolName === request.toolName &&
      pre.args === argsKey(request.args)
    ) {
      delete entry.preApproved;
      return { approved: true };
    }
    if (this.#options.unattended === true) {
      return this.#block(entry, request, "approval-unattended");
    }
    entry.pendingApprovals += 1;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(
          () => resolve("timeout"),
          this.#options.approvalTimeoutMs ?? DEFAULT_WORKER_APPROVAL_TIMEOUT_MS
        );
      });
      const decided = this.#options.approvals({ ...request, signal: controller.signal });
      const winner = await Promise.race([decided, timeout]);
      if (winner === "timeout") {
        controller.abort();
        decided.catch(() => {});
        return this.#block(entry, request, "approval-timeout");
      }
      return winner;
    } finally {
      clearTimeout(timer);
      entry.pendingApprovals -= 1;
    }
  }

  // 请示搁下：拒绝这次调用并叫停 worker，收尾时以可恢复的失败交回
  #block(
    entry: WorkerEntry,
    request: WorkerApprovalRequest,
    errorKind: BlockedApproval["errorKind"]
  ): ApprovalDecision {
    const action = describeAction(request);
    if (entry.blocked === undefined) {
      entry.blocked = { errorKind, toolName: request.toolName, args: request.args, action };
      this.#emit({
        kind: "worker.blocked",
        worker: refOf(entry),
        errorKind,
        action,
        at: this.#now(),
      });
      entry.runtime.interrupt().catch((error: unknown) => {
        this.#errors.push(error);
      });
    }
    return {
      approved: false,
      reason:
        errorKind === "approval-unattended"
          ? "无人值守运行没有人审批，worker 停在这里等人补批"
          : "等待审批超时，worker 停在这里等人补批",
      reasonSource: "system-default",
    };
  }

  #statusOf(entry: WorkerEntry): WorkerStatus {
    return {
      sessionId: entry.sessionId,
      name: entry.name,
      role: entry.role,
      state: entry.state,
      turns: entry.turns,
      ...(entry.workspace.kind === "git-worktree" ? { branch: entry.workspace.branch } : {}),
      startedAt: entry.startedAt,
      workspace: entry.workspace,
      ...(entry.start !== undefined ? { start: entry.start } : {}),
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      origin: entry.origin,
      depth: entry.depth,
      parentSessionId: entry.parentSessionId,
      ...(entry.script !== undefined ? { script: entry.script } : {}),
      ...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
    };
  }

  #observe(activity: WorkerActivity): void {
    for (const observer of this.#observers) {
      if (activity.kind !== "event" && this.#eventsOnly.has(observer)) continue;
      try {
        observer(activity);
      } catch (error) {
        this.#errors.push(error);
      }
    }
  }

  #emit(event: WorkerLifecycleEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#errors.push(error);
      }
    }
  }

  // 占一个空位：有空位即占下
  #tryAcquire(): boolean {
    if (this.#running < this.#maxConcurrent) {
      this.#running += 1;
      return true;
    }
    return false;
  }

  // 等到占上一个空位（排在队尾）
  #acquire(key: SessionId): Promise<void> {
    if (this.#tryAcquire()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#queue.push({ key, start: resolve });
    });
  }

  // 让出空位：队首的接着开跑（空位直接转交，计数不变）
  #release(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      next.start();
      return;
    }
    this.#running -= 1;
  }

  async #drive(entry: WorkerEntry, input: string): Promise<WorkerOutcome> {
    const { runtime, limits } = entry;
    // 排队期间被取消：不开跑，按取消收尾（结果回收与释放照常）
    const skipRun = entry.cancelRequested;
    const runStartedAt = this.#now();
    if (!skipRun) {
      entry.state = "running";
      entry.startedAt = runStartedAt;
      this.#emit({ kind: "worker.started", worker: refOf(entry), at: runStartedAt });
    }
    const stop = (reason: "turn-limit" | "wall-clock-limit" | "token-limit") => {
      if (entry.limitHit !== undefined || entry.cancelRequested || entry.stopped !== undefined) {
        return;
      }
      entry.limitHit = reason;
      // 只发中止请求；撞上限记录等运行确以中止收尾后再写（072 修订）
      runtime.interrupt(reason).catch((error: unknown) => {
        this.#errors.push(error);
      });
    };
    // 卡住监控与观察者的叫停：以失败（卡住为 stalled）收尾
    const halt = (status: ChildSettledStatus, errorKind: WorkerErrorKind, message: string) => {
      if (entry.limitHit !== undefined || entry.cancelRequested || entry.stopped !== undefined) {
        return;
      }
      entry.stopped = { status, errorKind, message };
      // 打转叫停把原因交给运行面：worker 会话的 Run 收尾记结束方式为打转（307）；其余叫停照旧记为中止
      runtime.interrupt(errorKind === "looping" ? "looping" : undefined).catch((error: unknown) => {
        this.#errors.push(error);
      });
    };
    const stallMs = this.#options.stallMs ?? DEFAULT_WORKER_STALL_MS;
    const selfTimed = new Set(this.#options.selfTimedTools ?? DEFAULT_SELF_TIMED_TOOLS);
    // 正在执行的自带超时的工具调用（提出到结束）
    const timedCalls = new Set<string>();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = (): void => {
      clearTimeout(stallTimer);
      if (skipRun) return;
      stallTimer = setTimeout(() => {
        // 等审批、自带超时的工具执行中都不算卡住：顺延
        if (entry.pendingApprovals > 0 || timedCalls.size > 0) {
          armStall();
          return;
        }
        halt(
          "stalled",
          "stalled",
          `${Math.round(stallMs / 60_000)} 分钟没有新的模型回复或工具结果`
        );
      }, stallMs);
      stallTimer.unref?.();
    };
    const control: WorkerWatcherControl = {
      stop: (errorKind, message) => halt("failed", errorKind, message),
    };
    const watchers = skipRun
      ? []
      : (this.#options.watchers ?? []).flatMap((factory) => {
          try {
            return [factory(refOf(entry), control, runtime)];
          } catch (error) {
            this.#errors.push(error);
            return [];
          }
        });
    const unsubscribe = runtime.subscribe((event) => {
      if (event.kind === "tool.proposed" || event.kind === "tool.settled") {
        const payload = event.payload as { toolCallId?: string; toolName?: string } | undefined;
        if (payload?.toolCallId !== undefined && selfTimed.has(payload.toolName ?? "")) {
          if (event.kind === "tool.proposed") timedCalls.add(payload.toolCallId);
          else timedCalls.delete(payload.toolCallId);
        }
      }
      armStall();
      for (const watcher of watchers) {
        try {
          watcher.observe(event);
        } catch (error) {
          this.#errors.push(error);
        }
      }
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
      // 决策 301：轮数记好之后再交给观察者（界面读到的状态与事件一致）
      if (this.#observers.size > 0) {
        this.#observe({ kind: "event", worker: refOf(entry), event });
      }
    });
    // 决策 301：有观察者时另订流式正文与工具结果；没有观察者即不订（pigeon run 与跑批不变）
    const observed: Array<() => void> = [];
    if (!skipRun && this.#observers.size > this.#eventsOnly.size) {
      const ref = refOf(entry);
      const unsubscribeStream = runtime.subscribeStream?.((delta) =>
        this.#observe({ kind: "delta", worker: ref, delta })
      );
      if (unsubscribeStream !== undefined) observed.push(unsubscribeStream);
      const unsubscribeResults = runtime.subscribeToolResults?.((result) =>
        this.#observe({ kind: "tool-result", worker: ref, result })
      );
      if (unsubscribeResults !== undefined) observed.push(unsubscribeResults);
    }
    armStall();
    const timer = skipRun
      ? undefined
      : setTimeout(() => stop("wall-clock-limit"), limits.wallClockMs);
    let status: ChildSettledStatus;
    let error: string | undefined;
    let errorKind: WorkerErrorKind | undefined;
    let hookOutputs: string[] | undefined;
    try {
      const run: WorkerRunResult = skipRun ? { status: "aborted" } : await runtime.run(input);
      hookOutputs = run.hookOutputs;
      if (run.status === "completed") {
        status = "completed";
      } else if (run.status === "aborted") {
        // 上限中止在运行终态上只表现为中止；撞上限的原因随中止请求交给运行面，由 Run 收尾条目记下（072 修订）
        status = entry.cancelRequested
          ? "cancelled"
          : (entry.stopped?.status ?? entry.limitHit ?? "aborted");
      } else {
        status = "failed";
        error = run.errorMessage ?? "运行以未知终态结束";
        errorKind = run.emptyReply === true ? "empty-reply" : "run-failed";
      }
    } catch (caught) {
      status = "failed";
      error = caught instanceof Error ? caught.message : String(caught);
      errorKind = "exception";
    } finally {
      clearTimeout(timer);
      clearTimeout(stallTimer);
      unsubscribe();
      for (const dispose of observed) dispose();
      for (const watcher of watchers) {
        try {
          watcher.dispose?.();
        } catch (caught) {
          this.#errors.push(caught);
        }
      }
    }
    // 叫停的原因压过运行自身的终态（请示搁下时模型可能已就着拒绝收尾）
    if (entry.blocked !== undefined && !entry.cancelRequested) {
      status = "failed";
      errorKind = entry.blocked.errorKind;
      error = `${entry.blocked.action}：${
        entry.blocked.errorKind === "approval-unattended"
          ? "无人值守运行没有人审批"
          : "等待审批超时"
      }`;
    } else if (status === "stalled" || (status === "failed" && entry.stopped !== undefined)) {
      errorKind = entry.stopped?.errorKind ?? "stalled";
      error = entry.stopped?.message ?? error;
    } else if (status !== "completed" && errorKind === undefined) {
      errorKind =
        status === "cancelled" || status === "aborted"
          ? status
          : status === "turn-limit" || status === "wall-clock-limit" || status === "token-limit"
            ? status
            : "run-failed";
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
    let transcript: string | undefined;
    try {
      transcript = await runtime.transcript?.();
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
      ...(entry.start !== undefined ? { start: entry.start } : {}),
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      origin: entry.origin,
      status,
      turns: entry.turns,
      ...(error !== undefined ? { error } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
      ...(entry.blocked !== undefined && !entry.cancelRequested
        ? { recoverable: true, blocked: entry.blocked }
        : {}),
      ...(result !== undefined ? { result } : {}),
      ...(hookOutputs !== undefined && hookOutputs.length > 0 ? { hookOutputs } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
      durationMs: skipRun ? 0 : this.#now() - runStartedAt,
    };
    entry.outcome = outcome;
    this.#appendSettled(entry.parentLog, {
      childSessionId: entry.sessionId,
      name: entry.name,
      status,
      turns: entry.turns,
      ...(error !== undefined ? { error } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
      ...(result !== undefined ? { result } : {}),
      // 决策 312：脚本派出的调用另记运行号、指纹与交回的结构化数据（续跑复用）
      ...(entry.script !== undefined
        ? {
            script: {
              runId: entry.script.runId,
              fingerprint: entry.script.fingerprint,
              ...(result?.structured !== undefined ? { structured: result.structured } : {}),
            },
          }
        : {}),
    });
    this.#emit({ kind: "worker.settled", worker: refOf(entry), outcome, at: this.#now() });
    return outcome;
  }

  // 删起点引用失败不改变派出结果：进内部故障清单
  #releaseStart(release: (() => void) | undefined): void {
    if (release === undefined) {
      return;
    }
    try {
      release();
    } catch (error) {
      this.#errors.push(error);
    }
  }

  // settled 写盘失败不改变 worker 结果：进内部故障清单，派出方会话留"缺 settled"的可见缺口
  #appendSettled(sink: ChildFamilySink, input: Omit<ChildSettledInput, "settledAt">): void {
    try {
      sink.appendChildSettled({ ...input, settledAt: this.#now() });
    } catch (error) {
      this.#errors.push(error);
    }
  }

  #rejectPrevious(sessionId: SessionId, action: "cancel" | "send" | "resume"): void {
    const previous = this.#previous.get(sessionId);
    if (previous !== undefined) {
      throw new WorkerSpawnError(previousRunWorkerText(previous, action));
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
    // 之前运行的 worker 的名字同样占着（取用与查询按名字找）
    const taken = new Set(
      [...this.#workers.values(), ...this.#previous.values()].map((worker) => worker.name)
    );
    let index = 1;
    while (taken.has(`${role}-${index}`)) {
      index += 1;
    }
    return `${role}-${index}`;
  }
}
