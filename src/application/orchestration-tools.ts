// 编排积木的另外四件工具（决策 294、297、298）：wait_workers 等 worker 结束并交回结构化结果（任一或全部、带超时）、
// worker_status 查看状态、message_worker 给在跑的 worker 递话、stop_worker 停掉 worker。与 spawn_worker 共用同一个工具槽
// （编排器、派出额度与完成通知），注册范围相同。四件都是只读档：不读写工作区，不经审批。
// 工具说明、参数说明与返回文字为定稿原文（wait_workers 的最长等待跟着每个 worker 的时间上限配置走，取缺省时即定稿的 1800 秒）。
// 同一结果不在对话里出现两遍（297）：等待期间结束的 worker 不另发通知；已结束、通知还没递出的撤回通知、交回完整结果；
// 通知已递出的只交回一句。
import { type Static, Type } from "typebox";
import type { WaitResult, WorkerOutcome, WorkerStatus } from "../orchestration/workers.ts";
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

export { MESSAGE_WORKER_TOOL, STOP_WORKER_TOOL, WAIT_WORKERS_TOOL, WORKER_STATUS_TOOL };

export const WAIT_DEFAULT_SECONDS = 300;

export function waitMaxSeconds(settings: Pick<SpawnWorkerSettings, "workerWallClockMs">): number {
  return Math.max(1, Math.round(settings.workerWallClockMs / 1000));
}

// ---- 说明（定稿原文） ----

export function waitWorkersDescription(
  _settings: Pick<SpawnWorkerSettings, "workerWallClockMs">
): string {
  return "Wait for workers to finish and return their results. workers gives the names of the workers to wait for; if omitted, waits for all that are still running. With mode any, returns as soon as any one finishes; with all, returns only when all have finished. If they have not finished by timeout_seconds, returns their status at that point, and unfinished workers keep running. Workers that have already finished are returned immediately. Each result states the status (completed, failed, timed out, hit a limit, cancelled, stalled), the error kind, the last output, the changed files, and where the session record is.";
}

export function waitWorkersParamsSchema(settings: Pick<SpawnWorkerSettings, "workerWallClockMs">) {
  const max = waitMaxSeconds(settings);
  return Type.Object({
    workers: Type.Optional(
      Type.Array(Type.String(), {
        description: "Names of the workers to wait for; if omitted, all that are still running",
      })
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("any"), Type.Literal("all")], {
        description:
          "any: return as soon as any one finishes; all: return only when all have finished (default)",
      })
    ),
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: max,
        description: `Maximum seconds to wait (default ${WAIT_DEFAULT_SECONDS}, at most ${max})`,
      })
    ),
  });
}
export type WaitWorkersParams = Static<ReturnType<typeof waitWorkersParamsSchema>>;

export const WORKER_STATUS_DESCRIPTION = `Show worker status: name, role, label, state, and the turns and time used; finished workers include a summary of the result. If workers is omitted, lists all. To wait for results, use ${WAIT_WORKERS_TOOL}; do not poll by calling this tool repeatedly.`;

export const WorkerStatusParamsSchema = Type.Object({
  workers: Type.Optional(
    Type.Array(Type.String(), { description: "Names of the workers to show; if omitted, all" })
  ),
});
export type WorkerStatusParams = Static<typeof WorkerStatusParamsSchema>;

export const MESSAGE_WORKER_DESCRIPTION =
  "Send a running worker additional instructions or a correction; it sees them in its next turn. Finished workers cannot receive messages.";

export const MessageWorkerParamsSchema = Type.Object({
  worker: Type.String({ description: "The worker's name" }),
  message: Type.String({ description: "What to tell it" }),
});
export type MessageWorkerParams = Static<typeof MessageWorkerParamsSchema>;

export const STOP_WORKER_DESCRIPTION =
  "Stop a running or queued worker; the changes it has made stay on its branch, and its result is returned as usual.";

export const StopWorkerParamsSchema = Type.Object({
  worker: Type.String({ description: "The worker's name" }),
});
export type StopWorkerParams = Static<typeof StopWorkerParamsSchema>;

// ---- 返回文字（定稿原文） ----

// 298 的六种状态
export function outcomeStatusWord(outcome: Pick<WorkerOutcome, "status">): string {
  switch (outcome.status) {
    case "completed":
      return "completed";
    case "wall-clock-limit":
      return "timed out";
    case "turn-limit":
    case "token-limit":
      return "hit a limit";
    case "cancelled":
    case "aborted":
      return "cancelled";
    case "stalled":
      return "stalled";
    default:
      return "failed";
  }
}

// worker 状态给模型的说法（人看的 /workers 与面板用 workers-commands.ts 的 workerStateLabel）
const STATE_WORDS: Readonly<Record<string, string>> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  aborted: "aborted",
  cancelled: "cancelled",
  "turn-limit": "reached the turn limit",
  "wall-clock-limit": "reached the wall-clock limit",
  "token-limit": "reached the token limit",
  "spawn-failed": "failed to spawn",
  stalled: "stalled",
};

function stateWord(state: string): string {
  return STATE_WORDS[state] ?? state;
}

// 续接后找回的之前运行的 worker 在状态里的标注（给模型；人看的见 workers-commands.ts 的 previousRunNote）
function previousRunNote(status: Pick<WorkerStatus, "previousRun">): string {
  return status.previousRun === "settled"
    ? " (from an earlier run)"
    : status.previousRun === "interrupted"
      ? " (from an earlier run; interrupted when that process exited, so it cannot be taken)"
      : "";
}

