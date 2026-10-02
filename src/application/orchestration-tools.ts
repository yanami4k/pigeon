// 编排积木的另外四件工具（决策 294、297、298）：wait_workers 等 worker 结束并交回结构化结果（任一或全部、带超时）、
// worker_status 查看状态、message_worker 给在跑的 worker 递话、stop_worker 停掉 worker。与 spawn_worker 共用同一个工具槽
// （编排器、派出额度与完成通知），注册范围相同。四件都是只读档：不读写工作区，不经审批。
// 工具说明、参数说明与返回文字为定稿原文（wait_workers 的最长等待跟着每个 worker 的时间上限配置走，取缺省时即定稿的 1800 秒）。
// 同一结果不在对话里出现两遍（297）：等待期间结束的 worker 不另发通知；已结束、通知还没递出的撤回通知、交回完整结果；
// 通知已递出的只交回一句。
import { type Static, Type } from "typebox";
import {
  previousRunWorkerText,
  type WaitResult,
  type WorkerOutcome,
  type WorkerStatus,
} from "../orchestration/workers.ts";
import type { SessionId } from "../state/ids.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import {
  MESSAGE_WORKER_TOOL,
  SPAWN_WORKER_TEXTS,
  type SpawnWorkerHost,
  type SpawnWorkerSettings,
  type SpawnWorkerSlot,
  STOP_WORKER_TOOL,
  WAIT_WORKERS_TOOL,
  WORKER_STATUS_TOOL,
} from "./spawn-worker-tool.ts";
import { previousRunNote, workerStateLabel } from "./workers-commands.ts";

export { MESSAGE_WORKER_TOOL, STOP_WORKER_TOOL, WAIT_WORKERS_TOOL, WORKER_STATUS_TOOL };

export const WAIT_DEFAULT_SECONDS = 300;

export function waitMaxSeconds(settings: Pick<SpawnWorkerSettings, "workerWallClockMs">): number {
  return Math.max(1, Math.round(settings.workerWallClockMs / 1000));
}

// ---- 说明（定稿原文） ----

export function waitWorkersDescription(
  _settings: Pick<SpawnWorkerSettings, "workerWallClockMs">
): string {
  return `等 worker 结束并交回结果。workers 给出要等的 worker 名字，不给即等所有还在跑的；mode 为 any 时任一个结束就返回，为 all 时全部结束才返回；到 timeout_seconds 仍未结束即返回当时的状态，没结束的 worker 继续跑。已经结束的 worker 立即交回。每个结果写明状态（完成、失败、超时、撞上限、取消、卡住）、错误类型、最后一段输出、改动的文件与会话记录位置。`;
}

export function waitWorkersParamsSchema(settings: Pick<SpawnWorkerSettings, "workerWallClockMs">) {
  const max = waitMaxSeconds(settings);
  return Type.Object({
    workers: Type.Optional(
      Type.Array(Type.String(), { description: "要等的 worker 名字；不给即所有还在跑的" })
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("any"), Type.Literal("all")], {
        description: "any：任一个结束即返回；all：全部结束才返回（缺省）",
      })
    ),
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: max,
        description: `最多等多少秒（缺省 ${WAIT_DEFAULT_SECONDS}，最多 ${max}）`,
      })
    ),
  });
}
export type WaitWorkersParams = Static<ReturnType<typeof waitWorkersParamsSchema>>;

export const WORKER_STATUS_DESCRIPTION = `查看 worker 的状态：名字、角色、标签、状态、已用轮数与时间；已结束的附结果摘要。workers 不给即列出全部。要等结果用 ${WAIT_WORKERS_TOOL}，不要反复调用本工具轮询。`;

export const WorkerStatusParamsSchema = Type.Object({
  workers: Type.Optional(
    Type.Array(Type.String(), { description: "要查看的 worker 名字；不给即全部" })
  ),
});
export type WorkerStatusParams = Static<typeof WorkerStatusParamsSchema>;

export const MESSAGE_WORKER_DESCRIPTION =
  "给一个还在跑的 worker 发一段补充说明或更正，它在下一轮看到。已结束的 worker 收不到。";

export const MessageWorkerParamsSchema = Type.Object({
  worker: Type.String({ description: "worker 的名字" }),
  message: Type.String({ description: "要告诉它的话" }),
});
export type MessageWorkerParams = Static<typeof MessageWorkerParamsSchema>;

export const STOP_WORKER_DESCRIPTION =
  "停掉一个还在跑或排队的 worker；它已做的改动留在分支上，结果照常交回。";

export const StopWorkerParamsSchema = Type.Object({
  worker: Type.String({ description: "worker 的名字" }),
});
export type StopWorkerParams = Static<typeof StopWorkerParamsSchema>;

// ---- 返回文字（定稿原文） ----

