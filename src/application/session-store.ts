// 账本重构双写接线（决策 206）：旧账本照写照读，新会话存储同时写入；本段不改任何读者，最后一段停写旧账本时连同本文件删除。
// - 打开：每个运行面按会话号列目录找到已有的会话文件（续跑、分支、收尾后补写验证），有即打开续写，没有即新建；
//   worker 与分支会话的来历在新建时写进文件头（父会话号与 metadata，177）。双写之前就存在的旧会话（新存储里没有文件、
//   旧账本已有记录）续跑时不建文件，过渡期只写旧账本：新存储只放双写开始后创建的会话。
// - 写入点：在写旧账本的同一处先写旧账本、再写新存储。运行面自己写消息、Run 开始与收尾（pi-runtime/adapter.ts）；
//   验证记录、代码快照、worker 派出与收尾、分叉、授权建立与撤销由各写入点经这里的转换写入。
//   写不进旧账本即放弃的动作（授权、派出、分叉）在旧账本失败时新存储也不写；验证已经做了，旧记录写失败时新存储照写。
// - 故障：新存储的任何失败都是内部故障——向标准错误输出去重告警（同一个运行面里同一类故障只报一次，文案说明后果），
//   不中断运行、不影响旧账本；口径与快照器、会话树写穿的告警一致。
import { existsSync, statSync } from "node:fs";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import {
  branchEntries,
  locateSessionFile,
  messageEntryAt,
  readSessionFile,
} from "../persistence/session-reader.ts";
import {
  forkSessionFile,
  openSessionStoreWriter,
  SessionStoreFault,
  type SessionStoreWriter,
} from "../pi-runtime/session-store.ts";
import type {
  AttemptVerifiedInput,
  BranchHeaderInput,
  ChildSettledInput,
  ChildSpawnedInput,
  GrantCreatedInput,
  GrantRevokedInput,
  SessionForkedInput,
  SessionHeaderInput,
} from "../state/event-log.ts";
import type { RunId } from "../state/ids.ts";
import type { WorkspaceCheckpointPayload } from "../state/runtime-events.ts";
import {
  SESSION_ENTRY_VERSION,
  type SessionCustomEntry,
  type SessionEntrySink,
  SessionEntryType,
  type SessionHeaderMetadata,
} from "../state/session-entries.ts";
import { dedupedWarner, failureDetail, type WarnSink } from "./warnings.ts";

export type { SessionStoreWriter } from "../pi-runtime/session-store.ts";

export type StoreFaultHandler = (fault: SessionStoreFault) => void;

// 新存储故障的告警器：同一类（同一动作）只报一次
export function storeFaultWarner(sink?: WarnSink): StoreFaultHandler {
  const warn = dedupedWarner(sink);
  return (fault) =>
    warn(
      fault,
      `新会话存储告警：${failureDetail(fault)}（新存储缺这一条；旧账本照常写入，运行不受影响）`
    );
}

// worker 与分支会话的来历（新建会话文件时写进文件头）
export interface StoreLineage {
  worker?: SessionHeaderInput;
  branch?: BranchHeaderInput;
}

function headerOf(lineage: StoreLineage | undefined): {
  parentSessionId?: string;
  metadata?: SessionHeaderMetadata;
} {
  const worker = lineage?.worker;
  const branch = lineage?.branch;
  if (worker === undefined && branch === undefined) {
    return {};
  }
  const parentSessionId = worker?.parentSessionId ?? branch?.sourceSessionId;
  return {
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    metadata: {
      version: SESSION_ENTRY_VERSION,
      ...(worker !== undefined
        ? {
            worker: {
              ...(worker.parentRunId !== undefined ? { parentRunId: worker.parentRunId } : {}),
              name: worker.worker.name,
              role: worker.worker.role,
              workspace: worker.workspace,
              startedAt: worker.startedAt,
            },
          }
        : {}),
      ...(branch !== undefined ? { branch: branchMetadata(branch) } : {}),
    },
  };
}

function branchMetadata(branch: BranchHeaderInput): NonNullable<SessionHeaderMetadata["branch"]> {
  return {
    sourceSessionId: branch.sourceSessionId,
    forkPoint: branch.forkPoint,
    checkpoint: branch.checkpoint,
    workspace: branch.workspace,
    trigger: branch.trigger,
    startedAt: branch.startedAt,
  };
}

// 双写之前就存在的旧会话的写者：什么都不写、不建文件、不告警
function legacySessionStore(sessionId: string): SessionStoreWriter {
  return {
    sessionId,
    appendMessage: () => {},
    append: () => {},
    flush: async () => {},
    filePath: async () => undefined,
    close: async () => {},
  };
}

// 旧账本里这个会话已有记录（在打开新存储之前）；读者据此区分"双写之前的旧会话"与"不存在"
export function hasLegacyRecords(sessionsDir: string, sessionId: string): boolean {
  const path = JsonlEventLog.filePathFor(sessionsDir, sessionId as never);
  return existsSync(path) && statSync(path).size > 0;
}

