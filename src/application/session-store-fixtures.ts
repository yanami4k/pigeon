// 测试夹具：用新会话存储造会话数据（决策 206 账本重构后续各段共用）。经真实写者（pi 的 JsonlSessionRepo）写出与生产同一格式的
// 会话文件：各类消息（用户、助手含思考与工具调用、工具结果）、七种自定义条目、worker 子会话（父会话记派出与收尾、子会话文件头
// 记来历）、分叉（来源记分叉条目、分支文件由 pi 的 fork 复制分叉点之前的历史）、撕裂末行与不认识的条目等异常形状。
// 只供测试使用，不从任何桶文件导出。
//
// 用法：
//   const root = mkdtempSync(...); const sessionsDir = join(root, ".pigeon", "sessions");
//   const s = createFixtureSession({ sessionsDir, cwd: root });
//   const runId = s.startRun({ task: "改 a.txt" });            // Run 开始 + 任务消息
//   s.toolTurn({ name: "edit_file", args: {...}, result: "ok" }); // 助手发起工具调用 + 工具结果
//   s.checkpoint({ toolCallId: "tc-1" });                        // 位置同生产：工具结果之前请在 toolTurn 里用 checkpoint 选项
//   s.assistant({ text: "好了" });
//   s.endRun();                                                   // 结束方式缺省 completed，消息条数自动算
//   s.verification({ verdict: "pass" });
//   const { path } = await s.close();
//   const worker = await spawnFixtureWorker(s, { name: "implementer-1", task: "..." });  // 父会话记派出，子会话建好
//   const branch = await forkFixture({ sessionsDir, sourceSessionId, runId, runSeq: 1 }); // 分支文件
//   tearTail(path) / appendRawLine(path, {...})                   // 异常形状
import { appendFileSync } from "node:fs";
import {
  branchEntries,
  locateSessionFile,
  messageEntryAt,
  readSessionFile,
} from "../persistence/session-reader.ts";
import type { AgentMessage } from "../pi-runtime/index.ts";
import {
  forkSessionFile,
  openSessionStoreWriter,
  type SessionStoreFault,
  type SessionStoreWriter,
} from "../pi-runtime/session-store.ts";
import type { ChildSettledStatus, ForkTrigger, WorkerRole } from "../state/event-log.ts";
import { newGrantId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { EvalVerdict } from "../state/runtime-events.ts";
import {
  type RunEnding,
  type RunStartData,
  SESSION_ENTRY_VERSION,
  type SessionCustomEntry,
  SessionEntryType,
  type SessionHeaderMetadata,
} from "../state/session-entries.ts";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const GIT_ID = "a".repeat(40);

export interface FixtureSessionOptions {
  sessionsDir: string;
  // 缺省同 sessionsDir 往上两级（治理根）
  cwd?: string;
  sessionId?: SessionId;
  parentSessionId?: string;
  metadata?: SessionHeaderMetadata;
  // 已有文件（分叉出来的分支）上续写
  existingPath?: string;
}

export interface FixtureToolCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
}

export interface FixtureSession {
  readonly sessionId: SessionId;
  readonly writer: SessionStoreWriter;
  // 写入故障（正常用法下应为空）
  readonly faults: SessionStoreFault[];
  // Run 开始（配置可覆盖）；给 task 即紧跟一条用户消息
  startRun(input?: { runId?: RunId; task?: string; config?: Partial<RunStartData> }): RunId;
  user(text: string): void;
  assistant(input?: {
    text?: string;
    thinking?: string;
    toolCalls?: FixtureToolCall[];
    stopReason?: string;
    errorMessage?: string;
    usage?: Partial<typeof ZERO_USAGE>;
  }): string[];
  toolResult(input: {
    toolCallId: string;
    toolName: string;
    text: string;
    isError?: boolean;
  }): void;
  // 一轮工具调用：助手发起一次调用 →（可选）代码快照 → 工具结果；返回工具调用号
  toolTurn(input: {
    name: string;
    args?: Record<string, unknown>;
    result?: string;
    isError?: boolean;
    checkpoint?: boolean;
  }): string;
  // Run 收尾：结束方式缺省 completed，消息条数取本 Run 已写的条数
  endRun(input?: { ending?: RunEnding; stopReason?: string; errorMessage?: string }): void;
  checkpoint(input: { toolCallId: string; commit?: string; baseCommit?: string }): void;
  verification(input: {
    verdict: EvalVerdict;
    target?: { sessionId: SessionId; runId: RunId };
    exitCode?: number | null;
    steps?: Array<{ name: string; verdict: EvalVerdict; toolFault?: true }>;
  }): void;
  grantCreated(input?: { tool?: string; pathPrefix?: string }): string;
  grantRevoked(grantId: string): void;
  workerSpawned(input: {
    childSessionId: SessionId;
    name: string;
    role?: WorkerRole;
    task: string;
  }): void;
  workerSettled(input: {
    childSessionId: SessionId;
    name: string;
    status?: ChildSettledStatus;
    turns?: number;
  }): void;
  // 任意自定义条目（schema 之外的形状也照写，用于读者的容错测试）
  append(entry: SessionCustomEntry): void;
  // 当前 Run（未开始为 undefined）
  currentRunId(): RunId | undefined;
  close(): Promise<{ sessionId: SessionId; path: string }>;
}

