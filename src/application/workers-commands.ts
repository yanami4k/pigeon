// worker 命令层（M5.5 S4，决策 040）：/spawn /cancel /workers 的解析与排版，状态栏一行与收尾摘要
// 同一份措辞。纯函数，输出纯字符串（tui 投影到消息区与状态栏）；编排动作本身在 orchestration。
import type { WorkerOutcome, WorkerStartPoint, WorkerStatus } from "../orchestration/workers.ts";

export type {
  SpawnRequest,
  WorkerOutcome,
  WorkerStartPoint,
  WorkerStatus,
} from "../orchestration/workers.ts";

export class WorkerCommandError extends Error {}

export const SPAWN_USAGE =
  '用法：/spawn <角色> [--name <名> | --attempts <N>] "<任务>"（角色：explorer / implementer / tester；--attempts 并行派发同一任务的 N 个尝试）';

// 决策 279：/take <worker 名> 把已收尾 worker 自己的改动叠进工作目录
export const TAKE_USAGE = "用法：/take <worker 名>";

// 未知命令提示里追加的 worker 命令清单（装配了编排面时才出现）
export const WORKER_COMMANDS_HINT =
  '、/spawn <角色> "<任务>"、/cancel <worker>、/workers、/take <worker>';

// raw = 去掉 "/spawn" 之后的原文；任务可带英文或中文引号，也可不带
export function parseSpawnCommand(raw: string): {
  role: string;
  task: string;
  name?: string;
  attempts?: number;
} {
  let rest = raw.trim();
  const roleMatch = /^(\S+)\s*/.exec(rest);
  const role = roleMatch?.[1];
  if (roleMatch === null || role === undefined || role.startsWith("--")) {
    throw new WorkerCommandError(SPAWN_USAGE);
  }
  rest = rest.slice(roleMatch[0].length);
  let name: string | undefined;
  let attempts: number | undefined;
  for (;;) {
    const nameMatch = /^--name\s+(\S+)\s*/.exec(rest);
    if (nameMatch !== null) {
      name = nameMatch[1];
      rest = rest.slice(nameMatch[0].length);
      continue;
    }
    // M7（决策 069）：并行派发同一任务的 N 个尝试（至少 2），共享任务标识
    const attemptsMatch = /^--attempts\s+(\S+)\s*/.exec(rest);
    if (attemptsMatch !== null) {
      const value = Number(attemptsMatch[1]);
      if (!Number.isInteger(value) || value < 2) {
        throw new WorkerCommandError(`--attempts 需要不小于 2 的整数（${SPAWN_USAGE}）`);
      }
      attempts = value;
      rest = rest.slice(attemptsMatch[0].length);
      continue;
    }
    break;
  }
  if (attempts !== undefined && name !== undefined) {
    throw new WorkerCommandError(`--attempts 派出多个尝试，不能共用 --name（${SPAWN_USAGE}）`);
  }
  let task = rest.trim();
  const quoted =
    (task.startsWith('"') && task.endsWith('"')) || (task.startsWith("“") && task.endsWith("”"));
  if (task.length >= 2 && quoted) {
    task = task.slice(1, -1).trim();
  }
  if (task === "") {
    throw new WorkerCommandError(SPAWN_USAGE);
  }
  return {
    role,
    task,
    ...(name !== undefined ? { name } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
  };
}

const STATE_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  completed: "完成",
  failed: "失败",
  aborted: "中止",
  cancelled: "已取消",
  "turn-limit": "达到轮次上限",
  "wall-clock-limit": "达到墙钟上限",
  "token-limit": "达到 token 上限",
  "spawn-failed": "派出失败",
  // 决策 298
  stalled: "卡住",
};

export function workerStateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

export function renderWorkersStatus(workers: readonly WorkerStatus[]): string {
  if (workers.length === 0) {
    return "本会话尚未派出 worker（用 /spawn 派出）";
  }
  return [
    `worker（${workers.length}）：`,
    ...workers.map(
      (worker) =>
        `  ${worker.name}（${worker.role}）｜ ${workerStateLabel(worker.state)} ｜ ${worker.turns} 轮 ｜ ` +
        // 无工作区的 worker 没有分支（只读的 Reviewer 已退役，决策 137；形状仍可能出现在旧记录里）
        `${worker.branch !== undefined ? `分支 ${worker.branch}` : "无工作区"} ｜ 会话 ${worker.sessionId}`
    ),
  ].join("\n");
}

