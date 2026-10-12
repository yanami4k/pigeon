// 取用 worker 自身改动的工具 take_worker（决策 279）：把一个已收尾的 worker 相对起点快照自己的改动，以三方方式叠进主工作目录，
// 返回叠入、冲突、worker 删除三份清单。取不取由主 agent（本工具）或人（终端界面的 /take，同一套文字）决定。
// - 叠加本身在执行层 worker-overlay.ts：只写 worker 改过的文件，不删除不回退，冲突不写入、worker 分支与工作树原样保留，
//   不设撤销。
// - 续接后从会话记录找回的之前运行的 worker（previous-workers.ts）：已收尾的照常可取，只有派出没有收尾的不可取用。
// - 取用依赖 worker 的工作树还在（日常使用里工作树不自动清理，由人用 git worktree remove 处理；跑批器每次运行收尾自行清理）；
//   工作树已清理即返回明确的一句。
// - 写工作目录，归写档、按写操作审批；与 spawn_worker 共用同一个工具槽（编排器与工作区根），注册范围相同（265–267：只给终端
//   界面与 pigeon run 的主会话；命令行对话、worker 自己、沙箱会话与跑批器各条件都不注册）。
// - 工具说明、参数说明与各情形的返回文字为定稿原文。
import { existsSync } from "node:fs";
import { type Static, Type } from "typebox";
import {
  OverlayError,
  type OverlayResult,
  overlayWorkerChanges,
  workerOverlayPaths,
} from "../execution/worker-overlay.ts";
import type { WorkerOrchestrator } from "../orchestration/workers.ts";
import { isUnderPigeonDir } from "../state/paths.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import {
  type SpawnWorkerSlot,
  skippedFilesForModel,
  TAKE_WORKER_TOOL,
} from "./spawn-worker-tool.ts";

export { TAKE_WORKER_TOOL };

// 工具说明（定稿原文）
export const TAKE_WORKER_DESCRIPTION = [
  "Apply a finished worker's own changes to your working directory. A worker starts from a snapshot taken at spawn time; this tool takes only the files it changed after that snapshot and merges them file by file with a three-way merge, using the snapshot version as the common ancestor, into your working directory.",
  "Only files the worker changed are written; files it did not touch are left alone. Nothing in your working directory is deleted or reverted. Files the worker deleted are not deleted automatically; they are only listed in the result, and you decide whether to delete them.",
  "Files that cannot be merged (you also changed the same spot) are not written and are listed as conflicts; the worker's branch and worktree are kept as they are, and you can see its changes to those files with: git -C <worktree path> diff <snapshot> -- <file>. Applying cannot be undone: review the returned summary and changed files before applying.",
  "Take the changes of several workers one at a time as needed, finishing one before taking the next; if a later one changed the same spot as an earlier one, it is listed as a conflict.",
  "Returns three lists: files applied, files with conflicts that were not written, and files the worker deleted.",
].join("\n");

// 参数（说明为定稿原文）
export const TakeWorkerParamsSchema = Type.Object({
  worker: Type.String({
    description:
      "The worker's name, as given in the result returned by spawn_worker (branch pigeon/<name>)",
  }),
});
export type TakeWorkerParams = Static<typeof TakeWorkerParamsSchema>;

// 文件列表：逗号相接；一个都没有时写 none
function fileList(files: readonly string[]): string {
  return files.length > 0 ? files.join(", ") : "none";
}