// 打开一个会话的新存储写者：已有会话文件即打开续写；没有文件而旧账本已有记录的（双写之前的旧会话）不写；否则以 cwd 新建
export function openSessionStore(input: {
  sessionsDir: string;
  sessionId: string;
  cwd: string;
  lineage?: StoreLineage;
  onFault: StoreFaultHandler;
}): SessionStoreWriter {
  let existingPath: string | undefined;
  try {
    existingPath = locateSessionFile(input.sessionsDir, input.sessionId)?.path;
  } catch (error) {
    input.onFault(new SessionStoreFault("定位会话文件", error));
  }
  if (existingPath === undefined && hasLegacyRecords(input.sessionsDir, input.sessionId)) {
    return legacySessionStore(input.sessionId);
  }
  return openSessionStoreWriter({
    sessionsRoot: input.sessionsDir,
    sessionId: input.sessionId,
    cwd: input.cwd,
    ...(existingPath !== undefined ? { existingPath } : {}),
    ...headerOf(input.lineage),
    lock: acquireSessionFileLock,
    onFault: input.onFault,
  });
}

// ---- 旧写入输入 → 新条目 ----

export function verificationEntry(input: AttemptVerifiedInput): SessionCustomEntry {
  return {
    customType: SessionEntryType.Verification,
    data: {
      version: SESSION_ENTRY_VERSION,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      target: input.target,
      command: [...input.command],
      exitCode: input.exitCode,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      timedOut: input.timedOut,
      ...(input.error !== undefined ? { error: input.error } : {}),
      durationMs: input.durationMs,
      outputBytes: input.outputBytes,
      outputHash: input.outputHash,
      output: input.output,
      truncated: input.truncated,
      workspace: input.workspace,
      verdict: input.verdict,
      verifiedAt: input.verifiedAt,
      ...(input.steps !== undefined ? { steps: input.steps.map((step) => ({ ...step })) } : {}),
    },
  };
}

export function checkpointEntry(
  runId: RunId,
  payload: Omit<WorkspaceCheckpointPayload, "afterRunSeq">
): SessionCustomEntry {
  return {
    customType: SessionEntryType.Checkpoint,
    data: {
      version: SESSION_ENTRY_VERSION,
      runId,
      toolCallId: payload.toolCallId,
      ref: payload.ref,
      commit: payload.commit,
      tree: payload.tree,
      ...(payload.baseCommit !== undefined ? { baseCommit: payload.baseCommit } : {}),
    },
  };
}

export function workerSpawnedEntry(input: ChildSpawnedInput): SessionCustomEntry {
  return {
    customType: SessionEntryType.Worker,
    data: {
      version: SESSION_ENTRY_VERSION,
      event: "spawned",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      childSessionId: input.childSessionId,
      name: input.name,
      role: input.role,
      task: input.task,
      policy: input.policy,
      limits: input.limits,
      workspace: input.workspace,
      spawnedAt: input.spawnedAt,
    },
  };
}

export function workerSettledEntry(input: ChildSettledInput): SessionCustomEntry {
  const result = input.result;
  return {
    customType: SessionEntryType.Worker,
    data: {
      version: SESSION_ENTRY_VERSION,
      event: "settled",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      childSessionId: input.childSessionId,
      name: input.name,
      status: input.status,
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(result !== undefined
        ? {
            result: {
              ...(result.branch !== undefined ? { branch: result.branch } : {}),
              ...(result.changedFiles !== undefined ? { changedFiles: result.changedFiles } : {}),
              summary: result.summary,
              summaryTruncated: result.summaryTruncated,
            },
          }
        : {}),
      turns: input.turns,
      settledAt: input.settledAt,
    },
  };
}

export function forkEntry(
  input: SessionForkedInput & { runId: RunId },
  forkEntryId: string | undefined
): SessionCustomEntry {
  return {
    customType: SessionEntryType.Fork,
    data: {
      version: SESSION_ENTRY_VERSION,
      runId: input.runId,
      branchSessionId: input.branchSessionId,
      forkPoint: input.forkPoint,
      ...(forkEntryId !== undefined ? { forkEntryId } : {}),
      checkpoint: input.checkpoint,
      trigger: input.trigger,
      forkedAt: input.forkedAt,
    },
  };
}

export function grantCreatedEntry(input: GrantCreatedInput): SessionCustomEntry {
  return {
    customType: SessionEntryType.Grant,
    data: {
      version: SESSION_ENTRY_VERSION,
      event: "created",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      grantId: input.grantId,
      tool: input.tool,
      ...(input.pathPrefix !== undefined ? { pathPrefix: input.pathPrefix } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.shell !== undefined ? { shell: input.shell } : {}),
      firstCall: input.firstCall,
      createdAt: input.createdAt,
    },
  };
}

export function grantRevokedEntry(input: GrantRevokedInput): SessionCustomEntry {
  return {
    customType: SessionEntryType.Grant,
    data: {
      version: SESSION_ENTRY_VERSION,
      event: "revoked",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      grantId: input.grantId,
      revokedAt: input.revokedAt,
    },
  };
}

