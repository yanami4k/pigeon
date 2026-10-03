// 主 agent 派 worker 的工具 spawn_worker（决策 264–268、271；297 起改为后台派出）：派出后立即返回 worker 的名字，不等它做完；
// worker 结束时一条通知进主 agent 的下一轮（worker-notices.ts），需要结果才能往下做时用 wait_workers 等（orchestration-tools.ts）。
// 执行模式为可并行，一次回复里多次调用即连续派出。工具说明、参数说明与各情形的返回文字按定稿原文（含 297 起的改写），
// 数值取自配置（取缺省时逐字即定稿原文）。
// - 底层只用会话编排器现有的派出（workers.ts），不另写一套 worker 生命周期；attempts 走现有的并行同任务派发
//   （attempt-group.ts），在后台跑，全部结束后发一条交回各份改动与摘要的通知（决策 322：不再贴验证标签，由主 agent 或人比较）。
// - 额度（300）：同时在跑的上限由编排器排队实现（人派的一并计算）；不设总数上限，给了 --worker-limit（或配置 maxWorkersPerRun）
//   时一次运行里 agent 派的个数在这里计，满了按定稿文字拒绝；本次运行的总额度用完时拒绝再派（正在跑的由额度的持有方停掉）。
// - worker 在后台跑，主 agent 这一轮结束、被中断都不影响它们；结果与工作树跨轮保留，可稍后收回（294 ⑤）。
// - 注册范围（265–267）：只给终端界面与 pigeon run 的主会话注册（层数放开时另给未到底层的 worker，299）；命令行对话、沙箱会话与
//   跑批器各条件都不注册。审批照现有规矩（266）：本工具只读档、不经审批，worker 各自的调用按 302、303 走。
// - 决策 360：可给工具清单（只能取主 agent 现有工具的子集，不给即按角色取预设）与各工具的作用范围（只能更窄）；
//   校验在编排器派出时做（roles.ts），不合要求即不派、退还额度，按专门的文字回话。
import { type Static, Type } from "typebox";
import {
  LIST_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
} from "../memory/search-tools.ts";
import { isGitWorkspace } from "../orchestration/checkpoint.ts";
import { isWorkerRole, WORKER_ROLES, WorkerPolicyError } from "../orchestration/roles.ts";
import type {
  WorkerOrchestrator,
  WorkerOutcome,
  WorkerStartPoint,
} from "../orchestration/workers.ts";
import { worktreeBranchFor } from "../orchestration/worktree.ts";
import type { SessionId } from "../state/ids.ts";
import {
  DEFAULT_ORCHESTRATION_SETTINGS,
  type OrchestrationSettings,
} from "../state/orchestration-config.ts";
import type { ToolScope } from "../state/session-payloads.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../tools/host-scope.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import { RUN_COMMAND_TOOL } from "../tools/run-command.ts";
import { SCOPABLE_TOOLS } from "../tools/tool-scope.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import type { WorkerNotices } from "./worker-notices.ts";
import { workerStartLine } from "./workers-commands.ts";

export const SPAWN_WORKER_TOOL = "spawn_worker";
// 决策 279：取用 worker 自身改动的工具名（工具在 take-worker-tool.ts，与本工具共用工具槽；返回文字里要提到它）
export const TAKE_WORKER_TOOL = "take_worker";
// 决策 297：另外几件编排积木的工具名（工具在 orchestration-tools.ts，与本工具共用工具槽）
export const WAIT_WORKERS_TOOL = "wait_workers";
export const WORKER_STATUS_TOOL = "worker_status";
export const MESSAGE_WORKER_TOOL = "message_worker";
export const STOP_WORKER_TOOL = "stop_worker";

// 说明文字与派出额度要用的设定：同时在跑的上限、可选的一次运行派出上限、层数与派出方所在层、任务清单开关、两个时限
export interface SpawnWorkerSettings {
  maxConcurrent: number;
  maxAgentSpawns?: number;
  maxDepth: number;
  // 派出方所在层：主会话为 0
  depth: number;
  taskList: boolean;
  approvalTimeoutMs: number;
  stallMs: number;
  // wait_workers 一次最多等多久（跟着每个 worker 的时间上限配置走）
  workerWallClockMs: number;
}

