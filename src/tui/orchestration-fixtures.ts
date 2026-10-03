// 编排进度界面（决策 301）用例的夹具：真编排器（WorkerOrchestrator）+ 可由用例逐步驱动的 worker 运行面替身 + 内存工作区，
// 编排面与终端界面入口（main.ts）同形——人派的经 /spawn（origin human），agent 派的由用例直接调编排器（origin agent，
// 不经壳的任何命令，只经生命周期事件与观察口告知壳）。仅供 *.test.ts 引用。
import type { ApprovalDecision, ApprovalRequest } from "../approvals/handler.ts";
import {
  WorkerOrchestrator,
  type WorkerOrchestratorOptions,
  type WorkerRunResult,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
  type WorkerStreamDelta,
  type WorkerToolResult,
} from "../orchestration/workers.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import { newEntryId, newRunId, newSessionId, type RunId } from "../state/ids.ts";
import type { WorkerWorkspace } from "../state/session-payloads.ts";
import type { TuiWorkersFace } from "./workers-view.ts";

// 用例逐步驱动的 worker 运行面：run 挂起到 finish 或被中断；事件、流式正文与工具结果由用例发出
export class DrivenWorkerRuntime implements WorkerRuntimeHandle {
  readonly request: WorkerRuntimeRequest;
  readonly runId: RunId = newRunId();
  readonly inputs: string[] = [];
  readonly notes: string[] = [];
  readonly decisions: ApprovalDecision[] = [];
  delivered = true;
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private readonly streamListeners = new Set<(delta: WorkerStreamDelta) => void>();
  private readonly resultListeners = new Set<(result: WorkerToolResult) => void>();
  private done = Promise.withResolvers<WorkerRunResult>();
  private lastSummary = "";

  constructor(request: WorkerRuntimeRequest) {
    this.request = request;
  }

  run(task: string): Promise<WorkerRunResult> {
    this.inputs.push(task);
    return this.done.promise;
  }

  finish(summary = "完成了", status: WorkerRunResult["status"] = "completed"): void {
    this.lastSummary = summary;
    this.done.resolve({ status, runId: this.runId });
  }

