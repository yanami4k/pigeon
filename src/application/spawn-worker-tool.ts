// 主 agent 派 worker 的工具 spawn_worker（决策 264–268、271）：调用后等到 worker 收尾，把分支、改动文件与摘要作为工具
// 返回值交回；执行模式为可并行，一次回复里多次调用即并行派出。工具说明、参数说明与各情形的返回文字都是冻结原文，
// 一字不改（两个上限数值可配置，取缺省时逐字即冻结原文）。
// - 底层只用会话编排器现有的派出与等待结果（workers.ts），不另写一套 worker 生命周期；attempts 走现有的并行同任务
//   派发与验证标签（attempt-group.ts），每份一段交回。
// - 额度（268）：同时在跑的上限由编排器排队实现（人用 /spawn 派的一并计算）；一次运行里 agent 派的个数在这里计（人派的
//   不计入），满了按冻结文字拒绝；本次运行的总额度用完时拒绝再派（正在跑的由额度的持有方停掉）。
// - 等待中被中止（主 agent 撞上自己的时间上限、额度用完、人中断）：本次调用派出的 worker 一并取消。
// - 注册范围（265–267）：只给终端界面与 pigeon run 的主会话注册；命令行对话、worker 自己、沙箱会话与跑批器各条件都不注册。
//   审批照现有规矩（266）：本工具只读档、不经审批，worker 各自的写与命令调用按各入口原有的审批走。
import { type Static, Type } from "typebox";
import { isGitWorkspace } from "../orchestration/checkpoint.ts";
import { isWorkerRole, WORKER_ROLES } from "../orchestration/roles.ts";
import type {
  WorkerOrchestrator,
  WorkerOutcome,
  WorkerStartPoint,
} from "../orchestration/workers.ts";
import { worktreeBranchFor } from "../orchestration/worktree.ts";
import type { SessionId } from "../state/ids.ts";
import type { OutcomeLabel } from "../state/outcome-label.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import { workerStartLine } from "./workers-commands.ts";

export const SPAWN_WORKER_TOOL = "spawn_worker";
// 决策 279：取用 worker 自身改动的工具名（工具在 take-worker-tool.ts，与本工具共用工具槽；返回文字里要提到它）
export const TAKE_WORKER_TOOL = "take_worker";

// 两个上限（268）：同时在跑的 worker 数、一次运行里 agent 派出的总数；可配置
export interface SpawnWorkerLimits {
  maxConcurrent: number;
  maxAgentSpawns: number;
}

export const DEFAULT_SPAWN_WORKER_LIMITS: SpawnWorkerLimits = {
  maxConcurrent: 4,
  maxAgentSpawns: 16,
};

export function assertSpawnWorkerLimits(limits: SpawnWorkerLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`派 worker 的上限需要正整数：${key}=${value}`);
    }
  }
}

// 工具说明（冻结原文；两个数值取自上限配置）
export function spawnWorkerDescription(limits: SpawnWorkerLimits): string {
  return [
    "派一个 worker 去完成一项独立的子任务，等它做完，把它的分支、改动过的文件与工作摘要交回给你。",
    "worker 从派出时主工作目录的快照开工（含未提交的改动与未被忽略的新文件），在自己的 git 工作树与分支里干活；看不到本会话的对话。",
    `要并行，就在同一次回复里多次调用本工具，每次派一个；同时最多跑 ${limits.maxConcurrent} 个，多的排队；一次运行最多派 ${limits.maxAgentSpawns} 个。`,
    "何时派：任务能拆成互不依赖的几块、并行能明显省时间时才派，通常 2 到 4 个就够；简单的活、前后依赖紧的活自己做。每个 worker 都要重新读代码，派得越多花得越多。",
    "任务要写得能独立完成：目标、相关文件、完成的标准都写清楚。worker 不能向你提问，也不能再派 worker。",
    "角色决定 worker 能用的工具：explorer 只能读代码与检索历史会话，适合调查与定位；implementer 能读写文件、不能跑命令，适合按明确的方案改代码；tester 能读文件与跑命令、不能改文件，适合运行与诊断测试。",
    "worker 的改动不会自动并入你的分支：看过交回的分支与摘要后，由你决定合不合、怎么合。",
  ].join("\n");
}