// 对之前运行的 worker 发消息、停掉时的说明（给模型；人看的见 orchestration/workers.ts 的 previousRunWorkerText）
export function previousRunWorkerReply(
  status: Pick<WorkerStatus, "name" | "previousRun">,
  action: "cancel" | "send"
): string {
  const base =
    status.previousRun === "interrupted"
      ? `Worker ${status.name} was spawned by an earlier run and was interrupted when that process exited`
      : `Worker ${status.name} was spawned by an earlier run and already finished in that run`;
  return action === "cancel"
    ? `${base}; it is not running, so there is nothing to stop.`
    : `${base}; it is not running, so it cannot receive messages.`;
}

// 条数与名词：1 turn、2 turns
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function fileList(files: readonly string[]): string {
  return files.length > 0 ? files.join(", ") : "none";
}

// 一个 worker 的结构化结果
export function structuredOutcomeText(outcome: WorkerOutcome): string {
  const branch =
    outcome.result?.branch ??
    (outcome.workspace.kind === "git-worktree" ? outcome.workspace.branch : "none");
  const files = outcome.result?.changedFiles ?? [];
  const lines = [
    `Worker ${outcome.name} (${outcome.role})${
      outcome.label !== undefined ? `, label ${outcome.label}` : ""
    }: status ${outcomeStatusWord(outcome)}${
      outcome.errorKind !== undefined ? `; error kind ${outcome.errorKind}` : ""
    }${outcome.error !== undefined ? ` (${outcome.error})` : ""}${
      outcome.recoverable === true ? "; recoverable: once a person approves, it can continue" : ""
    }.`,
    `Branch: ${branch}. Changed files (${files.length}): ${fileList(files)}.`,
    `Last output: ${outcome.result?.summary ?? ""}${
      outcome.result?.summaryTruncated === true
        ? SPAWN_WORKER_TEXTS.truncated(outcome.sessionId)
        : ""
    }`,
    `Session record: ${outcome.transcript ?? `worker session ${outcome.sessionId}`}`,
  ];
  if (outcome.start !== undefined && outcome.workspace.kind === "git-worktree") {
    lines.push(SPAWN_WORKER_TEXTS.start(outcome.start, outcome.name));
  }
  return lines.join("\n");
}

export const ORCHESTRATION_TEXTS = {
  alreadyNotified: (outcome: WorkerOutcome) =>
    `Worker ${outcome.name} (${outcome.role}) has finished (${outcomeStatusWord(outcome)}); see the earlier notice for its result.`,
  stillRunning: (status: WorkerStatus, seconds: number) =>
    `Worker ${status.name} (${status.role}) has not finished yet (${stateWord(status.state)}, ${counted(status.turns, "turn")}, ${counted(seconds, "second")} so far) and is still running.`,
  timedOut: (seconds: number) =>
    `Waited ${counted(seconds, "second")}; some workers have not finished.`,
  nothingToWait: "No workers to wait for: all have finished or none have been spawned.",
  unknown: (name: string) =>
    `There is no worker named ${name}; use the name that spawn_worker returned.`,
  noWorkers: "No workers have been spawned yet.",
  messageSent: (name: string) =>
    `Delivered the message to worker ${name}; it will see it in its next turn.`,
  // 验收修订：它在下一轮之前结束（最后一轮之后才递到、正在收尾），如实交回
  messageUndelivered: (name: string) =>
    `Not delivered: worker ${name} has finished or is wrapping up. For this message to take effect, spawn another worker or do it yourself.`,
  messageSettled: (name: string) => `Worker ${name} has finished and cannot receive messages.`,
  stopRequested: (name: string) =>
    `Stopped worker ${name}; the changes it has made stay on its branch, and its result is returned as usual.`,
  stopSettled: (name: string) =>
    `Worker ${name} has already finished; there is no need to stop it.`,
  unbound: "This session has no worker orchestrator set up.",
} as const;

// worker_status 的一行
export function statusLine(status: WorkerStatus, now: number): string {
  const seconds = Math.max(0, Math.round((now - status.startedAt) / 1000));
  const head = `${status.name} (${status.role})${
    status.label !== undefined ? `, label ${status.label}` : ""
  }: ${
    status.outcome !== undefined ? outcomeStatusWord(status.outcome) : stateWord(status.state)
  }, ${counted(status.turns, "turn")}, ${
    status.outcome?.durationMs !== undefined
      ? `took ${counted(Math.round(status.outcome.durationMs / 1000), "second")}`
      : `${counted(seconds, "second")} so far`
  }`;
  if (status.outcome === undefined) {
    return `${head}.`;
  }
  const summary = status.outcome.result?.summary ?? "";
  return `${head}${previousRunNote(status)}. Result summary: ${summary.length > 200 ? `${summary.slice(0, 200)}…` : summary}`;
}

// ---- 执行 ----

// message_worker 递给 worker 的话的开头
export const PARENT_MESSAGE_PREFIX = "[Message from the agent that spawned you] ";

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
        return reply(previousRunWorkerReply(worker, "send"), {
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
        `${PARENT_MESSAGE_PREFIX}${params.message}`
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
        return reply(previousRunWorkerReply(worker, "cancel"), {
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
