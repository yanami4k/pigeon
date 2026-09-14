// worker 命令层（M5.5 S4，决策 040）：/spawn /cancel /workers 的解析与排版，状态栏一行与收尾摘要
// 同一份措辞。纯函数，输出纯字符串（tui 投影到消息区与状态栏）；编排动作本身在 orchestration。
import type { WorkerOutcome, WorkerStatus } from "../orchestration/workers.ts";

export type { SpawnRequest, WorkerOutcome, WorkerStatus } from "../orchestration/workers.ts";

export class WorkerCommandError extends Error {}

export const SPAWN_USAGE =
  '用法：/spawn <角色> [--name <名>] "<任务>"（角色：reviewer / explorer / implementer / tester）';

// 未知命令提示里追加的 worker 命令清单（装配了编排面时才出现）
export const WORKER_COMMANDS_HINT = '、/spawn <角色> "<任务>"、/cancel <worker>、/workers';

// raw = 去掉 "/spawn" 之后的原文；任务可带英文或中文引号，也可不带
export function parseSpawnCommand(raw: string): { role: string; task: string; name?: string } {
  let rest = raw.trim();
  const roleMatch = /^(\S+)\s*/.exec(rest);
  const role = roleMatch?.[1];
  if (roleMatch === null || role === undefined || role.startsWith("--")) {
    throw new WorkerCommandError(SPAWN_USAGE);
  }
  rest = rest.slice(roleMatch[0].length);
  let name: string | undefined;
  const nameMatch = /^--name\s+(\S+)\s*/.exec(rest);
  if (nameMatch !== null) {
    name = nameMatch[1];
    rest = rest.slice(nameMatch[0].length);
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
  return { role, task, ...(name !== undefined ? { name } : {}) };
}

const STATE_LABEL: Record<string, string> = {
  running: "进行中",
  completed: "完成",
  failed: "失败",
  aborted: "中止",
  cancelled: "已取消",
  "turn-limit": "达到轮次上限",
  "wall-clock-limit": "达到墙钟上限",
  "spawn-failed": "派出失败",
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
        `分支 ${worker.branch} ｜ 会话 ${worker.sessionId}`
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
    const files = result.changedFiles;
    lines.push(
      `  分支 ${result.branch} ｜ 改动 ${files.length} 个文件${files.length > 0 ? `：${files.join("、")}` : ""} ｜ ` +
        `Receipt ${result.receiptIds.length} 条`
    );
    if (result.summary !== "") {
      lines.push(
        `  自述：${result.summary}${result.summaryTruncated ? "（已截断，全文见 worker 会话）" : ""}`
      );
    }
  }
  lines.push(
    `  工作树 ${outcome.workspace.path}：改动未提交，审阅与合并由人用 git 完成（trace ${outcome.sessionId} 查看证据链）`
  );
  return lines.join("\n");
}

// /cancel 的目标：按 worker 名或会话 id 定位
export function resolveWorkerRef(workers: readonly WorkerStatus[], ref: string): WorkerStatus {
  const found = workers.find((worker) => worker.name === ref || worker.sessionId === ref);
  if (found === undefined) {
    throw new WorkerCommandError(`未知 worker：${ref}（用 /workers 查看）`);
  }
  return found;
}
