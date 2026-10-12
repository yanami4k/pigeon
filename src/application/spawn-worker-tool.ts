// 主 agent 派 worker 的工具 spawn_worker（决策 264–268、271；297 起改为后台派出）：派出后立即返回 worker 的名字，不等它做完；
// worker 结束时一条通知进主 agent 的下一轮（worker-notices.ts），需要结果才能往下做时用 wait_workers 等（orchestration-tools.ts）。
// 执行模式按 tool-execution-modes.ts 的登记为串行（决策 353；运行面以登记为准，覆盖工具自带的标记）：一次回复里多次调用即
// 按顺序逐个派出，派出的 worker 各自在后台同时跑。工具说明、参数说明与各情形的返回文字按定稿原文（含 297 起的改写），
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
// - 决策 377：只读的 explorer 不建工作树、直接读派出方的工作区，派出与交回文字不提分支与改动文件（定稿原文）。
// - 决策 381：worker 新建却因过大不会进交回的树的文件，另起一行附在交回文字之后。
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
import { formatBytes, type SkippedFile } from "../state/snapshot-config.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../tools/host-scope.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import { RUN_COMMAND_TOOL } from "../tools/run-command.ts";
import { SCOPABLE_TOOLS } from "../tools/tool-scope.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import type { WorkerNotices } from "./worker-notices.ts";

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
  return below > 0
    ? `; it can itself spawn workers up to ${below} more ${below === 1 ? "level" : "levels"} down.`
    : ", and it cannot spawn workers of its own.";
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
  const explorer = [...(read ? ["read code"] : []), ...(sessions ? ["search past sessions"] : [])];
  const web = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL].filter(has);
  const clauses = [
    ...(explorer.length > 0
      ? [`explorer can only ${explorer.join(" and ")}, suited to investigating and locating things`]
      : []),
    ...(has("edit_file")
      ? [
          `implementer can ${read ? "read and write files" : "edit files"} but cannot run commands, suited to changing code by a clear plan`,
        ]
      : []),
    ...(has(RUN_COMMAND_TOOL)
      ? [
          `tester can ${read ? "read files and run commands" : "run commands"} but cannot change files, suited to running and diagnosing tests`,
        ]
      : []),
    ...(web.length > 0
      ? [`all three roles can also use ${web.join(" and ")} to look things up`]
      : []),
  ];
  return `Without tools, the role decides which tools a worker can use: ${clauses.join("; ")}.`;
}

// 工具清单与作用范围一句：能收窄的工具取登记表与主 agent 现有工具的交集
function toolsSentence(has: ToolPresence): string {
  const pathTools = scopableOf("paths", has);
  const commandTools = scopableOf("commandPrefixes", has);
  const narrowing = [
    ...(pathTools.length > 0
      ? [
          `${pathTools.join(", ")} ${pathTools.length === 1 ? "is" : "are"} limited to the given paths`,
        ]
      : []),
    ...(commandTools.length > 0
      ? [
          `${commandTools.join(", ")} can only run single commands that start with a given prefix and do not go through a shell`,
        ]
      : []),
  ];
  return (
    "For a different combination, give tools: you can choose only from the tools you can use now (except tools for spawning workers, writing memory, and the task list), and a worker does not have any tool you leave out." +
    (narrowing.length > 0
      ? ` You can also narrow a tool with scopes: ${narrowing.join(", and ")}; calls outside the scope are rejected.`
      : "") +
    (has(RUN_COMMAND_TOOL) ? " A worker's commands follow the same approval rules as yours." : "")
  );
}