// 298 的六种状态
export function outcomeStatusWord(outcome: Pick<WorkerOutcome, "status">): string {
  switch (outcome.status) {
    case "completed":
      return "完成";
    case "wall-clock-limit":
      return "超时";
    case "turn-limit":
    case "token-limit":
      return "撞上限";
    case "cancelled":
    case "aborted":
      return "取消";
    case "stalled":
      return "卡住";
    default:
      return "失败";
  }
}

function fileList(files: readonly string[]): string {
  return files.length > 0 ? files.join("、") : "无";
}

// 一个 worker 的结构化结果
export function structuredOutcomeText(outcome: WorkerOutcome): string {
  const branch =
    outcome.result?.branch ??
    (outcome.workspace.kind === "git-worktree" ? outcome.workspace.branch : "无");
  const files = outcome.result?.changedFiles ?? [];
  const lines = [
    `worker ${outcome.name}（${outcome.role}）${
      outcome.label !== undefined ? `，标签 ${outcome.label}` : ""
    }：状态 ${outcome.status === "completed" ? "完成" : outcomeStatusWord(outcome)}${
      outcome.errorKind !== undefined ? `；错误类型 ${outcome.errorKind}` : ""
    }${outcome.error !== undefined ? `（${outcome.error}）` : ""}${
      outcome.recoverable === true ? "；可恢复：人补批后它可以接着做" : ""
    }。`,
    `分支：${branch}。改动的文件（${files.length}）：${fileList(files)}。`,
    `最后一段输出：${outcome.result?.summary ?? ""}${
      outcome.result?.summaryTruncated === true
        ? SPAWN_WORKER_TEXTS.truncated(outcome.sessionId)
        : ""
    }`,
    `会话记录：${outcome.transcript ?? `worker 会话 ${outcome.sessionId}`}`,
  ];
  if (outcome.start !== undefined && outcome.workspace.kind === "git-worktree") {
    lines.push(SPAWN_WORKER_TEXTS.start(outcome.start, outcome.name));
  }
  return lines.join("\n");
}

export const ORCHESTRATION_TEXTS = {
  alreadyNotified: (outcome: WorkerOutcome) =>
    `worker ${outcome.name}（${outcome.role}）已结束（${outcomeStatusWord(outcome)}），结果见此前的通知。`,
  stillRunning: (status: WorkerStatus, seconds: number) =>
    `worker ${status.name}（${status.role}）还没结束（${workerStateLabel(status.state)}，${status.turns} 轮，已用 ${seconds} 秒），继续在跑。`,
  timedOut: (seconds: number) => `等了 ${seconds} 秒，仍有 worker 没结束。`,
  nothingToWait: "没有要等的 worker：都已结束或还没派出。",
  unknown: (name: string) => `没有名为 ${name} 的 worker；用 spawn_worker 交回的名字。`,
  noWorkers: "还没有派出 worker。",
  messageSent: (name: string) => `已把话递给 worker ${name}，它在下一轮看到。`,
  // 验收修订：它在下一轮之前结束（最后一轮之后才递到、正在收尾），如实交回
  messageUndelivered: (name: string) =>
    `未送达：worker ${name} 已结束或正在收尾。要这段话生效，另派一个 worker 或自己做。`,
  messageSettled: (name: string) => `worker ${name} 已结束，收不到消息。`,
  stopRequested: (name: string) => `已停掉 worker ${name}；它已做的改动留在分支上，结果照常交回。`,
  stopSettled: (name: string) => `worker ${name} 已结束，不需要停。`,
  unbound: "本会话没有装配编排器。",
} as const;

// worker_status 的一行
export function statusLine(status: WorkerStatus, now: number): string {
  const seconds = Math.max(0, Math.round((now - status.startedAt) / 1000));
  const head = `${status.name}（${status.role}）${
    status.label !== undefined ? `，标签 ${status.label}` : ""
  }：${
    status.outcome !== undefined
      ? outcomeStatusWord(status.outcome)
      : workerStateLabel(status.state)
  }，${status.turns} 轮，${
    status.outcome?.durationMs !== undefined
      ? `用时 ${Math.round(status.outcome.durationMs / 1000)} 秒`
      : `已用 ${seconds} 秒`
  }`;
  if (status.outcome === undefined) {
    return `${head}。`;
  }
  const summary = status.outcome.result?.summary ?? "";
  return `${head}${previousRunNote(status)}。结果摘要：${summary.length > 200 ? `${summary.slice(0, 200)}…` : summary}`;
}

// ---- 执行 ----

function reply<T>(text: string, details: T): PigeonToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

// 派出方看得到的 worker：它自己派出的（主会话为全部由它派出的，含人派的）
function ownWorkers(host: SpawnWorkerHost): WorkerStatus[] {
  const all = host.orchestrator.status();
  return host.from === undefined
    ? all.filter((worker) => worker.depth === undefined || worker.depth === 1)
    : all.filter((worker) => worker.parentSessionId === host.from);
}