// 状态栏一行：纯 ASCII（chrome 纪律——worker 名经白名单校验，状态为 ASCII 字面量）；无 worker 时空串
export function workerStatusBar(workers: readonly WorkerStatus[]): string {
  if (workers.length === 0) {
    return "";
  }
  return `workers: ${workers
    .map(
      (worker) =>
        `${worker.name} ${worker.state}${worker.state === "running" ? ` ${worker.turns}t` : ""}`
    )
    .join(" | ")}`;
}

// 收尾摘要：结构化结果的人读投影；合并由人用 git 完成，Pigeon 不自动合并
export function renderWorkerOutcome(outcome: WorkerOutcome): string {
  const lines = [
    `== worker ${outcome.name}（${outcome.role}）收尾：${workerStateLabel(outcome.status)} ｜ ` +
      `${outcome.turns} 轮 ｜ 会话 ${outcome.sessionId} ==`,
  ];
  if (outcome.error !== undefined) {
    lines.push(`  原因：${outcome.error}`);
  }
  const result = outcome.result;
  if (result !== undefined) {
    const files = result.changedFiles ?? [];
    lines.push(
      result.branch !== undefined
        ? `  分支 ${result.branch} ｜ 改动 ${files.length} 个文件${files.length > 0 ? `：${files.join("、")}` : ""}`
        : "  只读审阅（无工作区、无改动）"
    );
    if (result.summary !== "") {
      lines.push(
        `  自述：${result.summary}${result.summaryTruncated ? "（已截断，全文见 worker 会话）" : ""}`
      );
    }
  }
  lines.push(
    outcome.workspace.kind === "git-worktree"
      ? `  工作树 ${outcome.workspace.path}：改动未提交，审阅与合并由人用 git 完成（trace ${outcome.sessionId} 查看证据链）`
      : `  无工作区：只读审阅不产生文件改动（trace ${outcome.sessionId} 查看证据链）`
  );
  // 决策 279：起点快照与只取其自身改动的取用方式（与 spawn_worker 返回的那一行同一口径，取用入口为 /take）
  if (outcome.start !== undefined && outcome.workspace.kind === "git-worktree") {
    lines.push(`  ${workerStartLine(outcome.start, `用 /take ${outcome.name}`)}`);
  }
  return lines.join("\n");
}

// 决策 279：worker 起点与取用方式的一行——快照起点写明带入了几个未提交的文件，HEAD 起点写明派出时没有未提交的文件；
// 取用方式由调用方给（agent 见 take_worker 工具，人见 /take）
export function workerStartLine(start: WorkerStartPoint, takeHint: string): string {
  const commit = start.commit.slice(0, 12);
  const origin = start.snapshot
    ? `起点：快照 ${commit}（含派出时 ${start.files.length} 个未提交的文件）`
    : `起点：提交 ${commit}（派出时没有未提交的文件）`;
  return `${origin}；要把它的改动叠进你的工作目录，${takeHint}。`;
}

// /cancel 的目标：按 worker 名或会话 id 定位
export function resolveWorkerRef(workers: readonly WorkerStatus[], ref: string): WorkerStatus {
  const found = workers.find((worker) => worker.name === ref || worker.sessionId === ref);
  if (found === undefined) {
    throw new WorkerCommandError(`未知 worker：${ref}（用 /workers 查看）`);
  }
  return found;
}

// M7（决策 069）：并行同任务派发的收尾摘要——各尝试的会话与标签
export function renderAttemptGroupOutcome(result: {
  taskKey: string;
  attempts: ReadonlyArray<{ sessionId: string; label: string }>;
}): string {
  return [
    `== 并行尝试收尾 ｜ 任务标识 ${result.taskKey} ==`,
    ...result.attempts.map((attempt) => `  会话 ${attempt.sessionId} ｜ ${attempt.label}`),
  ].join("\n");
}