export function createFixtureSession(options: FixtureSessionOptions): FixtureSession {
  const sessionId = options.sessionId ?? newSessionId();
  const faults: SessionStoreFault[] = [];
  const writer = openSessionStoreWriter({
    sessionsRoot: options.sessionsDir,
    sessionId,
    cwd: options.cwd ?? `${options.sessionsDir}/../..`,
    ...(options.existingPath !== undefined ? { existingPath: options.existingPath } : {}),
    ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    onFault: (fault) => faults.push(fault),
  });
  let runId: RunId | undefined;
  let runMessages = 0;
  let lastStop: string | undefined;
  let callSeq = 0;
  const message = (value: Record<string, unknown>): void => {
    writer.appendMessage({ timestamp: Date.now(), ...value } as unknown as AgentMessage);
    runMessages += 1;
  };
  const requireRun = (): RunId => {
    if (runId === undefined) {
      throw new Error("夹具：先 startRun 再写本 Run 的条目");
    }
    return runId;
  };
  const session: FixtureSession = {
    sessionId,
    writer,
    faults,
    startRun: (input = {}) => {
      runId = input.runId ?? newRunId();
      runMessages = 0;
      lastStop = undefined;
      writer.append({
        customType: SessionEntryType.RunStart,
        data: {
          version: SESSION_ENTRY_VERSION,
          runId,
          startedAt: Date.now(),
          model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
          policy: {
            allow: ["read_file", "edit_file", "run_command"],
            deny: [],
            approvalMode: "yolo",
          },
          advertisedTools: ["read_file", "edit_file", "run_command"],
          systemPrompt: "你是 Pigeon 测试助手。",
          memory: [],
          skills: [],
          ...input.config,
        },
      });
      if (input.task !== undefined) {
        session.user(input.task);
      }
      return runId;
    },
    user: (text) => message({ role: "user", content: [{ type: "text", text }] }),
    assistant: (input = {}) => {
      const calls = (input.toolCalls ?? []).map((call) => ({
        type: "toolCall",
        id: call.id ?? `tc-${++callSeq}`,
        name: call.name,
        arguments: call.args ?? {},
      }));
      const stopReason = input.stopReason ?? (calls.length > 0 ? "toolUse" : "stop");
      lastStop = stopReason;
      message({
        role: "assistant",
        content: [
          ...(input.thinking !== undefined ? [{ type: "thinking", thinking: input.thinking }] : []),
          ...(input.text !== undefined ? [{ type: "text", text: input.text }] : []),
          ...calls,
        ],
        api: "unknown",
        provider: "fixture",
        model: "fixture-model",
        usage: { ...ZERO_USAGE, ...input.usage },
        stopReason,
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      });
      return calls.map((call) => call.id);
    },
    toolResult: (input) =>
      message({
        role: "toolResult",
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        content: [{ type: "text", text: input.text }],
        isError: input.isError ?? false,
      }),
    toolTurn: (input) => {
      const [toolCallId = ""] = session.assistant({
        toolCalls: [
          { name: input.name, ...(input.args !== undefined ? { args: input.args } : {}) },
        ],
      });
      if (input.checkpoint === true) {
        session.checkpoint({ toolCallId });
      }
      session.toolResult({
        toolCallId,
        toolName: input.name,
        text: input.result ?? "ok",
        ...(input.isError !== undefined ? { isError: input.isError } : {}),
      });
      return toolCallId;
    },
    endRun: (input = {}) => {
      const current = requireRun();
      const stopReason = input.stopReason ?? lastStop;
      writer.append({
        customType: SessionEntryType.RunEnd,
        data: {
          version: SESSION_ENTRY_VERSION,
          runId: current,
          ending: input.ending ?? "completed",
          ...(stopReason !== undefined ? { stopReason } : {}),
          ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
          messageCount: runMessages,
          endedAt: Date.now(),
        },
      });
    },
    checkpoint: (input) =>
      writer.append({
        customType: SessionEntryType.Checkpoint,
        data: {
          version: SESSION_ENTRY_VERSION,
          runId: requireRun(),
          toolCallId: input.toolCallId,
          ref: `refs/pigeon/checkpoints/${sessionId}/${callSeq}`,
          commit: input.commit ?? GIT_ID,
          tree: "b".repeat(40),
          ...(input.baseCommit !== undefined ? { baseCommit: input.baseCommit } : {}),
        },
      }),
    verification: (input) => {
      const target = input.target ?? { sessionId, runId: requireRun() };
      const exitCode = input.exitCode ?? (input.verdict === "pass" ? 0 : 1);
      writer.append({
        customType: SessionEntryType.Verification,
        data: {
          version: SESSION_ENTRY_VERSION,
          ...(runId !== undefined ? { runId } : {}),
          target,
          command: ["npm", "test"],
          exitCode,
          timedOut: false,
          durationMs: 10,
          outputBytes: 2,
          outputHash: "c".repeat(64),
          output: "ok",
          truncated: false,
          workspace: options.cwd ?? options.sessionsDir,
          verdict: input.verdict,
          verifiedAt: Date.now(),
          ...(input.steps !== undefined
            ? {
                steps: input.steps.map((step) => ({
                  name: step.name,
                  exitCode: step.verdict === "pass" ? 0 : 1,
                  verdict: step.verdict,
                  output: "",
                  truncated: false,
                  ...(step.toolFault !== undefined ? { toolFault: step.toolFault } : {}),
                })),
              }
            : {}),
        },
      });
    },
    grantCreated: (input = {}) => {
      const grantId = newGrantId();
      writer.append({
        customType: SessionEntryType.Grant,
        data: {
          version: SESSION_ENTRY_VERSION,
          event: "created",
          ...(runId !== undefined ? { runId } : {}),
          grantId,
          tool: input.tool ?? "edit_file",
          ...(input.pathPrefix !== undefined ? { pathPrefix: input.pathPrefix } : {}),
          firstCall: { toolCallId: "tc-grant", args: {} },
          createdAt: Date.now(),
        },
      });
      return grantId;
    },
    grantRevoked: (grantId) =>
      writer.append({
        customType: SessionEntryType.Grant,
        data: {
          version: SESSION_ENTRY_VERSION,
          event: "revoked",
          ...(runId !== undefined ? { runId } : {}),
          grantId: grantId as never,
          revokedAt: Date.now(),
        },
      }),
    workerSpawned: (input) =>
      writer.append({
        customType: SessionEntryType.Worker,
        data: {
          version: SESSION_ENTRY_VERSION,
          event: "spawned",
          ...(runId !== undefined ? { runId } : {}),
          childSessionId: input.childSessionId,
          name: input.name,
          role: input.role ?? "implementer",
          task: input.task,
          policy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "yolo" },
          limits: { maxTurns: 20, wallClockMs: 600_000 },
          workspace: { kind: "git-worktree", path: `/worktrees/${input.name}`, branch: input.name },
          spawnedAt: Date.now(),
        },
      }),
    workerSettled: (input) =>
      writer.append({
        customType: SessionEntryType.Worker,
        data: {
          version: SESSION_ENTRY_VERSION,
          event: "settled",
          ...(runId !== undefined ? { runId } : {}),
          childSessionId: input.childSessionId,
          name: input.name,
          status: input.status ?? "completed",
          result: {
            branch: input.name,
            changedFiles: [],
            summary: "完成",
            summaryTruncated: false,
          },
          turns: input.turns ?? 1,
          settledAt: Date.now(),
        },
      }),
    append: (entry) => writer.append(entry),
    currentRunId: () => runId,
    close: async () => {
      const path = await writer.filePath();
      await writer.close();
      if (path === undefined || faults.length > 0) {
        throw new Error(`夹具：会话文件没写成：${faults.map((fault) => fault.message).join("；")}`);
      }
      return { sessionId, path };
    },
  };
  return session;
}