export function spawnWorkerSettingsOf(
  settings: OrchestrationSettings,
  depth = 0
): SpawnWorkerSettings {
  return {
    maxConcurrent: settings.maxConcurrent,
    ...(settings.maxWorkersPerRun !== undefined
      ? { maxAgentSpawns: settings.maxWorkersPerRun }
      : {}),
    maxDepth: settings.maxDepth,
    depth,
    taskList: settings.taskList,
    approvalTimeoutMs: settings.approvalTimeoutMs,
    stallMs: settings.stallMs,
    workerWallClockMs: settings.workerWallClockMs,
  };
}

export const DEFAULT_SPAWN_WORKER_SETTINGS: SpawnWorkerSettings = spawnWorkerSettingsOf(
  DEFAULT_ORCHESTRATION_SETTINGS
);

export function assertSpawnWorkerSettings(settings: SpawnWorkerSettings): void {
  const checked: Record<string, number | undefined> = {
    maxConcurrent: settings.maxConcurrent,
    maxAgentSpawns: settings.maxAgentSpawns,
    maxDepth: settings.maxDepth,
  };
  for (const [key, value] of Object.entries(checked)) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`派 worker 的上限需要正整数：${key}=${value}`);
    }
  }
}

// 第 5 句的后半：层数为缺省的 1 层（或新 worker 已在最底层）时写"也不能再派 worker"，放开时写明还能往下派几层
function nestingClause(settings: SpawnWorkerSettings): string {
  const below = settings.maxDepth - (settings.depth + 1);
  return below > 0 ? `；它还能往下再派 ${below} 层 worker。` : "，也不能再派 worker。";
}

// 决策 360：说明里提到的工具按主 agent 当前已注册的工具生成（available 为它的工具名单；不给即按都在）
type ToolPresence = (tool: string) => boolean;

// 可附加作用范围的工具，按范围种类取自登记表（tool-scope.ts）
function scopableOf(kind: "paths" | "commandPrefixes", has: ToolPresence = () => true): string[] {
  return Object.keys(SCOPABLE_TOOLS).filter((tool) => SCOPABLE_TOOLS[tool] === kind && has(tool));
}

// 角色一句：各角色的能力取预设与主 agent 现有工具的交集
function rolesSentence(has: ToolPresence): string {
  const read = has("read_file");
  const sessions = [SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL, LIST_SESSIONS_TOOL].every(has);
  const explorer = [...(read ? ["读代码"] : []), ...(sessions ? ["检索历史会话"] : [])];
  const web = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL].filter(has);
  const clauses = [
    ...(explorer.length > 0 ? [`explorer 只能${explorer.join("与")}，适合调查与定位`] : []),
    ...(has("edit_file")
      ? [`implementer 能${read ? "读写文件" : "改文件"}、不能跑命令，适合按明确的方案改代码`]
      : []),
    ...(has(RUN_COMMAND_TOOL)
      ? [`tester 能${read ? "读文件与跑命令" : "跑命令"}、不能改文件，适合运行与诊断测试`]
      : []),
    ...(web.length > 0 ? [`三种角色另外都能用 ${web.join(" 与 ")} 查资料`] : []),
  ];
  return `不给 tools 时，角色决定 worker 能用的工具：${clauses.join("；")}。`;
}

// 工具清单与作用范围一句：能收窄的工具取登记表与主 agent 现有工具的交集
function toolsSentence(has: ToolPresence): string {
  const pathTools = scopableOf("paths", has);
  const commandTools = scopableOf("commandPrefixes", has);
  const narrowing = [
    ...(pathTools.length > 0 ? [`${pathTools.join("、")} 限在给定的路径之内`] : []),
    ...(commandTools.length > 0
      ? [`${commandTools.join("、")} 只能运行以给定前缀开头、不经 shell 的单条命令`]
      : []),
  ];
  return (
    "要别的组合就给 tools：只能从你自己现在能用的工具里选（派 worker、写记忆、任务清单一类除外），没列的工具 worker 没有。" +
    (narrowing.length > 0
      ? `还可以用 scopes 收窄某件工具：${narrowing.join("，")}；越出范围的调用会被拒绝。`
      : "") +
    (has(RUN_COMMAND_TOOL) ? "worker 跑命令与你同一套审批规则。" : "")
  );
}