// 参数（说明为冻结原文）。role 为三个角色的枚举（冻结参数表的类型），写错时上游的参数校验先拒绝；工具自己仍按冻结文字
// 兜底回话（角色写错，通常走不到）。task 不设下限，为空时由工具按冻结文字回话
export const SpawnWorkerParamsSchema = Type.Object({
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
        "同一任务并行派出的份数；给了即各做一份，做完后按验证命令给每份标上通过、未通过或未知，全部交回",
    })
  ),
});
export type SpawnWorkerParams = Static<typeof SpawnWorkerParamsSchema>;

// 摘要截断的补句、各情形的返回文字（冻结原文）
export const SPAWN_WORKER_TEXTS = {
  completed: (w: WorkerFacts) =>
    `worker ${w.name}（${w.role}）已完成。分支：${w.branch}。改动的文件（${w.files.length}）：${fileList(w.files)}。摘要：${w.summary}`,
  truncated: (sessionId: string) => `（摘要已截断，全文在 worker 会话 ${sessionId} 里）`,
  limitHit: (w: WorkerFacts, limit: "轮数" | "时间") =>
    `worker ${w.name}（${w.role}）撞上${limit}上限，没有做完。分支：${w.branch}。已改动的文件（${w.files.length}）：${fileList(w.files)}。摘要：${w.summary}`,
  failed: (w: Pick<WorkerFacts, "name" | "role" | "branch">, reason: string) =>
    `worker ${w.name}（${w.role}）失败：${reason}。分支 ${w.branch} 上可能有部分改动。`,
  cancelled: (w: Pick<WorkerFacts, "name" | "role" | "branch">) =>
    `worker ${w.name}（${w.role}）被取消。分支 ${w.branch} 上可能有部分改动。`,
  attempt: (index: number, verdict: "通过" | "未通过" | "未知") => `第 ${index} 份（${verdict}）：`,
  spawnLimit: (max: number) =>
    `本次运行派出的 worker 已达 ${max} 个上限。不要再派；用已有的结果，或自己完成。`,
  budgetExhausted: "本次运行的额度已用完，不能再派 worker；正在跑的 worker 已停止。",
  notGit: "当前工作区不是 git 仓库，不能派 worker。",
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

// 一次运行的派出额度（268）：agent 派出的个数按运行计——运行标识变了（终端界面里每条输入是一次运行）即从零计；
// 总额度用完由持有方标记（pigeon run 给了 token 上限时）
export class SpawnWorkerBudget {
  readonly #maxAgentSpawns: number;
  readonly #runKey: () => string | undefined;
  #key: string | undefined;
  #spawned = 0;
  #exhausted = false;

  constructor(options: { maxAgentSpawns: number; runKey?: () => string | undefined }) {
    this.#maxAgentSpawns = options.maxAgentSpawns;
    this.#runKey = options.runKey ?? (() => undefined);
  }

  get maxAgentSpawns(): number {
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

  // 再派 count 个是否超过上限；不超过即记下
  tryTake(count: number): boolean {
    this.#sync();
    if (this.#spawned + count > this.#maxAgentSpawns) {
      return false;
    }
    this.#spawned += count;
    return true;
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
  onSpawned: (sessionIds: readonly string[]) => void;
}

export interface SpawnAttemptsResult {
  // 按派出顺序
  outcomes: WorkerOutcome[];
  // 会话号 → 由会话现算的标签（按验证命令；未配置即未知）
  labels: ReadonlyMap<string, OutcomeLabel>;
}

// 工具执行时要用的会话侧能力（装配方在编排器建好后绑定）
export interface SpawnWorkerHost {
  // status 供 take_worker 找 worker（决策 279）
  orchestrator: Pick<WorkerOrchestrator, "spawn" | "awaitResult" | "cancel" | "status">;
  // 治理根（主仓库根）：是不是 git 仓库
  governanceRoot: string;
  spawnAttempts(request: SpawnAttemptsRequest): Promise<SpawnAttemptsResult>;
  budget: SpawnWorkerBudget;
}

// 注册开关与晚绑定：装配运行面时注册工具，编排器（需要运行面本身）建好后再 bind。未绑定即被调用属装配故障，按失败回话
export class SpawnWorkerSlot {
  readonly limits: SpawnWorkerLimits;
  #host: SpawnWorkerHost | undefined;

  constructor(limits: SpawnWorkerLimits = DEFAULT_SPAWN_WORKER_LIMITS) {
    assertSpawnWorkerLimits(limits);
    this.limits = limits;
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
  rejected?: "not-git" | "unknown-role" | "empty-task" | "spawn-limit" | "budget" | "unbound";
}

const VERDICT_TEXT: Readonly<Record<OutcomeLabel, "通过" | "未通过" | "未知">> = {
  Passed: "通过",
  Failed: "未通过",
  Unknown: "未知",
  Abandoned: "未知",
  InfrastructureError: "未知",
};

// 一个 worker 收尾后交回的文字。决策 279（271 修订）：有工作树的 worker 另起一行写明起点快照与只取其自身改动的取用方式
// （额度用完的文字不加）
export function workerOutcomeText(outcome: WorkerOutcome, budgetExhausted = false): string {
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
  switch (outcome.status) {
    case "completed":
      return SPAWN_WORKER_TEXTS.completed(facts) + suffix + start;
    case "turn-limit":
      return SPAWN_WORKER_TEXTS.limitHit(facts, "轮数") + suffix + start;
    case "wall-clock-limit":
      return SPAWN_WORKER_TEXTS.limitHit(facts, "时间") + suffix + start;
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

function reply(text: string, details: SpawnWorkerDetails): PigeonToolResult<SpawnWorkerDetails> {
  return { content: [{ type: "text", text }], details };
}

// 派出前的检查：按冻结文字回话的几种情形
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
    return reply(SPAWN_WORKER_TEXTS.spawnLimit(host.budget.maxAgentSpawns), {
      sessionIds: [],
      rejected: "spawn-limit",
    });
  }
  return undefined;
}

export function createSpawnWorkerTool(
  slot: SpawnWorkerSlot
): PigeonAgentTool<typeof SpawnWorkerParamsSchema, SpawnWorkerDetails> {
  return {
    name: SPAWN_WORKER_TOOL,
    label: SPAWN_WORKER_TOOL,
    description: spawnWorkerDescription(slot.limits),
    parameters: SpawnWorkerParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<SpawnWorkerDetails>> {
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
      const spawned: SessionId[] = [];
      // 等待中被中止：本次调用派出的 worker 一并取消
      const onAbort = () => {
        for (const id of spawned) {
          host.orchestrator.cancel(id).catch(() => {});
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (params.attempts !== undefined) {
          return await runAttempts(host, params, spawned, signal);
        }
        let id: SessionId;
        try {
          id = host.orchestrator.spawn({
            role: params.role,
            task: params.task,
            ...(params.name !== undefined ? { name: params.name } : {}),
          });
        } catch (error) {
          const name = params.name ?? params.role;
          return reply(
            SPAWN_WORKER_TEXTS.failed(
              { name, role: params.role, branch: worktreeBranchFor(name) },
              error instanceof Error ? error.message : String(error)
            ),
            { sessionIds: [] }
          );
        }
        spawned.push(id);
        if (signal?.aborted === true) {
          onAbort();
        }
        const outcome = await host.orchestrator.awaitResult(id);
        return reply(workerOutcomeText(outcome, host.budget.exhausted), { sessionIds: [id] });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

// 多份尝试（069 / 071）：并行同任务派发，按验证命令给每份标签，每份一段交回
async function runAttempts(
  host: SpawnWorkerHost,
  params: SpawnWorkerParams,
  spawned: SessionId[],
  signal: AbortSignal | undefined
): Promise<PigeonToolResult<SpawnWorkerDetails>> {
  const result = await host.spawnAttempts({
    role: params.role,
    task: params.task,
    count: params.attempts ?? 2,
    onSpawned: (ids) => {
      spawned.push(...(ids as SessionId[]));
      if (signal?.aborted === true) {
        for (const id of ids) {
          host.orchestrator.cancel(id as SessionId).catch(() => {});
        }
      }
    },
  });
  const text = result.outcomes
    .map(
      (outcome, index) =>
        SPAWN_WORKER_TEXTS.attempt(
          index + 1,
          VERDICT_TEXT[result.labels.get(outcome.sessionId) ?? "Unknown"]
        ) + workerOutcomeText(outcome, host.budget.exhausted)
    )
    .join("\n\n");
  return reply(text, { sessionIds: result.outcomes.map((outcome) => outcome.sessionId) });
}

// 装配根注册用的元数据：只读档（本身不读写工作区、不经审批；worker 的调用各自按审批走），可并行
export function spawnWorkerRegistration(): ToolRegistration {
  return {
    name: SPAWN_WORKER_TOOL,
    description: "派 worker 完成独立子任务并等其交回结果",
    parameters: SpawnWorkerParamsSchema,
    tier: "read",
    pathConfinement: { kind: "none" },
    executionMode: "parallel",
  };
}