// 各情形的返回文字（定稿原文）
export const TAKE_WORKER_TEXTS = {
  taken: (name: string, result: OverlayResult, view: { worktree: string; base: string }) =>
    `Applied the changes of worker ${name} to the working directory. Files applied (${result.applied.length}): ${fileList(result.applied)}. ` +
    `Files with conflicts, not written (${result.conflicts.length}): ${fileList(result.conflicts)}` +
    (result.conflicts.length > 0
      ? `; to see the worker's changes to these files: git -C ${view.worktree} diff ${view.base.slice(0, 12)} -- <file>`
      : "") +
    `. Files deleted by the worker (${result.deletedByWorker.length}, not deleted here): ${fileList(result.deletedByWorker)}.`,
  noChanges: (name: string) =>
    `Worker ${name} has no changes relative to its start snapshot; the working directory is unchanged.`,
  running: (name: string) =>
    `Worker ${name} has not finished yet; take its changes after it returns.`,
  unknown: (name: string) =>
    `There is no worker named ${name}; use the name given in the result returned by spawn_worker.`,
  worktreeGone: (name: string) =>
    `The worktree of worker ${name} has been cleaned up, so its changes cannot be taken.`,
  noStart: (name: string) =>
    `Worker ${name} has no recorded start snapshot, so its changes cannot be taken.`,
  // 续接后从会话记录找回的、只有派出没有收尾的（权威链审计 ②）
  interrupted: (name: string) =>
    `Worker ${name} was spawned by an earlier run and was interrupted when that process exited without returning a result, so its changes cannot be taken; its branch and worktree are left where they are.`,
  failed: (name: string, reason: string, applied: readonly string[]) =>
    `Taking the changes of worker ${name} failed: ${reason}. Files applied (${applied.length}): ${fileList(applied)}.`,
  // 决策 377：只读的 explorer 不建工作树、不交改动
  readOnly: (name: string) =>
    `Worker ${name} is a read-only explorer and has no changes to take; its conclusions are in the returned summary.`,
} as const;

// 决策 381：worker 新建却因过大没写进树、因而没叠入的文件（附在叠入结果之后；不属定稿原文）
export function overlaySkippedLine(result: OverlayResult): string {
  return result.skipped !== undefined && result.skipped.length > 0
    ? `\nLarge files not applied (${result.skipped.length}; created by the worker, untracked and too large, so they stay in its worktree): ${skippedFilesForModel(result.skipped)}`
    : "";
}

export interface TakeWorkerDetails {
  worker: string;
  result?: OverlayResult;
  rejected?:
    | "unknown"
    | "running"
    | "interrupted"
    | "worktree-gone"
    | "no-start"
    | "unbound"
    | "failed"
    | "read-only";
}

// 决策 340：叠回会写到项目 .pigeon 下的文件（受保护路径）。叠回取用与脚本整批收回据此按受保护路径请示（逐次人批、放权不算，
// yolo 放行），免得放权经叠回绕开审批。算不出（worker 不在、未收尾、工作树已清理等）给空清单，由取用本身如实报错
export function protectedOverlayPaths(
  target: { base: string; worktree: string },
  repoRoot: string
): string[] {
  if (!existsSync(target.worktree)) return [];
  try {
    return workerOverlayPaths({
      repoRoot,
      base: target.base,
      worktreePath: target.worktree,
    }).filter(isUnderPigeonDir);
  } catch {
    return [];
  }
}

// 一个 worker 名对应的叠回目标（已收尾、有工作树与起点快照的才有）
function overlayTargetOf(
  host: { orchestrator: Pick<WorkerOrchestrator, "status"> },
  worker: string
): { base: string; worktree: string } | undefined {
  const status = host.orchestrator.status().find((entry) => entry.name === worker.trim());
  if (
    status === undefined ||
    status.state === "running" ||
    status.state === "queued" ||
    status.previousRun === "interrupted" ||
    status.workspace.kind !== "git-worktree" ||
    status.workspace.baseCommit === undefined
  ) {
    return undefined;
  }
  return { base: status.workspace.baseCommit, worktree: status.workspace.path };
}