// 工具说明（定稿原文；数值与两处随配置的句子取自设定，提到的工具取自主 agent 当前的工具）
export function spawnWorkerDescription(
  settings: SpawnWorkerSettings,
  available?: readonly string[]
): string {
  const has: ToolPresence = (tool) => available === undefined || available.includes(tool);
  return [
    "派一个 worker 去完成一项独立的子任务。派出后立即返回它的名字，不等它做完；它结束时会有一条通知进入你的对话，交回它的分支、改动过的文件与工作摘要。",
    "worker 从派出时主工作目录的快照开工（含未提交的改动与未被忽略的新文件），在自己的 git 工作树与分支里干活；看不到本会话的对话。",
    `要并行，就多次调用本工具，每次派一个（可在同一次回复里连续调用）；同时最多跑 ${settings.maxConcurrent} 个，多的排队。派出后可以接着做自己的事，但不要把派出去的活自己再做一遍。需要结果才能往下做时用 ${WAIT_WORKERS_TOOL} 等；${WORKER_STATUS_TOOL} 查看进度，${MESSAGE_WORKER_TOOL} 给在跑的 worker 补充说明，${STOP_WORKER_TOOL} 停掉不再需要的。` +
      (settings.maxAgentSpawns !== undefined
        ? `一次运行最多派 ${settings.maxAgentSpawns} 个。`
        : ""),
    "何时派：任务能拆成互不依赖的几块、并行能明显省时间时才派，通常 2 到 4 个就够；简单的活、前后依赖紧的活自己做。每个 worker 都要重新读代码，派得越多花得越多。",
    `任务要写得能独立完成：目标、相关文件、完成的标准都写清楚。worker 不能向你提问${nestingClause(settings)}`,
    rolesSentence(has),
    toolsSentence(has),
    "worker 的改动不会自动并入你的分支：看过交回的分支与摘要后，由你决定合不合、怎么合。",
  ].join("\n");
}

// label 参数的说明：任务清单开着时另带对应清单项的一句
function labelDescription(taskList: boolean): string {
  return taskList
    ? "可选的标签，原样出现在这个 worker 的通知与结果里，便于对应任务清单里的项"
    : "可选的标签，原样出现在这个 worker 的通知与结果里";
}

// 参数（说明为定稿原文）。role 为三个角色的枚举（定稿参数表的类型），写错时上游的参数校验先拒绝；工具自己仍按定稿文字
// 兜底回话（角色写错，通常走不到）。task 不设下限，为空时由工具按定稿文字回话
export function spawnWorkerParamsSchema(taskList: boolean) {
  return Type.Object({
    role: Type.Union(
      [Type.Literal("explorer"), Type.Literal("implementer"), Type.Literal("tester")],
      { description: "worker 的角色，决定它能用的工具，见工具说明" }
    ),
    task: Type.String({ description: "子任务的完整说明：目标、相关文件、完成的标准" }),
    name: Type.Optional(
      Type.String({ description: "worker 的名字，用于分支名与状态显示；不给即自动生成" })
    ),
    attempts: Type.Optional(
      Type.Integer({
        minimum: 2,
        maximum: 4,
        description:
          "同一任务并行派出的份数；给了即各做一份，全部做完后交回各份的改动与摘要，由你比较",
      })
    ),
    label: Type.Optional(Type.String({ description: labelDescription(taskList) })),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        description: "worker 能用的工具名单，只能从你现在能用的工具里选；不给即按角色的预设",
      })
    ),
    scopes: Type.Optional(
      Type.Array(
        Type.Object({
          tool: Type.String({ description: "要收窄的工具，须是 worker 有的" }),
          paths: Type.Optional(
            Type.Array(Type.String(), {
              minItems: 1,
              description: `${scopableOf("paths").join("、")} 用：相对 worker 工作树根的路径，目录含其下全部；不能用 .. 或绝对路径`,
            })
          ),
          commandPrefixes: Type.Optional(
            Type.Array(Type.String(), {
              minItems: 1,
              description: `${scopableOf("commandPrefixes").join("、")} 用：允许的命令开头（按词比对），如 npm test`,
            })
          ),
        }),
        { description: "可选，把某几件工具的作用范围收窄，每件一项" }
      )
    ),
  });
}
export const SpawnWorkerParamsSchema = spawnWorkerParamsSchema(true);
export type SpawnWorkerParams = Static<typeof SpawnWorkerParamsSchema>;

