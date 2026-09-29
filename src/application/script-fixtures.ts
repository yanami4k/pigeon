// 脚本编排用例的夹具：临时 git 仓库、真编排器与真 git 工作树（起点照 279 拍快照）、按任务文字驱动的 worker 运行面替身
// （写文件、交回正文、按轮报用量、可挂起到被停）、本机进程版执行器，以及派出与收尾记录（可冻结，模拟进程中途死掉）。
// 重启后的找回走 restoreScriptRun，会话视图由记录拼出。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ApprovalDecision, ApprovalRequest } from "../approvals/handler.ts";
import { localScriptLauncher, type ScriptLauncher } from "../execution/script-sandbox.ts";
import {
  type ChildFamilySink,
  gitWorktreeWorkspaces,
  WorkerOrchestrator,
  type WorkerRunResult,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
} from "../orchestration/workers.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newEntryId, newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import type { ChildSettledInput, ChildSpawnedInput } from "../state/session-payloads.ts";
import type { SessionView } from "../state/session-view.ts";
import { structuredResultOf } from "../state/structured-result.ts";
import type { CollectApproval } from "./script-host.ts";
import { createSessionScripts, restoreScriptRun } from "./script-host.ts";
import type { ScriptPricing, ScriptRuns } from "./script-runner.ts";
import { ORCHESTRATE_TOOL } from "./script-texts.ts";
import { workerStartPoint } from "./workers.ts";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function tempRepo(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-script-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "pigeon@example.invalid");
  git(root, "config", "user.name", "pigeon-test");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

// worker 这一轮做什么：写哪些文件（相对工作树）、交回的正文、失败原因、这一轮的用量、挂起到被停
export interface WorkerPlan {
  files?: Record<string, string>;
  reply?: string;
  fail?: string;
  tokens?: number;
  cost?: number;
  hang?: boolean;
  // 挂起到这个承诺兑现（控制先后）
  wait?: Promise<void>;
  // 先请示跑一条命令：被拒即停下等中止
  ask?: string;
}

export interface PlanInput {
  task: string;
  name: string;
  worktree: string;
  resume: boolean;
  input: string;
}

export type Planner = (input: PlanInput) => WorkerPlan | Promise<WorkerPlan>;

class FakeWorker implements WorkerRuntimeHandle {
  readonly #listeners = new Set<(event: EventEnvelope) => void>();
  readonly #stopped = Promise.withResolvers<void>();
  readonly #request: WorkerRuntimeRequest;
  readonly #planner: Planner;
  #reply = "";

  constructor(request: WorkerRuntimeRequest, planner: Planner) {
    this.#request = request;
    this.#planner = planner;
  }

  #emit(kind: string, payload: unknown): void {
    const event: EventEnvelope = {
      version: 1,
      id: newEntryId(),
      sessionId: this.#request.sessionId,
      runId: newRunId(),
      timestamp: Date.now(),
      kind,
      payload,
    } as EventEnvelope;
    for (const listener of this.#listeners) listener(event);
  }