// 工具说明（定稿原文；数值与两处随配置的句子取自设定，提到的工具取自主 agent 当前的工具）
export function spawnWorkerDescription(
  settings: SpawnWorkerSettings,
  available?: readonly string[]
): string {
  const has: ToolPresence = (tool) => available === undefined || available.includes(tool);
  return [
    "Spawn a worker to complete an independent subtask. It returns the worker's name right after spawning, without waiting for it to finish; when the worker finishes, a notice enters your conversation with its branch, the files it changed, and a summary of its work (an explorer returns only the summary).",
    "implementer and tester start from a snapshot of the main working directory at spawn time (including uncommitted changes and new files that are not ignored) and work in their own git worktree and branch; explorer gets no worktree and reads your current workspace directly, read-only, so it sees content that is still changing and may read files that are being modified. No worker can see this session's conversation.",
    `To work in parallel, call this tool several times, one worker per call (you can make several calls in the same reply); at most ${settings.maxConcurrent} run at once, and the rest queue. After spawning you can go on with your own work, but do not redo the work you handed off. When you need a result before you can continue, wait with ${WAIT_WORKERS_TOOL}; check progress with ${WORKER_STATUS_TOOL}, give a running worker more instructions with ${MESSAGE_WORKER_TOOL}, and stop workers you no longer need with ${STOP_WORKER_TOOL}.` +
      (settings.maxAgentSpawns !== undefined
        ? ` At most ${settings.maxAgentSpawns} workers can be spawned per run.`
        : ""),
    "When to spawn: only when the task splits into independent pieces and running them in parallel clearly saves time; 2 to 4 workers is usually enough. Do simple work and tightly sequential work yourself. Every worker has to read the code again, so the more you spawn, the more it costs.",
    `Write the task so it can be completed on its own: state the goal, the relevant files, and the criteria for done. A worker cannot ask you questions${nestingClause(settings)}`,
    rolesSentence(has),
    toolsSentence(has),
    "A worker's changes are not merged into your branch automatically: after reviewing the returned branch and summary, you decide whether and how to merge them.",
  ].join("\n");
}

// label 参数的说明：任务清单开着时另带对应清单项的一句
function labelDescription(taskList: boolean): string {
  return taskList
    ? "Optional label that appears as is in this worker's notices and results, to help match it to an item in the task list"
    : "Optional label that appears as is in this worker's notices and results";
}

// 参数（说明为定稿原文）。role 为三个角色的枚举（定稿参数表的类型），写错时上游的参数校验先拒绝；工具自己仍按定稿文字
// 兜底回话（角色写错，通常走不到）。task 不设下限，为空时由工具按定稿文字回话
export function spawnWorkerParamsSchema(taskList: boolean) {
  return Type.Object({
    role: Type.Union(
      [Type.Literal("explorer"), Type.Literal("implementer"), Type.Literal("tester")],
      {
        description:
          "The worker's role; without tools, it decides which tools the worker can use (see the tool description)",
      }
    ),
    task: Type.String({
      description:
        "The full description of the subtask: goal, relevant files, and criteria for done",
    }),
    name: Type.Optional(
      Type.String({
        description:
          "The worker's name, used in the branch name and status display; generated automatically if omitted",
      })
    ),
    attempts: Type.Optional(
      Type.Integer({
        minimum: 2,
        maximum: 4,
        description:
          "How many copies of the same task to spawn in parallel; if given, each worker does its own copy, and when all are done the changes and summary of each are returned for you to compare",
      })
    ),
    label: Type.Optional(Type.String({ description: labelDescription(taskList) })),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        description:
          "The tools the worker can use, chosen only from the tools you can use now; if omitted, the role's preset applies",
      })
    ),
    scopes: Type.Optional(
      Type.Array(
        Type.Object({
          tool: Type.String({ description: "The tool to narrow; the worker must have it" }),
          paths: Type.Optional(
            Type.Array(Type.String(), {
              minItems: 1,
              description: `For ${scopableOf("paths").join(", ")}: paths relative to the worker's worktree root; they must be real paths that do not go through symbolic links, and a directory includes everything under it; .. and absolute paths are not allowed`,
            })
          ),
          commandPrefixes: Type.Optional(
            Type.Array(Type.String(), {
              minItems: 1,
              description: `For ${scopableOf("commandPrefixes").join(", ")}: the allowed beginnings of commands (compared word by word), such as npm test`,
            })
          ),
        }),
        { description: "Optional: narrow the scope of some tools, one item per tool" }
      )
    ),
  });
}
export const SpawnWorkerParamsSchema = spawnWorkerParamsSchema(true);
export type SpawnWorkerParams = Static<typeof SpawnWorkerParamsSchema>;