// 摘要截断的补句、各情形的返回文字与通知文字（定稿原文）
export const SPAWN_WORKER_TEXTS = {
  spawned: (w: { name: string; role: string; branch: string; label?: string }) =>
    `已派出 worker ${w.name}（${w.role}），分支 ${w.branch}${
      w.label !== undefined ? `，标签 ${w.label}` : ""
    }。它结束时会有通知；需要结果才能往下做时用 ${WAIT_WORKERS_TOOL} 等。`,
  attemptsSpawned: (names: readonly string[]) =>
    `已并行派出 ${names.length} 份：${names.join("、")}。全部结束后会有一条通知，交回各份的改动与摘要。`,
  completed: (w: WorkerFacts) =>
    `worker ${w.name}（${w.role}）已完成。分支：${w.branch}。改动的文件（${w.files.length}）：${fileList(w.files)}。摘要：${w.summary}`,
  truncated: (sessionId: string) => `（摘要已截断，全文在 worker 会话 ${sessionId} 里）`,
  limitHit: (w: WorkerFacts, limit: "轮数" | "时间") =>
    `worker ${w.name}（${w.role}）撞上${limit}上限，没有做完。分支：${w.branch}。已改动的文件（${w.files.length}）：${fileList(w.files)}。摘要：${w.summary}`,
  failed: (w: Pick<WorkerFacts, "name" | "role" | "branch">, reason: string) =>
    `worker ${w.name}（${w.role}）失败：${reason}。分支 ${w.branch} 上可能有部分改动。`,
  cancelled: (w: Pick<WorkerFacts, "name" | "role" | "branch">) =>
    `worker ${w.name}（${w.role}）被取消。分支 ${w.branch} 上可能有部分改动。`,
  // 决策 298：卡住
  stalled: (w: Pick<WorkerFacts, "name" | "role" | "branch">, minutes: number) =>
    `worker ${w.name}（${w.role}）卡住：${minutes} 分钟没有新的模型回复或工具结果，已中断。分支 ${w.branch} 上可能有部分改动。`,
  // 决策 303：停在等审批（时限取配置值）
  awaitingApproval: (
    w: Pick<WorkerFacts, "name" | "role" | "branch">,
    action: string,
    why: { kind: "timeout"; minutes: number } | { kind: "unattended" }
  ) =>
    `worker ${w.name}（${w.role}）停在等审批：要${action}，${
      why.kind === "timeout" ? `${why.minutes} 分钟内无人批准` : "无人值守运行没有人审批"
    }。分支 ${w.branch} 上有已做的部分；人补批后它可以接着做。`,
  attempt: (index: number) => `第 ${index} 份：`,
  // 多份尝试里已由 wait_workers 交回过的一份
  attemptClaimed: (name: string) => `worker ${name} 的结果已由 ${WAIT_WORKERS_TOOL} 交回。`,
  spawnLimit: (max: number) =>
    `本次运行派出的 worker 已达 ${max} 个上限。不要再派；用已有的结果，或自己完成。`,
  budgetExhausted: "本次运行的额度已用完，不能再派 worker；正在跑的 worker 已停止。",
  notGit: "当前工作区不是 git 仓库，不能派 worker。",
  // 决策 360：工具清单或作用范围不合要求（理由来自编排器的校验）
  badTools: (reason: string) => `没有派出：${reason}。`,
  unknownRole: (role: string) => `没有角色 ${role}；可选：${WORKER_ROLES.join("、")}。`,
  emptyTask: "task 不能为空：写清目标、相关文件与完成的标准。",
  // 决策 279（271 修订）：另起一行写明起点快照与只取其自身改动的取用方式
  start: (start: WorkerStartPoint, name: string) =>
    workerStartLine(start, `调用 ${TAKE_WORKER_TOOL}（worker=${name}）`),
} as const;

