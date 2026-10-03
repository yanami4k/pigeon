// 续接时找回之前运行的 worker（会话权威链审计 ②、③）：编排器的 worker 注册表只在内存，交互会话续接后从会话视图的
// children（派出与收尾条目成对写入会话）重建，照脚本编排续跑的做法（script-host.ts 的 restoreScriptRun）。
// - 之前的运行中已收尾的：查询状态、等结果与取用（take_worker、/take）照常可用，状态里标明来自之前的运行；
// - 只有派出、没有收尾的：随上次进程退出而中断，不可取用；
// - 对它们发取消、发消息、补批续做：编排器给出明确说明（不报"找不到"）；重建的记录不运行、不计入同时在跑的上限。
// 另：之前的运行中已收尾、由模型派出、完成通知却没有作为消息出现在主分支上的 worker（通知还在内存队列里时进程退出），
// 续接时补递一条。通知是否已递出看主分支上的使用者消息里有没有通知末行的 worker 会话号；等待工具（wait_workers）
// 已交回其结果的不补递（同一结果不在对话里出现两遍）。
import type { WorkerOrchestrator, WorkerOutcome, WorkerStatus } from "../orchestration/workers.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import type { SessionId } from "../state/ids.ts";
import type { SessionView, ViewChild, ViewMessage } from "../state/session-view.ts";
import {
  SPAWN_WORKER_TOOL,
  type SpawnWorkerSettings,
  WAIT_WORKERS_TOOL,
  workerNoticeMarker,
  workerNoticeText,
} from "./spawn-worker-tool.ts";
import type { WorkerNotices } from "./worker-notices.ts";
import { sessionsDirOf } from "./workspace.ts";

// 续接后补递的通知开头一句
export const REDELIVERED_NOTICE_LEAD =
  "（续接后补递：这个 worker 在之前的运行中已收尾，当时的完成通知没有递出）";

// 中断的 worker 交回的原因
export const INTERRUPTED_WORKER_ERROR = "随上次进程退出而中断，没有交回结果";