function findWorker(host: SpawnWorkerHost, name: string): WorkerStatus | undefined {
  const trimmed = name.trim();
  return ownWorkers(host).find((worker) => worker.name === trimmed || worker.sessionId === trimmed);
}

export interface WaitWorkersDetails {
  settled: WorkerOutcome[];
  pending: WorkerStatus[];
  timedOut: boolean;
  unknown?: string[];
}

// 等待并排版（工具与程序调用共用）：signal 为调用方的中止
export async function waitWorkers(
  host: SpawnWorkerHost,
  settings: Pick<SpawnWorkerSettings, "workerWallClockMs">,
  params: WaitWorkersParams,
  signal?: AbortSignal
): Promise<{ text: string; details: WaitWorkersDetails }> {
  const unknown: string[] = [];
  let targets: WorkerStatus[];
  if (params.workers !== undefined && params.workers.length > 0) {
    targets = [];
    for (const name of params.workers) {
      const found = findWorker(host, name);
      if (found === undefined) unknown.push(name);
      else if (!targets.includes(found)) targets.push(found);
    }
  } else {
    targets = ownWorkers(host).filter(
      (worker) => worker.state === "running" || worker.state === "queued"
    );
  }
  if (unknown.length > 0) {
    return {
      text: unknown.map((name) => ORCHESTRATION_TEXTS.unknown(name)).join("\n"),
      details: { settled: [], pending: [], timedOut: false, unknown },
    };
  }
  if (targets.length === 0) {
    return {
      text: ORCHESTRATION_TEXTS.nothingToWait,
      details: { settled: [], pending: [], timedOut: false },
    };
  }
  const seconds = Math.min(
    params.timeout_seconds ?? WAIT_DEFAULT_SECONDS,
    waitMaxSeconds(settings)
  );
  const ids = targets.map((worker) => worker.sessionId);
  host.notices?.beginWait(ids);
  let result: WaitResult;
  try {
    result = await host.orchestrator.wait(ids, {
      mode: params.mode ?? "all",
      timeoutMs: seconds * 1000,
      ...(signal !== undefined ? { signal } : {}),
      ...(host.from !== undefined ? { waiter: host.from } : {}),
    });
  } finally {
    host.notices?.endWait(ids);
  }
  const now = Date.now();
  const parts = result.settled.map((outcome) =>
    host.notices?.claim(outcome.sessionId) === "notified"
      ? ORCHESTRATION_TEXTS.alreadyNotified(outcome)
      : structuredOutcomeText(outcome)
  );
  for (const pending of result.pending) {
    parts.push(
      ORCHESTRATION_TEXTS.stillRunning(pending, Math.round((now - pending.startedAt) / 1000))
    );
  }
  if (result.timedOut) {
    parts.unshift(ORCHESTRATION_TEXTS.timedOut(seconds));
  }
  return {
    text: parts.join("\n\n"),
    details: { settled: result.settled, pending: result.pending, timedOut: result.timedOut },
  };
}

export function createWaitWorkersTool(
  slot: SpawnWorkerSlot
): PigeonAgentTool<ReturnType<typeof waitWorkersParamsSchema>, WaitWorkersDetails> {
  return {
    name: WAIT_WORKERS_TOOL,
    label: WAIT_WORKERS_TOOL,
    description: waitWorkersDescription(slot.settings),
    parameters: waitWorkersParamsSchema(slot.settings),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const host = slot.host;
      if (host === undefined) {
        return reply(ORCHESTRATION_TEXTS.unbound, { settled: [], pending: [], timedOut: false });
      }
      const { text, details } = await waitWorkers(host, slot.settings, params, signal);
      return reply(text, details);
    },
  };
}

export function createWorkerStatusTool(
  slot: SpawnWorkerSlot
): PigeonAgentTool<typeof WorkerStatusParamsSchema, { workers: WorkerStatus[] }> {
  return {
    name: WORKER_STATUS_TOOL,
    label: WORKER_STATUS_TOOL,
    description: WORKER_STATUS_DESCRIPTION,
    parameters: WorkerStatusParamsSchema,
    executionMode: "sequential",
    async execute(_id, params) {
      const host = slot.host;
      if (host === undefined) {
        return reply(ORCHESTRATION_TEXTS.unbound, { workers: [] });
      }
      const now = Date.now();
      if (params.workers !== undefined && params.workers.length > 0) {
        const lines: string[] = [];
        const found: WorkerStatus[] = [];
        for (const name of params.workers) {
          const worker = findWorker(host, name);
          if (worker === undefined) lines.push(ORCHESTRATION_TEXTS.unknown(name));
          else {
            found.push(worker);
            lines.push(statusLine(worker, now));
          }
        }
        return reply(lines.join("\n"), { workers: found });
      }
      const workers = ownWorkers(host);
      if (workers.length === 0) {
        return reply(ORCHESTRATION_TEXTS.noWorkers, { workers: [] });
      }
      return reply(workers.map((worker) => statusLine(worker, now)).join("\n"), { workers });
    },
  };
}