// ---- 不触达 pi-runtime 的层的写入点：给它们的旧落盘口套一层，先写旧账本、再写新存储 ----

interface GrantEventLog {
  appendGrantCreated(input: GrantCreatedInput): unknown;
  appendGrantRevoked(input: GrantRevokedInput): unknown;
}

// 授权（approvals/grant-store.ts 的落盘口）：旧账本写不进即抛（授权不生效），新存储不写
export function teeGrantEvents(log: GrantEventLog, store: SessionEntrySink): GrantEventLog {
  return {
    appendGrantCreated: (input) => {
      const record = log.appendGrantCreated(input);
      store.append(grantCreatedEntry(input));
      return record;
    },
    appendGrantRevoked: (input) => {
      const record = log.appendGrantRevoked(input);
      store.append(grantRevokedEntry(input));
      return record;
    },
  };
}

interface ChildFamilyLog {
  appendChildSpawned(input: ChildSpawnedInput): unknown;
  appendChildSettled(input: ChildSettledInput): unknown;
}

// worker 派出与收尾（orchestration/workers.ts 的父会话落盘口）：旧账本写不进即抛（不派），新存储不写
export function teeChildFamilies(log: ChildFamilyLog, store: SessionEntrySink): ChildFamilyLog {
  return {
    appendChildSpawned: (input) => {
      const record = log.appendChildSpawned(input);
      store.append(workerSpawnedEntry(input));
      return record;
    },
    appendChildSettled: (input) => {
      const record = log.appendChildSettled(input);
      store.append(workerSettledEntry(input));
      return record;
    },
  };
}

// ---- 分叉 ----

export interface StoreFork {
  // 用 pi 的 fork 为分支会话建文件（分叉点之前的历史复制过去，文件头记来源与分支来历），返回分支文件路径；
  // 失败按内部故障告警并返回 undefined（分叉续跑的初始消息读不到，由调用方决定报错）
  forkBranch(input: {
    branchSessionId: string;
    cwd: string;
    branch: BranchHeaderInput;
  }): Promise<string | undefined>;
  // 放弃（分叉中途失败时）：释放本段打开的来源写者
  release(): Promise<void>;
}

// 分叉第一步：来源会话记下分叉条目（在旧账本记下分叉记录之后调用）。来源写者由本进程运行面持有时传入（先 flush 再读），
// 否则按会话号打开来源文件并持锁到分支文件建好。来源在新存储里没有文件时告警并返回 undefined，分支文件由它的运行面新建
export async function beginStoreFork(input: {
  sessionsDir: string;
  sourceSessionId: string;
  sourceStore?: SessionStoreWriter;
  cwd: string;
  forked: SessionForkedInput & { runId: RunId };
  onFault: StoreFaultHandler;
}): Promise<StoreFork | undefined> {
  let store = input.sourceStore;
  let owned = false;
  if (store === undefined) {
    const located = locateSessionFile(input.sessionsDir, input.sourceSessionId);
    if (located === undefined) {
      input.onFault(new SessionStoreFault("分叉", new Error("来源会话在新存储里没有会话文件")));
      return undefined;
    }
    store = openSessionStoreWriter({
      sessionsRoot: input.sessionsDir,
      sessionId: input.sourceSessionId,
      cwd: input.cwd,
      existingPath: located.path,
      lock: acquireSessionFileLock,
      onFault: input.onFault,
    });
    owned = true;
  }
  const source = store;
  const release = async () => {
    if (owned) {
      await source.close();
    }
  };
  try {
    await source.flush();
    const sourcePath = await source.filePath();
    if (sourcePath === undefined) {
      await release();
      return undefined;
    }
    const view = readSessionFile(sourcePath);
    const main = view !== undefined ? branchEntries(view, view.lanes.get("main") ?? null) : [];
    const forkEntryId = messageEntryAt(
      main,
      input.forked.forkPoint.runId,
      input.forked.forkPoint.runSeq
    );
    source.append(forkEntry(input.forked, forkEntryId));
    await source.flush();
    return {
      forkBranch: async ({ branchSessionId, cwd, branch }) => {
        try {
          if (forkEntryId === undefined) {
            throw new Error("分叉点在来源会话的新存储里没有对应消息");
          }
          return await forkSessionFile({
            sessionsRoot: input.sessionsDir,
            source: { sessionId: input.sourceSessionId, path: sourcePath },
            entryId: forkEntryId,
            branchSessionId,
            cwd,
            metadata: { version: SESSION_ENTRY_VERSION, branch: branchMetadata(branch) },
          });
        } catch (error) {
          input.onFault(new SessionStoreFault("分叉", error));
          return undefined;
        } finally {
          await release();
        }
      },
      release,
    };
  } catch (error) {
    input.onFault(new SessionStoreFault("分叉", error));
    await release();
    return undefined;
  }
}