// 摘要截断的补句、各情形的返回文字与通知文字（定稿原文）
export const SPAWN_WORKER_TEXTS = {
  spawned: (w: { name: string; role: string; branch: string; label?: string }) =>
    `Spawned worker ${w.name} (${w.role}) on branch ${w.branch}${
      w.label !== undefined ? `, label ${w.label}` : ""
    }. You will get a notice when it finishes; when you need its result before you can continue, wait with ${WAIT_WORKERS_TOOL}.`,
  attemptsSpawned: (names: readonly string[]) =>
    `Spawned ${names.length} copies in parallel: ${names.join(", ")}. When all of them finish, one notice will return the changes and summary of each.`,
  completed: (w: WorkerFacts) =>
    `Worker ${w.name} (${w.role}) completed. Branch: ${w.branch}. Changed files (${w.files.length}): ${fileList(w.files)}. Summary: ${w.summary}`,
  truncated: (sessionId: string) =>
    ` (summary truncated; the full text is in worker session ${sessionId})`,
  limitHit: (w: WorkerFacts, limit: WorkerLimit) =>
    `Worker ${w.name} (${w.role}) hit the ${limit} limit and did not finish. Branch: ${w.branch}. Files changed so far (${w.files.length}): ${fileList(w.files)}. Summary: ${w.summary}`,
  failed: (w: Pick<WorkerFacts, "name" | "role" | "branch">, reason: string) =>
    `Worker ${w.name} (${w.role}) failed: ${reason}. The branch ${w.branch} may have partial changes.`,
  cancelled: (w: Pick<WorkerFacts, "name" | "role" | "branch">) =>
    `Worker ${w.name} (${w.role}) was cancelled. The branch ${w.branch} may have partial changes.`,
  // 决策 298：卡住
  stalled: (w: Pick<WorkerFacts, "name" | "role" | "branch">, minutes: number) =>
    `Worker ${w.name} (${w.role}) stalled: no new model reply or tool result for ${counted(minutes, "minute")}, so it was interrupted. The branch ${w.branch} may have partial changes.`,
  // 决策 303：停在等审批（时限取配置值）
  awaitingApproval: (
    w: Pick<WorkerFacts, "name" | "role" | "branch">,
    action: string,
    why: { kind: "timeout"; minutes: number } | { kind: "unattended" }
  ) =>
    `Worker ${w.name} (${w.role}) stopped while waiting for approval of: ${action}; ${approvalWhy(why)}. The branch ${w.branch} has the work done so far; once a person approves, it can continue.`,
  attempt: (index: number) => `Copy ${index}: `,
  // 多份尝试里已由 wait_workers 交回过的一份
  attemptClaimed: (name: string) =>
    `The result of worker ${name} was already returned by ${WAIT_WORKERS_TOOL}.`,
  spawnLimit: (max: number) =>
    `This run has reached the limit of ${max} spawned workers. Do not spawn more; use the results you have, or finish the work yourself.`,
  budgetExhausted:
    "This run's budget is used up, so no more workers can be spawned; the running workers have been stopped.",
  notGit: "The current workspace is not a git repository, so workers cannot be spawned.",
  // 决策 360：工具清单或作用范围不合要求（理由来自编排器的校验）
  badTools: (reason: string) => `Not spawned: ${reason}.`,
  unknownRole: (role: string) =>
    `There is no role ${role}; choose from: ${WORKER_ROLES.join(", ")}.`,
  emptyTask: "task cannot be empty: state the goal, the relevant files, and the criteria for done.",
  // 决策 279（271 修订）：另起一行写明起点快照与只取其自身改动的取用方式（人看的 /workers 用 workers-commands.ts 的中文一行）
  start: (start: WorkerStartPoint, name: string) => {
    const commit = start.commit.slice(0, 12);
    const origin = start.snapshot
      ? `Start point: snapshot ${commit} (including ${start.files.length} uncommitted files at spawn time)`
      : `Start point: commit ${commit} (no uncommitted files at spawn time)`;
    return `${origin}; to apply its changes to your working directory, call ${TAKE_WORKER_TOOL} (worker=${name}).`;
  },
  // 决策 377：只读的 explorer 不建分支、只交回摘要——各情形去掉分支与改动文件的那几句
  readOnly: {
    spawned: (w: { name: string; role: string; label?: string }) =>
      `Spawned worker ${w.name} (${w.role}); it reads your workspace read-only and has no branch${
        w.label !== undefined ? `, label ${w.label}` : ""
      }. You will get a notice when it finishes; when you need its result before you can continue, wait with ${WAIT_WORKERS_TOOL}.`,
    completed: (w: ReadOnlyFacts) =>
      `Worker ${w.name} (${w.role}) completed. Summary: ${w.summary}`,
    limitHit: (w: ReadOnlyFacts, limit: WorkerLimit) =>
      `Worker ${w.name} (${w.role}) hit the ${limit} limit and did not finish. Summary: ${w.summary}`,
    failed: (w: WorkerName, reason: string) => `Worker ${w.name} (${w.role}) failed: ${reason}.`,
    cancelled: (w: WorkerName) => `Worker ${w.name} (${w.role}) was cancelled.`,
    stalled: (w: WorkerName, minutes: number) =>
      `Worker ${w.name} (${w.role}) stalled: no new model reply or tool result for ${counted(minutes, "minute")}, so it was interrupted.`,
    awaitingApproval: (
      w: WorkerName,
      action: string,
      why: { kind: "timeout"; minutes: number } | { kind: "unattended" }
    ) =>
      `Worker ${w.name} (${w.role}) stopped while waiting for approval of: ${action}; ${approvalWhy(why)}. Once a person approves, it can continue.`,
  },
} as const;