interface WorkerFacts {
  name: string;
  role: string;
  branch: string;
  files: readonly string[];
  summary: string;
}

// 文件列表：顿号相接；一个都没有时写"无"
function fileList(files: readonly string[]): string {
  return files.length > 0 ? files.join("、") : "无";
}

// 一次运行的派出额度（268、300）：不设总数上限；给了上限时 agent 派出的个数按运行计——运行标识变了（终端界面里每条输入是
// 一次运行）即从零计；总额度用完由持有方标记（pigeon run 给了 token 上限时）
export class SpawnWorkerBudget {
  readonly #maxAgentSpawns: number | undefined;
  readonly #runKey: () => string | undefined;
  #key: string | undefined;
  #spawned = 0;
  #exhausted = false;

  constructor(options: { maxAgentSpawns?: number; runKey?: () => string | undefined }) {
    this.#maxAgentSpawns = options.maxAgentSpawns;
    this.#runKey = options.runKey ?? (() => undefined);
  }

  get maxAgentSpawns(): number | undefined {
    return this.#maxAgentSpawns;
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  markExhausted(): void {
    this.#exhausted = true;
  }

  // 本次运行已由 agent 派出的个数
  spawned(): number {
    this.#sync();
    return this.#spawned;
  }

  // 再派 count 个是否超过上限；不超过（或不设上限）即记下
  tryTake(count: number): boolean {
    this.#sync();
    if (this.#maxAgentSpawns !== undefined && this.#spawned + count > this.#maxAgentSpawns) {
      return false;
    }
    this.#spawned += count;
    return true;
  }

  // 决策 360：校验不过、一个都没派出时退还
  refund(count: number): void {
    this.#sync();
    this.#spawned = Math.max(0, this.#spawned - count);
  }

  #sync(): void {
    const key = this.#runKey();
    if (key !== this.#key) {
      this.#key = key;
      this.#spawned = 0;
    }
  }
}

// 多份尝试的派发：走并行同任务派发与验证标签（attempt-group.ts），由装配方注入（本模块在装配根之下，不直接依赖它）
export interface SpawnAttemptsRequest {
  role: string;
  task: string;
  count: number;
  label?: string;
  tools?: readonly string[];
  scopes?: readonly ToolScope[];
  onSpawned: (sessionIds: readonly string[]) => void;
}

export interface SpawnAttemptsResult {
  // 按派出顺序
  outcomes: WorkerOutcome[];
}

// 工具执行时要用的会话侧能力（装配方在编排器建好后绑定）
export interface SpawnWorkerHost {
  orchestrator: Pick<
    WorkerOrchestrator,
    "spawn" | "awaitResult" | "cancel" | "status" | "wait" | "send" | "subscribe"
  >;
  // 治理根（主仓库根）：是不是 git 仓库
  governanceRoot: string;
  spawnAttempts(request: SpawnAttemptsRequest): Promise<SpawnAttemptsResult>;
  budget: SpawnWorkerBudget;
  // 完成通知（297）：模型派出的 worker 结束时发；没有即不发（替身）
  notices?: WorkerNotices;
  // 决策 299：派出方是 worker 时为它的会话号
  from?: SessionId;
}

// 注册开关与晚绑定：装配运行面时注册工具，编排器（需要运行面本身）建好后再 bind。未绑定即被调用属装配故障，按失败回话
export class SpawnWorkerSlot {
  readonly settings: SpawnWorkerSettings;
  #host: SpawnWorkerHost | undefined;

  constructor(settings: SpawnWorkerSettings = DEFAULT_SPAWN_WORKER_SETTINGS) {
    assertSpawnWorkerSettings(settings);
    this.settings = settings;
  }

  bind(host: SpawnWorkerHost): void {
    this.#host = host;
  }