  async interrupt(): Promise<void> {
    this.done.resolve({ status: "aborted", runId: this.runId });
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStream(listener: (delta: WorkerStreamDelta) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  subscribeToolResults(listener: (result: WorkerToolResult) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  emit(kind: string, payload: unknown, timestamp = Date.now()): void {
    const envelope: EventEnvelope = {
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId: this.request.sessionId,
      runId: this.runId,
      timestamp,
      kind,
      payload,
    } as EventEnvelope;
    for (const listener of [...this.listeners]) listener(envelope);
  }

  // 一轮：开始、正文、结束（带用量与价格）
  turn(text: string, usage?: { totalTokens: number; cost: number }): void {
    this.emit("turn.started", {});
    for (const listener of [...this.streamListeners]) {
      listener({ runId: this.runId, kind: "text", delta: text });
    }
    this.emit("turn.completed", {
      stopReason: "stop",
      syntheticFailure: false,
      ...(usage !== undefined
        ? {
            usage: {
              input: usage.totalTokens,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: usage.totalTokens,
              cost: {
                input: usage.cost,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: usage.cost,
              },
            },
          }
        : {}),
    });
  }

  toolCall(toolCallId: string, toolName: string, args: unknown): void {
    this.emit("tool.proposed", { toolCallId, toolName, args });
  }

  toolDone(toolCallId: string, toolName: string, text = "ok"): void {
    for (const listener of [...this.resultListeners]) {
      listener({ runId: this.runId, toolCallId, toolName, isError: false, text, details: {} });
    }
    this.emit("tool.settled", { toolCallId, toolName, isError: false });
  }

  // 请示一次跑命令（经编排器汇到派出方的审批回调）
  async ask(command: string): Promise<ApprovalDecision> {
    const decision = await this.request.approvalHandler({
      toolName: "run_command",
      toolCallId: `call-${command}`,
      args: { command },
      tier: "exec",
      command,
    } as ApprovalRequest);
    this.decisions.push(decision);
    return decision;
  }

  notify(text: string): string {
    this.notes.push(text);
    return `note-${this.notes.length}`;
  }

  noticeDelivered(): boolean {
    return this.delivered;
  }

  withdrawNotice(): boolean {
    return true;
  }

  // 嵌套派出时的落盘口（本用例不查派出记录）
  childLog() {
    return { appendChildSpawned: () => {}, appendChildSettled: () => {} };
  }

  summary(): string {
    return this.lastSummary;
  }

  async dispose(): Promise<void> {}
}

export interface OrchestrationHarness {
  orchestrator: WorkerOrchestrator;
  face: TuiWorkersFace;
  // 按 worker 名取运行面（续做后是新的一个；index 缺省取最近一个）
  runtime(name: string, index?: number): DrivenWorkerRuntime;
  runtimes(name: string): DrivenWorkerRuntime[];
  // 用例收尾：取消仍在跑或排队的 worker（编排器的墙钟定时器不让测试进程退出）
  stopAll(): Promise<void>;
}

export function orchestrationHarness(
  options: Partial<WorkerOrchestratorOptions> & {
    approvals?: WorkerOrchestratorOptions["approvals"];
  } = {}
): OrchestrationHarness {
  const byName = new Map<string, DrivenWorkerRuntime[]>();
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: "/virtual",
    session: { sessionId: newSessionId() },
    parentPolicy: {
      allow: ["read_file", "edit_file", "run_command"],
      deny: [],
      approvalMode: "prompt",
    },
    parentLog: { appendChildSpawned: () => {}, appendChildSettled: () => {} },
    createRuntime: (request) => {
      const runtime = new DrivenWorkerRuntime(request);
      byName.set(request.name, [...(byName.get(request.name) ?? []), runtime]);
      return runtime;
    },
    approvals: async () => ({ approved: true }),
    workspaces: {
      plan: ({ sessionId, name }): WorkerWorkspace => ({
        kind: "git-worktree",
        path: `/virtual/${sessionId}-${name}`,
        branch: `pigeon/${name}`,
      }),
      create: () => {},
      changedFiles: () => [],
    },
    ...options,
  });
  // 与终端界面入口同形的编排面
  const face: TuiWorkersFace = {
    spawn: (request) => orchestrator.spawn({ ...request, origin: "human" }),
    subscribe: (listener) => orchestrator.subscribe((event) => listener(event)),
    observe: (listener) => orchestrator.observe(listener),
    send: (id, text) => orchestrator.send(id, text),
    resume: (id, resumeOptions) => orchestrator.resume(id, resumeOptions),
    cancel: (id) => orchestrator.cancel(id),
    status: () => orchestrator.status(),
    awaitResult: (id) => orchestrator.awaitResult(id),
  };
  const runtimes = (name: string): DrivenWorkerRuntime[] => byName.get(name) ?? [];
  const runtime = (name: string, index = -1): DrivenWorkerRuntime => {
    const found = runtimes(name).at(index);
    if (found === undefined) throw new Error(`没有 worker ${name} 的运行面`);
    return found;
  };
  const stopAll = async (): Promise<void> => {
    await Promise.all(
      orchestrator
        .status()
        .filter((status) => status.state === "running" || status.state === "queued")
        .map((status) => orchestrator.cancel(status.sessionId))
    );
    await Promise.all(
      orchestrator.status().map((status) => orchestrator.awaitResult(status.sessionId))
    );
  };
  return { orchestrator, face, runtime, runtimes, stopAll };
}

// 等到条件成立（逐个事件循环轮次）。上限只决定真失败时多久报出来：机器忙（多个进程抢 CPU、内存换页）时
// 进程可能整段停上几秒，2 秒的上限会把本该成立的条件误报为失败，故放宽到 15 秒；条件一成立即返回，不拖慢通过的用例
export async function until(check: () => boolean, what = "等待的条件"): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what}没有成立`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
