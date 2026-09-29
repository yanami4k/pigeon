// 终端界面退出（决策 283）：/quit、双击 Ctrl+C、SIGINT/SIGTERM 等正常退出一律立即收尾，不跑收尾复盘、不调用模型。
// 收尾顺序：取消在跑的 worker 并等其收尾记录落盘（有上限）→ 释放运行面 → 沙箱会话交回并删除容器 → 在会话文件末尾追加一条
// 退出条目，记下退出那一刻工作目录的样子，供下次启动终端界面时后台补做复盘读代码（review-backfill.ts）。
// - 本机 git 工作区：沿用 278、279 的工作目录快照（受跟踪文件的当前内容加未被忽略的新文件，以 HEAD 为父），挂在
//   refs/pigeon/exit/<会话号> 上防回收；没有未提交改动时即 HEAD，不另建提交。补做完成或判定过时后删除该引用。
// - 非 git 工作区、仓库还没有提交、拍快照失败：记"无快照"与原因。
// - 沙箱会话：不另拍，记交回的分支与提交；交回失败时记无快照与原因。
// - 这次会话一次运行都没跑过（会话文件里没有 Run 开始条目）：不记。
// 退出条目写在运行面释放之后：写者已关，另开一个写者续写同一会话文件再关上（同一把会话锁）。
import { existsSync } from "node:fs";
import type { SandboxExport } from "../execution/sandbox.ts";
import {
  deleteSnapshotRef,
  snapshotWorkdir,
  WorkdirSnapshotError,
} from "../execution/workdir-snapshot.ts";
import { locateSessionFile, readSessionFile } from "../persistence/session-reader.ts";
import type { SessionId } from "../state/ids.ts";
import {
  type ExitData,
  SESSION_ENTRY_VERSION,
  SessionEntryType,
} from "../state/session-entries.ts";
import { disposeRuntime, type RuntimeBundle } from "./runtime.ts";
import { openSessionStore, storeFaultWarner } from "./session-store.ts";
import { failureDetail, type WarnSink } from "./warnings.ts";
import { sessionsDirOf } from "./workspace.ts";

// 退出快照引用：一个会话一条，再次退出时覆盖
export function exitSnapshotRef(sessionId: string): string {
  return `refs/pigeon/exit/${sessionId}`;
}

// 删掉退出快照引用（补做完成或判定过时之后）；不是 git 工作区或引用本就不在都算删掉
export function dropExitSnapshotRef(repoRoot: string, sessionId: string): void {
  try {
    deleteSnapshotRef(repoRoot, exitSnapshotRef(sessionId));
  } catch {
    // 删不掉只是多留一个引用，不影响任何结果
  }
}

// 会话文件里有没有 Run 开始条目（一次运行都没跑过的会话不记退出快照）；另给出会话的工作目录
function sessionFacts(
  governanceRoot: string,
  sessionId: SessionId
): { ran: boolean; cwd?: string } {
  const located = locateSessionFile(sessionsDirOf(governanceRoot), sessionId);
  if (located === undefined) {
    return { ran: false };
  }
  const view = readSessionFile(located.path);
  if (view === undefined) {
    return { ran: false };
  }
  const ran = view.entries.some(
    (entry) => entry.type === "custom" && entry.customType === SessionEntryType.RunStart
  );
  return { ran, cwd: view.header.cwd };
}

// 退出那一刻工作目录的样子
export function exitWorkdirOf(input: {
  repoRoot: string;
  sessionId: SessionId;
  sandbox?: { exported?: SandboxExport; error?: string };
}): ExitData["workdir"] {
  if (input.sandbox !== undefined) {
    const exported = input.sandbox.exported;
    return exported !== undefined
      ? { kind: "sandbox", branch: exported.branch, commit: exported.commit }
      : { kind: "none", reason: `沙箱交回失败：${input.sandbox.error ?? "原因不明"}` };
  }
  try {
    const snap = snapshotWorkdir({
      repoRoot: input.repoRoot,
      ref: exitSnapshotRef(input.sessionId),
    });
    return {
      kind: "snapshot",
      commit: snap.commit,
      head: snap.head,
      ...(snap.ref !== undefined ? { ref: snap.ref } : {}),
    };
  } catch (error) {
    const reason =
      error instanceof WorkdirSnapshotError ? error.message : `拍快照失败：${failureDetail(error)}`;
    return { kind: "none", reason };
  }
}