  get host(): SpawnWorkerHost | undefined {
    return this.#host;
  }
}

export interface SpawnWorkerDetails {
  // 本次调用派出的 worker 会话；拒绝时为空
  sessionIds: string[];
  rejected?:
    | "not-git"
    | "unknown-role"
    | "empty-task"
    | "spawn-limit"
    | "budget"
    | "unbound"
    | "bad-tools";
}

// 一个 worker 收尾后交回的文字（通知与多份尝试的汇总用）。决策 279（271 修订）：有工作树的 worker 另起一行写明起点快照与只取其
// 自身改动的取用方式（额度用完的文字不加）。时限取自设定（等审批的文字要写）。
// 决策 322：收尾钩子的输出（SubagentStop 的拦截理由与补充上下文）附在末尾
export function workerOutcomeText(
  outcome: WorkerOutcome,
  budgetExhausted = false,
  settings: Pick<
    SpawnWorkerSettings,
    "approvalTimeoutMs" | "stallMs"
  > = DEFAULT_SPAWN_WORKER_SETTINGS
): string {
  const text = workerOutcomeTextBase(outcome, budgetExhausted, settings);
  const outputs = outcome.hookOutputs ?? [];
  if (outputs.length === 0) return text;
  return `${text}\n钩子输出：\n${outputs.map((line) => `  ${line}`).join("\n")}`;
}

function workerOutcomeTextBase(
  outcome: WorkerOutcome,
  budgetExhausted = false,
  settings: Pick<
    SpawnWorkerSettings,
    "approvalTimeoutMs" | "stallMs"
  > = DEFAULT_SPAWN_WORKER_SETTINGS
): string {
  const branch =
    outcome.result?.branch ??
    (outcome.workspace.kind === "git-worktree" ? outcome.workspace.branch : "");
  const base = { name: outcome.name, role: outcome.role, branch };
  const facts: WorkerFacts = {
    ...base,
    files: outcome.result?.changedFiles ?? [],
    summary: outcome.result?.summary ?? "",
  };
  const suffix =
    outcome.result?.summaryTruncated === true
      ? SPAWN_WORKER_TEXTS.truncated(outcome.sessionId)
      : "";
  const start =
    outcome.start !== undefined && outcome.workspace.kind === "git-worktree"
      ? `\n${SPAWN_WORKER_TEXTS.start(outcome.start, outcome.name)}`
      : "";
  if (outcome.blocked !== undefined) {
    return (
      SPAWN_WORKER_TEXTS.awaitingApproval(
        base,
        outcome.blocked.action,
        outcome.blocked.errorKind === "approval-unattended"
          ? { kind: "unattended" }
          : { kind: "timeout", minutes: minutesOf(settings.approvalTimeoutMs) }
      ) + start
    );
  }
  switch (outcome.status) {
    case "completed":
      return SPAWN_WORKER_TEXTS.completed(facts) + suffix + start;
    case "turn-limit":
      return SPAWN_WORKER_TEXTS.limitHit(facts, "轮数") + suffix + start;
    case "wall-clock-limit":
      return SPAWN_WORKER_TEXTS.limitHit(facts, "时间") + suffix + start;
    case "stalled":
      return SPAWN_WORKER_TEXTS.stalled(base, minutesOf(settings.stallMs)) + start;
    case "cancelled":
    case "aborted":
      // 额度用完而停掉的 worker：交回额度用完的文字
      return budgetExhausted
        ? SPAWN_WORKER_TEXTS.budgetExhausted
        : SPAWN_WORKER_TEXTS.cancelled(base) + start;
    case "token-limit":
      return SPAWN_WORKER_TEXTS.failed(base, "撞上 token 上限") + start;
    default:
      return SPAWN_WORKER_TEXTS.failed(base, outcome.error ?? "运行以未知终态结束") + start;
  }
}