function messageText(message: ViewMessage): string {
  const content = message.raw.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

// 主分支上 spawn_worker 派出的会话号（模型派出的；其余为人用 /spawn 派的或脚本编排派的）
function agentSpawnedIds(view: SessionView): Set<string> {
  const ids = new Set<string>();
  for (const message of view.messages) {
    if (message.role !== "toolResult" || message.toolName !== SPAWN_WORKER_TOOL) continue;
    const details = (message.raw as { details?: { sessionIds?: unknown } }).details;
    if (Array.isArray(details?.sessionIds)) {
      for (const id of details.sessionIds) {
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  return ids;
}

function outcomeOf(child: ViewChild, origin: WorkerOutcome["origin"]): WorkerOutcome {
  const { spawned, settled } = child;
  return {
    sessionId: spawned.childSessionId as SessionId,
    name: spawned.name,
    role: spawned.role,
    status: settled?.status ?? "aborted",
    ...(settled !== undefined
      ? {
          ...(settled.error !== undefined ? { error: settled.error } : {}),
          ...(settled.errorKind !== undefined ? { errorKind: settled.errorKind } : {}),
        }
      : { error: INTERRUPTED_WORKER_ERROR, errorKind: "aborted" as const }),
    // 搁下的请示在本进程里不能补批续做
    recoverable: false,
    turns: settled?.turns ?? 0,
    ...(settled?.result !== undefined ? { result: settled.result } : {}),
    workspace: spawned.workspace,
    ...(spawned.label !== undefined ? { label: spawned.label } : {}),
    ...(origin !== undefined ? { origin } : {}),
    durationMs: Math.max(0, (settled?.settledAt ?? spawned.spawnedAt) - spawned.spawnedAt),
  };
}

// 会话视图里本会话派出的 worker → 之前运行的 worker 状态（派出先后为序）
export function previousWorkersOf(view: SessionView): WorkerStatus[] {
  const agent = agentSpawnedIds(view);
  return view.children.map((child) => {
    const { spawned, settled } = child;
    const origin: WorkerOutcome["origin"] =
      spawned.script !== undefined
        ? "program"
        : agent.has(spawned.childSessionId)
          ? "agent"
          : "human";
    const outcome = outcomeOf(child, origin);
    return {
      sessionId: spawned.childSessionId as SessionId,
      name: spawned.name,
      role: spawned.role,
      state: outcome.status,
      turns: outcome.turns,
      ...(spawned.workspace.kind === "git-worktree" ? { branch: spawned.workspace.branch } : {}),
      startedAt: spawned.spawnedAt,
      workspace: spawned.workspace,
      ...(spawned.label !== undefined ? { label: spawned.label } : {}),
      origin,
      depth: 1,
      parentSessionId: view.sessionId,
      ...(spawned.script !== undefined ? { script: spawned.script } : {}),
      outcome,
      previousRun: settled !== undefined ? "settled" : "interrupted",
    };
  });
}

// 要补递完成通知的：模型派出的（不含脚本编排派的）、之前的运行中已收尾、主分支的使用者消息里没有它的会话号、
// 也没有由等待工具交回过结果的
export function undeliveredWorkerOutcomes(
  view: SessionView,
  previous: readonly WorkerStatus[]
): WorkerOutcome[] {
  const userTexts: string[] = [];
  const waitTexts: string[] = [];
  for (const message of view.messages) {
    if (message.role === "user") userTexts.push(messageText(message));
    else if (message.role === "toolResult" && message.toolName === WAIT_WORKERS_TOOL) {
      waitTexts.push(messageText(message));
    }
  }
  return previous.flatMap((worker) => {
    if (
      worker.previousRun !== "settled" ||
      worker.origin !== "agent" ||
      worker.script !== undefined ||
      worker.outcome === undefined
    ) {
      return [];
    }
    const marker = workerNoticeMarker(worker.sessionId);
    if (userTexts.some((text) => text.includes(marker))) return [];
    if (waitTexts.some((text) => text.includes(worker.sessionId))) return [];
    return [worker.outcome];
  });
}

// 续接时调用：把之前运行的 worker 登记到编排器；给了通知队列即补递没递出的完成通知。返回登记与补递的个数
export function restorePreviousWorkers(input: {
  orchestrator: Pick<WorkerOrchestrator, "restorePrevious">;
  view: SessionView | undefined;
  notices?: Pick<WorkerNotices, "postFor">;
  settings?: Pick<SpawnWorkerSettings, "approvalTimeoutMs" | "stallMs">;
}): { restored: number; redelivered: number } {
  if (input.view === undefined) return { restored: 0, redelivered: 0 };
  const previous = previousWorkersOf(input.view);
  input.orchestrator.restorePrevious(previous);
  let redelivered = 0;
  if (input.notices !== undefined) {
    for (const outcome of undeliveredWorkerOutcomes(input.view, previous)) {
      input.notices.postFor(
        outcome.sessionId,
        `${REDELIVERED_NOTICE_LEAD}\n${workerNoticeText(outcome, false, input.settings)}`
      );
      redelivered += 1;
    }
  }
  return { restored: previous.length, redelivered };
}

// 交互会话续接入口用：读本会话的会话文件（调用方已在还原上下文时把写者缓冲落盘）再登记与补递
export function restoreSessionWorkers(input: {
  orchestrator: Pick<WorkerOrchestrator, "restorePrevious">;
  governanceRoot: string;
  sessionId: SessionId;
  notices?: Pick<WorkerNotices, "postFor">;
  settings?: Pick<SpawnWorkerSettings, "approvalTimeoutMs" | "stallMs">;
}): { restored: number; redelivered: number } {
  return restorePreviousWorkers({
    orchestrator: input.orchestrator,
    view: loadSessionView(sessionsDirOf(input.governanceRoot), input.sessionId),
    ...(input.notices !== undefined ? { notices: input.notices } : {}),
    ...(input.settings !== undefined ? { settings: input.settings } : {}),
  });
}