export function createMessageWorkerTool(
  slot: SpawnWorkerSlot
): PigeonAgentTool<typeof MessageWorkerParamsSchema, { worker: string; delivered: boolean }> {
  return {
    name: MESSAGE_WORKER_TOOL,
    label: MESSAGE_WORKER_TOOL,
    description: MESSAGE_WORKER_DESCRIPTION,
    parameters: MessageWorkerParamsSchema,
    executionMode: "sequential",
    async execute(_id, params) {
      const host = slot.host;
      if (host === undefined) {
        return reply(ORCHESTRATION_TEXTS.unbound, { worker: params.worker, delivered: false });
      }
      const worker = findWorker(host, params.worker);
      if (worker === undefined) {
        return reply(ORCHESTRATION_TEXTS.unknown(params.worker), {
          worker: params.worker,
          delivered: false,
        });
      }
      if (worker.previousRun !== undefined) {
        return reply(previousRunWorkerText(worker, "send"), {
          worker: worker.name,
          delivered: false,
        });
      }
      if (worker.state !== "running" && worker.state !== "queued") {
        return reply(ORCHESTRATION_TEXTS.messageSettled(worker.name), {
          worker: worker.name,
          delivered: false,
        });
      }
      const sent = await host.orchestrator.send(
        worker.sessionId,
        `[来自派出方的消息] ${params.message}`
      );
      return sent === "delivered"
        ? reply(ORCHESTRATION_TEXTS.messageSent(worker.name), {
            worker: worker.name,
            delivered: true,
          })
        : reply(ORCHESTRATION_TEXTS.messageUndelivered(worker.name), {
            worker: worker.name,
            delivered: false,
          });
    },
  };
}

export function createStopWorkerTool(
  slot: SpawnWorkerSlot
): PigeonAgentTool<typeof StopWorkerParamsSchema, { worker: string; stopped: boolean }> {
  return {
    name: STOP_WORKER_TOOL,
    label: STOP_WORKER_TOOL,
    description: STOP_WORKER_DESCRIPTION,
    parameters: StopWorkerParamsSchema,
    executionMode: "sequential",
    async execute(_id, params) {
      const host = slot.host;
      if (host === undefined) {
        return reply(ORCHESTRATION_TEXTS.unbound, { worker: params.worker, stopped: false });
      }
      const worker = findWorker(host, params.worker);
      if (worker === undefined) {
        return reply(ORCHESTRATION_TEXTS.unknown(params.worker), {
          worker: params.worker,
          stopped: false,
        });
      }
      if (worker.previousRun !== undefined) {
        return reply(previousRunWorkerText(worker, "cancel"), {
          worker: worker.name,
          stopped: false,
        });
      }
      if (worker.state !== "running" && worker.state !== "queued") {
        return reply(ORCHESTRATION_TEXTS.stopSettled(worker.name), {
          worker: worker.name,
          stopped: false,
        });
      }
      await host.orchestrator.cancel(worker.sessionId as SessionId);
      return reply(ORCHESTRATION_TEXTS.stopRequested(worker.name), {
        worker: worker.name,
        stopped: true,
      });
    },
  };
}

// 装配根注册用的元数据：四件都是只读档、串行
export function orchestrationToolRegistrations(
  settings: Pick<SpawnWorkerSettings, "workerWallClockMs">
): ToolRegistration[] {
  const base = {
    tier: "read" as const,
    pathConfinement: { kind: "none" as const },
    executionMode: "sequential" as const,
  };
  return [
    {
      name: WAIT_WORKERS_TOOL,
      description: "等 worker 结束并交回结构化结果",
      parameters: waitWorkersParamsSchema(settings),
      ...base,
    },
    {
      name: WORKER_STATUS_TOOL,
      description: "查看 worker 的状态",
      parameters: WorkerStatusParamsSchema,
      ...base,
    },
    {
      name: MESSAGE_WORKER_TOOL,
      description: "给在跑的 worker 递话",
      parameters: MessageWorkerParamsSchema,
      ...base,
    },
    {
      name: STOP_WORKER_TOOL,
      description: "停掉 worker",
      parameters: StopWorkerParamsSchema,
      ...base,
    },
  ];
}

export function createOrchestrationTools(slot: SpawnWorkerSlot) {
  return [
    createWaitWorkersTool(slot),
    createWorkerStatusTool(slot),
    createMessageWorkerTool(slot),
    createStopWorkerTool(slot),
  ];
}