// 取用一个 worker 的改动并给出文字（工具与终端界面的 /take 共用）
export function takeWorkerChanges(
  host: {
    // 决策 381：编排器在场时按它的未跟踪文件上限写 worker 的树（替身可以不给，取产品缺省）
    orchestrator: Pick<WorkerOrchestrator, "status"> &
      Partial<Pick<WorkerOrchestrator, "untrackedLimits">>;
    workspaceRoot: string;
  },
  worker: string
): { text: string; details: TakeWorkerDetails } {
  const name = worker.trim();
  const status = host.orchestrator.status().find((entry) => entry.name === name);
  if (status === undefined) {
    return {
      text: TAKE_WORKER_TEXTS.unknown(name),
      details: { worker: name, rejected: "unknown" },
    };
  }
  if (status.state === "running" || status.state === "queued") {
    return {
      text: TAKE_WORKER_TEXTS.running(name),
      details: { worker: name, rejected: "running" },
    };
  }
  if (status.previousRun === "interrupted") {
    return {
      text: TAKE_WORKER_TEXTS.interrupted(name),
      details: { worker: name, rejected: "interrupted" },
    };
  }
  if (status.workspace.kind === "shared") {
    return {
      text: TAKE_WORKER_TEXTS.readOnly(name),
      details: { worker: name, rejected: "read-only" },
    };
  }
  if (status.workspace.kind !== "git-worktree") {
    return {
      text: TAKE_WORKER_TEXTS.failed(name, "this worker has no worktree", []),
      details: { worker: name, rejected: "failed" },
    };
  }
  const base = status.workspace.baseCommit;
  if (base === undefined) {
    return {
      text: TAKE_WORKER_TEXTS.noStart(name),
      details: { worker: name, rejected: "no-start" },
    };
  }
  if (!existsSync(status.workspace.path)) {
    return {
      text: TAKE_WORKER_TEXTS.worktreeGone(name),
      details: { worker: name, rejected: "worktree-gone" },
    };
  }
  let result: OverlayResult;
  try {
    result = overlayWorkerChanges({
      repoRoot: host.workspaceRoot,
      base,
      worktreePath: status.workspace.path,
      ...(host.orchestrator.untrackedLimits !== undefined
        ? { limits: host.orchestrator.untrackedLimits }
        : {}),
    });
  } catch (error) {
    const applied = error instanceof OverlayError ? (error.partial?.applied ?? []) : [];
    return {
      text: TAKE_WORKER_TEXTS.failed(
        name,
        error instanceof Error ? error.message : String(error),
        applied
      ),
      details: { worker: name, rejected: "failed" },
    };
  }
  const empty =
    result.applied.length === 0 &&
    result.unchanged.length === 0 &&
    result.conflicts.length === 0 &&
    result.deletedByWorker.length === 0;
  return {
    text:
      (empty
        ? TAKE_WORKER_TEXTS.noChanges(name)
        : TAKE_WORKER_TEXTS.taken(name, result, { worktree: status.workspace.path, base })) +
      overlaySkippedLine(result),
    details: { worker: name, result },
  };
}

function reply(text: string, details: TakeWorkerDetails): PigeonToolResult<TakeWorkerDetails> {
  return { content: [{ type: "text", text }], details };
}

// 与 spawn_worker 共用同一个槽：编排器建好后 bind 一次，两件工具都能用
export function createTakeWorkerTool(slot: SpawnWorkerSlot): PigeonAgentTool<
  typeof TakeWorkerParamsSchema,
  TakeWorkerDetails
> & {
  inspectProtectedPaths(args: unknown): string[];
} {
  return {
    name: TAKE_WORKER_TOOL,
    label: TAKE_WORKER_TOOL,
    description: TAKE_WORKER_DESCRIPTION,
    parameters: TakeWorkerParamsSchema,
    executionMode: "sequential",
    // 决策 340：治理层据此把写 .pigeon 的叠回按受保护路径处理（只读判定，不叠加）
    inspectProtectedPaths(args: unknown): string[] {
      const host = slot.host;
      const worker = (args as { worker?: unknown } | null)?.worker;
      if (host === undefined || typeof worker !== "string") return [];
      const target = overlayTargetOf(host, worker);
      return target !== undefined ? protectedOverlayPaths(target, host.workspaceRoot) : [];
    },
    async execute(_toolCallId, params): Promise<PigeonToolResult<TakeWorkerDetails>> {
      const host = slot.host;
      if (host === undefined) {
        return reply(
          TAKE_WORKER_TEXTS.failed(
            params.worker,
            "this session has no worker orchestrator set up",
            []
          ),
          { worker: params.worker, rejected: "unbound" }
        );
      }
      const { text, details } = takeWorkerChanges(host, params.worker);
      return reply(text, details);
    },
  };
}

// 装配根注册用的元数据：写档（写主工作目录，按写操作审批）、路径限定在工作区、串行
export function takeWorkerRegistration(): ToolRegistration {
  return {
    name: TAKE_WORKER_TOOL,
    description: "把一个已收尾的 worker 自己的改动叠进工作目录",
    parameters: TakeWorkerParamsSchema,
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  };
}