  async run(input: string): Promise<WorkerRunResult> {
    const worktree =
      this.#request.workspace.kind === "git-worktree" ? this.#request.workspace.path : "";
    this.#emit("turn.started", {});
    const plan = await this.#planner({
      task: this.#request.task,
      name: this.#request.name,
      worktree,
      resume: this.#request.resume === true,
      input,
    });
    if (plan.ask !== undefined) {
      const decision = await this.#request.approvalHandler({
        toolName: "run_command",
        toolCallId: newEntryId(),
        args: { command: plan.ask },
        tier: "exec",
        command: plan.ask,
      });
      if (!decision.approved) {
        await this.#stopped.promise;
        return { status: "aborted" };
      }
    }
    if (plan.hang === true) {
      await this.#stopped.promise;
      return { status: "aborted" };
    }
    if (plan.wait !== undefined) {
      const stopped = await Promise.race([
        plan.wait.then(() => false),
        this.#stopped.promise.then(() => true),
      ]);
      if (stopped) return { status: "aborted" };
    }
    for (const [file, content] of Object.entries(plan.files ?? {})) {
      const target = join(worktree, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    this.#reply = plan.reply ?? "做完了";
    this.#emit("turn.completed", {
      stopReason: "stop",
      syntheticFailure: false,
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: plan.tokens ?? 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: plan.cost ?? 0 },
      },
    });
    return plan.fail !== undefined
      ? { status: "failed", errorMessage: plan.fail }
      : { status: "completed" };
  }

  async interrupt(): Promise<void> {
    this.#stopped.resolve();
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  summary(): string {
    return this.#reply;
  }

  structured(): unknown {
    return structuredResultOf(this.#reply);
  }

  async dispose(): Promise<void> {}
}

// 派出与收尾记录；frozen 之后不再记（模拟进程中途死掉）
export interface RecordingSink extends ChildFamilySink {
  spawned: ChildSpawnedInput[];
  settled: ChildSettledInput[];
  frozen: boolean;
}

export function recordingSink(): RecordingSink {
  const sink: RecordingSink = {
    spawned: [],
    settled: [],
    frozen: false,
    appendChildSpawned: (input) => {
      if (!sink.frozen) sink.spawned.push(structuredClone(input));
    },
    appendChildSettled: (input) => {
      if (!sink.frozen) sink.settled.push(structuredClone(input));
    },
  };
  return sink;
}

// 由记录与提交脚本的工具结果拼出会话视图（只填找回要读的部分）
export function viewOf(
  sessionId: SessionId,
  sink: RecordingSink,
  toolResults: ReadonlyArray<{ details: unknown }>
): SessionView {
  return {
    sessionId,
    createdAt: 0,
    copiedEntries: 0,
    items: [],
    runs: [],
    messages: toolResults.map((result, index) => ({
      entryId: `m${index}`,
      runId: newRunId(),
      runSeq: index + 1,
      role: "toolResult",
      timestamp: 0,
      blocks: [],
      raw: { role: "toolResult", toolName: ORCHESTRATE_TOOL, details: result.details },
      toolName: ORCHESTRATE_TOOL,
    })),
    children: sink.spawned.map((spawned) => {
      const settled = sink.settled.findLast(
        (entry) => entry.childSessionId === spawned.childSessionId
      );
      return {
        spawned: { version: 1, event: "spawned", ...spawned },
        ...(settled !== undefined ? { settled: { version: 1, event: "settled", ...settled } } : {}),
      };
    }),
    orphanSettleds: [],
    toolOutcomes: [],
    warnings: [],
  } as unknown as SessionView;
}

export interface ScriptHarness {
  repo: string;
  sessionId: SessionId;
  orchestrator: WorkerOrchestrator;
  runs: ScriptRuns;
  sink: RecordingSink;
  notices: string[];
  lines: string[];
  collectRequests: ApprovalRequest[];
  // 由测试设置的工具结果（续跑时从"会话"找回脚本用）
  toolResults: Array<{ details: unknown }>;
  // 等下一条汇总通知
  nextNotice(): Promise<string>;
}

export function scriptHarness(options: {
  planner: Planner;
  repo?: string;
  sessionId?: SessionId;
  sink?: RecordingSink;
  toolResults?: Array<{ details: unknown }>;
  approval?: Partial<CollectApproval>;
  collectDecision?: (request: ApprovalRequest) => ApprovalDecision;
  maxConcurrent?: number;
  runIds?: string[];
  hostExhausted?: () => boolean;
  approvals?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  approvalTimeoutMs?: number;
  // 计划行、log 行与汇总另外交给它（界面用例接到消息区）
  display?: (line: string) => void;
  // 缺省为本机进程版执行器；真容器用例给 Docker 的
  launcher?: () => Promise<ScriptLauncher>;
  pricing?: () => ScriptPricing;
  stallMs?: number;
}): ScriptHarness {
  const repo = options.repo ?? tempRepo();
  const sessionId = options.sessionId ?? newSessionId();
  const sink = options.sink ?? recordingSink();
  const toolResults = options.toolResults ?? [];
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: repo,
    session: { sessionId },
    parentPolicy: {
      allow: ["read_file", "edit_file", "run_command", "web_search", "web_fetch"],
      deny: [],
      approvalMode: "prompt",
    },
    parentLog: sink,
    createRuntime: (request) => new FakeWorker(request, options.planner),
    approvals: options.approvals ?? (async () => ({ approved: true })),
    workspaces: gitWorktreeWorkspaces({ repoRoot: repo, governanceRoot: repo }),
    startPoint: workerStartPoint(repo),
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
    ...(options.approvalTimeoutMs !== undefined
      ? { approvalTimeoutMs: options.approvalTimeoutMs }
      : {}),
  });
  const notices: string[] = [];
  const lines: string[] = [];
  const collectRequests: ApprovalRequest[] = [];
  const waiters: Array<(text: string) => void> = [];
  const ids = [...(options.runIds ?? [])];
  const runs = createSessionScripts({
    orchestrator,
    governanceRoot: repo,
    sessionId,
    notices: {
      hold: () => (text: string) => {
        notices.push(text);
        options.display?.(text);
        waiters.shift()?.(text);
      },
    },
    approval: {
      yolo: false,
      handler: async (request) => {
        collectRequests.push(request);
        return options.collectDecision?.(request) ?? { approved: true };
      },
      ...options.approval,
    },
    emit: (line) => {
      lines.push(line);
      options.display?.(line);
    },
    launcher: options.launcher ?? (async () => localScriptLauncher()),
    ...(ids.length > 0 ? { newRunId: () => ids.shift() ?? `s${Date.now()}` } : {}),
    ...(options.hostExhausted !== undefined ? { hostExhausted: options.hostExhausted } : {}),
    ...(options.pricing !== undefined ? { pricing: options.pricing } : {}),
    ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
    // 重启后的找回：由记录与工具结果拼出会话视图，走同一个解析函数
    restore: async (runId) =>
      restoreScriptRun(join(tmpdir(), "no-sessions"), viewOf(sessionId, sink, toolResults), runId),
  });
  return {
    repo,
    sessionId,
    orchestrator,
    runs,
    sink,
    notices,
    lines,
    collectRequests,
    toolResults,
    nextNotice: () => new Promise((resolve) => waiters.push(resolve)),
  };
}