// 撞上的上限：轮数或时间
export type WorkerLimit = "turn" | "time";

// 停在等审批的原因
function approvalWhy(why: { kind: "timeout"; minutes: number } | { kind: "unattended" }): string {
  return why.kind === "timeout"
    ? `nobody approved within ${counted(why.minutes, "minute")}`
    : "an unattended run has nobody to approve";
}

// 条数与名词：1 minute、2 minutes
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// 跳过清单给模型的写法：路径（大小）以逗号相接（人看的写法见 snapshot-config.ts 的 skippedFilesText）
export function skippedFilesForModel(skipped: readonly SkippedFile[]): string {
  return skipped.map((file) => `${file.path} (${formatBytes(file.bytes)})`).join(", ");
}

// 决策 381：worker 新建却因过大不会写进交回的树的文件（附在交回文字之后；不属定稿原文）
export function skippedFilesLine(skipped: readonly SkippedFile[] | undefined): string {
  return skipped !== undefined && skipped.length > 0
    ? `\nLarge files left out of the returned changes (${skipped.length}; untracked and too large, so taking the changes will not apply them, and they stay in the worktree): ${skippedFilesForModel(skipped)}`
    : "";
}

interface WorkerName {
  name: string;
  role: string;
}

interface ReadOnlyFacts extends WorkerName {
  summary: string;
}

interface WorkerFacts {
  name: string;
  role: string;
  branch: string;
  files: readonly string[];
  summary: string;
}

// 文件列表：逗号相接；一个都没有时写 none
function fileList(files: readonly string[]): string {
  return files.length > 0 ? files.join(", ") : "none";
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
  // 派出方的工作区根（git 仓库）：派出前的 git 检查看它，take_worker 把改动叠进它。主会话为主工作区根——治理根与
  // 工作区根分开（pigeon run --governance-root）时不是治理根；派出方是 worker 时为它的工作树
  workspaceRoot: string;
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
  return `${text}\nHook output:\n${outputs.map((line) => `  ${line}`).join("\n")}`;
}

function workerOutcomeTextBase(
  outcome: WorkerOutcome,
  budgetExhausted = false,
  settings: Pick<
    SpawnWorkerSettings,
    "approvalTimeoutMs" | "stallMs"
  > = DEFAULT_SPAWN_WORKER_SETTINGS
): string {
  if (outcome.workspace.kind === "shared") {
    return readOnlyOutcomeText(outcome, budgetExhausted, settings);
  }
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
    (outcome.start !== undefined && outcome.workspace.kind === "git-worktree"
      ? `\n${SPAWN_WORKER_TEXTS.start(outcome.start, outcome.name)}`
      : "") + skippedFilesLine(outcome.result?.skippedFiles);
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
      return SPAWN_WORKER_TEXTS.limitHit(facts, "turn") + suffix + start;
    case "wall-clock-limit":
      return SPAWN_WORKER_TEXTS.limitHit(facts, "time") + suffix + start;
    case "stalled":
      return SPAWN_WORKER_TEXTS.stalled(base, minutesOf(settings.stallMs)) + start;
    case "cancelled":
    case "aborted":
      // 额度用完而停掉的 worker：交回额度用完的文字
      return budgetExhausted
        ? SPAWN_WORKER_TEXTS.budgetExhausted
        : SPAWN_WORKER_TEXTS.cancelled(base) + start;
    case "token-limit":
      return SPAWN_WORKER_TEXTS.failed(base, "it hit the token limit") + start;
    default:
      return (
        SPAWN_WORKER_TEXTS.failed(
          base,
          outcome.error ?? "the run ended in an unknown final state"
        ) + start
      );
  }
}