// worker 子会话：父会话记派出（父会话须有进行中的 Run 时带上 runId），子会话文件头记父会话号与来历；
// 子会话由调用方写完后 close，收尾记录由调用方在父会话上写（parent.workerSettled）
export function spawnFixtureWorker(
  parent: FixtureSession,
  input: { sessionsDir: string; name: string; role?: WorkerRole; task: string; cwd?: string }
): FixtureSession {
  const childSessionId = newSessionId();
  const role = input.role ?? "implementer";
  parent.workerSpawned({ childSessionId, name: input.name, role, task: input.task });
  const parentRunId = parent.currentRunId();
  return createFixtureSession({
    sessionsDir: input.sessionsDir,
    sessionId: childSessionId,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    parentSessionId: parent.sessionId,
    metadata: {
      version: SESSION_ENTRY_VERSION,
      worker: {
        ...(parentRunId !== undefined ? { parentRunId } : {}),
        name: input.name,
        role,
        workspace: { kind: "git-worktree", path: `/worktrees/${input.name}`, branch: input.name },
        startedAt: Date.now(),
      },
    },
  });
}

// 分叉：在（已关闭的）来源会话里记分叉条目，再用 pi 的 fork 把分叉点（含）之前的历史复制进分支会话的新文件；
// 返回在分支文件上续写的夹具（同生产：分支运行面打开 fork 出来的文件续写）
export async function forkFixture(input: {
  sessionsDir: string;
  sourceSessionId: SessionId;
  runId: RunId;
  runSeq: number;
  trigger?: ForkTrigger;
  cwd?: string;
}): Promise<FixtureSession> {
  const located = locateSessionFile(input.sessionsDir, input.sourceSessionId);
  const view = located !== undefined ? readSessionFile(located.path) : undefined;
  if (located === undefined || view === undefined) {
    throw new Error(`夹具：来源会话 ${input.sourceSessionId} 没有会话文件`);
  }
  const forkEntryId = messageEntryAt(
    branchEntries(view, view.lanes.get("main") ?? null),
    input.runId,
    input.runSeq
  );
  if (forkEntryId === undefined) {
    throw new Error(`夹具：来源会话里没有分叉点 ${input.runId} 第 ${input.runSeq} 条`);
  }
  const branchSessionId = newSessionId();
  const checkpoint = { ref: "refs/pigeon/fork", commit: GIT_ID };
  const trigger = input.trigger ?? "manual";
  const source = createFixtureSession({
    sessionsDir: input.sessionsDir,
    sessionId: input.sourceSessionId,
    existingPath: located.path,
  });
  source.append({
    customType: SessionEntryType.Fork,
    data: {
      version: SESSION_ENTRY_VERSION,
      runId: input.runId,
      branchSessionId,
      forkPoint: { runId: input.runId, runSeq: input.runSeq },
      forkEntryId,
      checkpoint,
      trigger,
      forkedAt: Date.now(),
    },
  });
  await source.close();
  const cwd = input.cwd ?? `${input.sessionsDir}/../../.pigeon/worktrees/${branchSessionId}`;
  const path = await forkSessionFile({
    sessionsRoot: input.sessionsDir,
    source: { sessionId: input.sourceSessionId, path: located.path },
    entryId: forkEntryId,
    branchSessionId,
    cwd,
    metadata: {
      version: SESSION_ENTRY_VERSION,
      branch: {
        sourceSessionId: input.sourceSessionId,
        forkPoint: { runId: input.runId, runSeq: input.runSeq },
        checkpoint,
        workspace: { kind: "git-worktree", path: cwd, branch: `fork-${branchSessionId.slice(-8)}` },
        trigger,
        startedAt: Date.now(),
      },
    },
  });
  return createFixtureSession({
    sessionsDir: input.sessionsDir,
    sessionId: branchSessionId,
    cwd,
    existingPath: path,
  });
}

// 撕裂末行：在已关闭的会话文件末尾追加半截变更（写者正在追加时被读的形状）
export function tearTail(
  path: string,
  partial = '{"kind":"entry","lane":"main","type":"mess'
): void {
  appendFileSync(path, partial);
}

// 追加一行原样的 JSON（seq 由调用方给；用于不认识的条目类型、record 类型等容错形状）
export function appendRawLine(path: string, line: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}