// 给已释放运行面的会话记一条退出条目；没跑过运行的会话不记，返回 undefined
export async function recordTuiExit(input: {
  governanceRoot: string;
  sessionId: SessionId;
  sandbox?: { exported?: SandboxExport; error?: string };
  warn?: WarnSink;
  now?: () => number;
}): Promise<ExitData | undefined> {
  const facts = sessionFacts(input.governanceRoot, input.sessionId);
  if (!facts.ran) {
    return undefined;
  }
  // 会话的工作目录（worker 会话是它自己的工作树）；目录已不在时退回治理根
  const repoRoot =
    facts.cwd !== undefined && facts.cwd !== "" && existsSync(facts.cwd)
      ? facts.cwd
      : input.governanceRoot;
  const data: ExitData = {
    version: SESSION_ENTRY_VERSION,
    exitedAt: (input.now ?? Date.now)(),
    workdir: exitWorkdirOf({
      repoRoot,
      sessionId: input.sessionId,
      ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
    }),
  };
  const store = openSessionStore({
    sessionsDir: sessionsDirOf(input.governanceRoot),
    sessionId: input.sessionId,
    cwd: repoRoot,
    onFault: storeFaultWarner(input.warn),
  });
  store.append({ customType: SessionEntryType.Exit, data });
  await store.close();
  return data;
}

// 退出时取消的 worker：编排器面的最小子集
export interface ExitWorkers {
  status(): ReadonlyArray<{ sessionId: SessionId; state: string }>;
  cancel(id: SessionId): Promise<unknown>;
  awaitResult(id: SessionId): Promise<unknown>;
}

export interface CloseTuiSessionInput {
  governanceRoot: string;
  sessionId: SessionId;
  bundle: RuntimeBundle;
  workers?: ExitWorkers;
  // 等 worker 收尾记录落盘的上限（毫秒）：超时仍退出，缺 settled 由冷侧如实标注
  workerGraceMs: number;
  // 沙箱会话：交回并删除容器（决策 245），返回给人看的一句话与交回结果
  closeSandbox?: () => Promise<{ notice: string; exported?: SandboxExport }>;
  // 沙箱交回的提示（壳已停，打到标准输出）
  log?: (line: string) => void;
  warn?: WarnSink;
}

// 终端界面会话的收尾：不复盘、不调用模型（283）；退出条目记不成只告警，不挡退出
export async function closeTuiSession(input: CloseTuiSessionInput): Promise<void> {
  const workers = input.workers;
  if (workers !== undefined) {
    const running = workers
      .status()
      .filter((worker) => worker.state === "running" || worker.state === "queued");
    await Promise.allSettled(running.map((worker) => workers.cancel(worker.sessionId)));
    await Promise.race([
      Promise.allSettled(running.map((worker) => workers.awaitResult(worker.sessionId))),
      new Promise((resolve) => setTimeout(resolve, input.workerGraceMs)),
    ]);
  }
  await disposeRuntime(input.bundle);
  let sandbox: { exported?: SandboxExport; error?: string } | undefined;
  if (input.closeSandbox !== undefined) {
    const closed = await input.closeSandbox();
    input.log?.(closed.notice);
    sandbox =
      closed.exported !== undefined ? { exported: closed.exported } : { error: closed.notice };
  }
  try {
    await recordTuiExit({
      governanceRoot: input.governanceRoot,
      sessionId: input.sessionId,
      ...(sandbox !== undefined ? { sandbox } : {}),
      ...(input.warn !== undefined ? { warn: input.warn } : {}),
    });
  } catch (error) {
    (input.warn ?? ((line: string) => console.error(line)))(
      `退出快照没有记成：${failureDetail(error)}（下次启动补做复盘时改读当前工作目录）`
    );
  }
}