function minutesOf(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

// 通知的整段文字：带标签的在前面写明标签（294：标签原样带回）
export function workerNoticeText(
  outcome: WorkerOutcome,
  budgetExhausted = false,
  settings: Pick<
    SpawnWorkerSettings,
    "approvalTimeoutMs" | "stallMs"
  > = DEFAULT_SPAWN_WORKER_SETTINGS
): string {
  const text = workerOutcomeText(outcome, budgetExhausted, settings);
  return `${outcome.label !== undefined ? `标签 ${outcome.label}：${text}` : text}\n${workerNoticeMarker(outcome.sessionId)}`;
}

// 完成通知里可识别的 worker 会话号（权威链审计 ③）：续接时据主分支上的使用者消息里有没有它判定通知是否已递出
export function workerNoticeMarker(sessionId: string): string {
  return `（worker 会话 ${sessionId}）`;
}

function reply(text: string, details: SpawnWorkerDetails): PigeonToolResult<SpawnWorkerDetails> {
  return { content: [{ type: "text", text }], details };
}

// 决策 360：工具清单与作用范围的参数（给了才带）
function toolRequestOf(params: SpawnWorkerParams): {
  tools?: readonly string[];
  scopes?: readonly ToolScope[];
} {
  return {
    ...(params.tools !== undefined ? { tools: params.tools } : {}),
    ...(params.scopes !== undefined ? { scopes: params.scopes } : {}),
  };
}

// 校验不过：一个都没派出，退还额度
function rejectTools(
  host: SpawnWorkerHost,
  count: number,
  error: WorkerPolicyError
): PigeonToolResult<SpawnWorkerDetails> {
  host.budget.refund(count);
  return reply(SPAWN_WORKER_TEXTS.badTools(error.message), {
    sessionIds: [],
    rejected: "bad-tools",
  });
}

// 派出前的检查：按定稿文字回话的几种情形
function precheck(
  host: SpawnWorkerHost,
  params: SpawnWorkerParams,
  count: number
): PigeonToolResult<SpawnWorkerDetails> | undefined {
  if (!isWorkerRole(params.role)) {
    return reply(SPAWN_WORKER_TEXTS.unknownRole(params.role), {
      sessionIds: [],
      rejected: "unknown-role",
    });
  }
  if (params.task.trim() === "") {
    return reply(SPAWN_WORKER_TEXTS.emptyTask, { sessionIds: [], rejected: "empty-task" });
  }
  if (!isGitWorkspace(host.governanceRoot)) {
    return reply(SPAWN_WORKER_TEXTS.notGit, { sessionIds: [], rejected: "not-git" });
  }
  if (host.budget.exhausted) {
    return reply(SPAWN_WORKER_TEXTS.budgetExhausted, { sessionIds: [], rejected: "budget" });
  }
  if (!host.budget.tryTake(count)) {
    return reply(SPAWN_WORKER_TEXTS.spawnLimit(host.budget.maxAgentSpawns ?? 0), {
      sessionIds: [],
      rejected: "spawn-limit",
    });
  }
  return undefined;
}

// available：派出方当前已注册的工具（说明按它生成，360）；不给即按都在
export function createSpawnWorkerTool(
  slot: SpawnWorkerSlot,
  available?: readonly string[]
): PigeonAgentTool<ReturnType<typeof spawnWorkerParamsSchema>, SpawnWorkerDetails> {
  return {
    name: SPAWN_WORKER_TOOL,
    label: SPAWN_WORKER_TOOL,
    description: spawnWorkerDescription(slot.settings, available),
    parameters: spawnWorkerParamsSchema(slot.settings.taskList),
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<SpawnWorkerDetails>> {
      const host = slot.host;
      if (host === undefined) {
        return reply(
          SPAWN_WORKER_TEXTS.failed(
            {
              name: params.name ?? params.role,
              role: params.role,
              branch: worktreeBranchFor(params.name ?? params.role),
            },
            "本会话没有装配编排器"
          ),
          { sessionIds: [], rejected: "unbound" }
        );
      }
      const count = params.attempts ?? 1;
      const rejected = precheck(host, params, count);
      if (rejected !== undefined) {
        return rejected;
      }
      const label =
        params.label !== undefined && params.label.trim() !== "" ? params.label.trim() : undefined;
      if (params.attempts !== undefined) {
        return spawnAttempts(host, slot.settings, params, label);
      }
      let id: SessionId;
      try {
        id = host.orchestrator.spawn({
          role: params.role,
          task: params.task,
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(label !== undefined ? { label } : {}),
          origin: "agent",
          ...(host.from !== undefined ? { from: host.from } : {}),
          ...toolRequestOf(params),
        });
      } catch (error) {
        if (error instanceof WorkerPolicyError) {
          return rejectTools(host, count, error);
        }
        const name = params.name ?? params.role;
        return reply(
          SPAWN_WORKER_TEXTS.failed(
            { name, role: params.role, branch: worktreeBranchFor(name) },
            error instanceof Error ? error.message : String(error)
          ),
          { sessionIds: [] }
        );
      }
      const status = host.orchestrator.status().find((worker) => worker.sessionId === id);
      const name = status?.name ?? id;
      return reply(
        SPAWN_WORKER_TEXTS.spawned({
          name,
          role: params.role,
          branch: status?.branch ?? worktreeBranchFor(name),
          ...(label !== undefined ? { label } : {}),
        }),
        { sessionIds: [id] }
      );
    },
  };
}

// 多份尝试（069；322 起不再贴验证标签）：并行同任务派发在后台跑；派出即返回名单，全部结束后发一条交回各份的通知
async function spawnAttempts(
  host: SpawnWorkerHost,
  settings: SpawnWorkerSettings,
  params: SpawnWorkerParams,
  label: string | undefined
): Promise<PigeonToolResult<SpawnWorkerDetails>> {
  let ids: SessionId[] | undefined;
  const running = host.spawnAttempts({
    role: params.role,
    task: params.task,
    count: params.attempts ?? 2,
    ...(label !== undefined ? { label } : {}),
    ...toolRequestOf(params),
    onSpawned: (spawned) => {
      ids = spawned as SessionId[];
      host.notices?.group(ids);
    },
  });
  if (ids === undefined) {
    // 派出本身失败：派发在第一个等待之前就已失败
    try {
      await running;
    } catch (error) {
      if (error instanceof WorkerPolicyError) {
        return rejectTools(host, params.attempts ?? 2, error);
      }
      return reply(
        SPAWN_WORKER_TEXTS.failed(
          { name: params.role, role: params.role, branch: worktreeBranchFor(params.role) },
          error instanceof Error ? error.message : String(error)
        ),
        { sessionIds: [] }
      );
    }
  }
  const spawnedIds = ids ?? [];
  running.then(
    (result) => {
      const text = result.outcomes
        .map(
          (outcome, index) =>
            SPAWN_WORKER_TEXTS.attempt(index + 1) +
            (host.notices?.claimedInGroup(outcome.sessionId) === true
              ? SPAWN_WORKER_TEXTS.attemptClaimed(outcome.name)
              : workerOutcomeText(outcome, host.budget.exhausted, settings)) +
            `\n${workerNoticeMarker(outcome.sessionId)}`
        )
        .join("\n\n");
      host.notices?.postGroup(spawnedIds, label !== undefined ? `标签 ${label}：${text}` : text);
    },
    (error: unknown) => {
      host.notices?.postGroup(
        spawnedIds,
        `多份尝试收尾异常：${error instanceof Error ? error.message : String(error)}\n` +
          spawnedIds.map(workerNoticeMarker).join("")
      );
    }
  );
  const names = spawnedIds.map(
    (id) => host.orchestrator.status().find((worker) => worker.sessionId === id)?.name ?? id
  );
  return reply(SPAWN_WORKER_TEXTS.attemptsSpawned(names), { sessionIds: spawnedIds });
}

// 装配根注册用的元数据：只读档（本身不读写工作区、不经审批；worker 的调用各自按审批走），可并行
export function spawnWorkerRegistration(): ToolRegistration {
  return {
    name: SPAWN_WORKER_TOOL,
    description: "在后台派 worker 完成独立子任务，结束时通知",
    parameters: SpawnWorkerParamsSchema,
    tier: "read",
    pathConfinement: { kind: "none" },
    executionMode: "parallel",
  };
}