// 决策 377：只读 explorer 的交回文字（没有分支与改动文件）
function readOnlyOutcomeText(
  outcome: WorkerOutcome,
  budgetExhausted: boolean,
  settings: Pick<SpawnWorkerSettings, "approvalTimeoutMs" | "stallMs">
): string {
  const texts = SPAWN_WORKER_TEXTS.readOnly;
  const who = { name: outcome.name, role: outcome.role };
  const facts = { ...who, summary: outcome.result?.summary ?? "" };
  const suffix =
    outcome.result?.summaryTruncated === true
      ? SPAWN_WORKER_TEXTS.truncated(outcome.sessionId)
      : "";
  if (outcome.blocked !== undefined) {
    return texts.awaitingApproval(
      who,
      outcome.blocked.action,
      outcome.blocked.errorKind === "approval-unattended"
        ? { kind: "unattended" }
        : { kind: "timeout", minutes: minutesOf(settings.approvalTimeoutMs) }
    );
  }
  switch (outcome.status) {
    case "completed":
      return texts.completed(facts) + suffix;
    case "turn-limit":
      return texts.limitHit(facts, "turn") + suffix;
    case "wall-clock-limit":
      return texts.limitHit(facts, "time") + suffix;
    case "stalled":
      return texts.stalled(who, minutesOf(settings.stallMs));
    case "cancelled":
    case "aborted":
      return budgetExhausted ? SPAWN_WORKER_TEXTS.budgetExhausted : texts.cancelled(who);
    case "token-limit":
      return texts.failed(who, "it hit the token limit");
    default:
      return texts.failed(who, outcome.error ?? "the run ended in an unknown final state");
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
  return `${outcome.label !== undefined ? `${labelLead(outcome.label)}${text}` : text}\n${workerNoticeMarker(outcome.sessionId)}`;
}

// 带标签的通知开头
function labelLead(label: string): string {
  return `Label ${label}: `;
}

// 完成通知里可识别的 worker 会话号（权威链审计 ③）：续接时据主分支上的使用者消息里有没有它判定通知是否已递出
export function workerNoticeMarker(sessionId: string): string {
  return `(worker session ${sessionId})`;
}

// 决策 428 之前的说法：旧会话里递出的通知末行是中文的
export function legacyWorkerNoticeMarker(sessionId: string): string {
  return `（worker 会话 ${sessionId}）`;
}

// 一段文字里有没有这个 worker 的通知末行：新旧两种说法都认
export function hasWorkerNoticeMarker(text: string, sessionId: string): boolean {
  return (
    text.includes(workerNoticeMarker(sessionId)) ||
    text.includes(legacyWorkerNoticeMarker(sessionId))
  );
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
  if (!isGitWorkspace(host.workspaceRoot)) {
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
    executionMode: "sequential",
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
            "this session has no worker orchestrator set up"
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
      const who = { name, role: params.role, ...(label !== undefined ? { label } : {}) };
      return reply(
        // 决策 377：只读的 explorer 不建分支
        status?.workspace.kind === "shared"
          ? SPAWN_WORKER_TEXTS.readOnly.spawned(who)
          : SPAWN_WORKER_TEXTS.spawned({
              ...who,
              branch: status?.branch ?? worktreeBranchFor(name),
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
      host.notices?.postGroup(
        spawnedIds,
        label !== undefined ? `${labelLead(label)}${text}` : text
      );
    },
    (error: unknown) => {
      host.notices?.postGroup(
        spawnedIds,
        `The parallel attempts ended abnormally: ${error instanceof Error ? error.message : String(error)}\n` +
          spawnedIds.map(workerNoticeMarker).join("")
      );
    }
  );
  const names = spawnedIds.map(
    (id) => host.orchestrator.status().find((worker) => worker.sessionId === id)?.name ?? id
  );
  return reply(SPAWN_WORKER_TEXTS.attemptsSpawned(names), { sessionIds: spawnedIds });
}

// 装配根注册用的元数据：只读档（本身不读写工作区、不经审批；worker 的调用各自按审批走）；执行模式串行，与登记一致（决策 353）
export function spawnWorkerRegistration(): ToolRegistration {
  return {
    name: SPAWN_WORKER_TOOL,
    description: "在后台派 worker 完成独立子任务，结束时通知",
    parameters: SpawnWorkerParamsSchema,
    tier: "read",
    pathConfinement: { kind: "none" },
    executionMode: "sequential",
  };
}
