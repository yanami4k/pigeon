// 取用 worker 自身改动的工具 take_worker（决策 279）：把一个已收尾的 worker 相对起点快照自己的改动，以三方方式叠进主工作目录，
// 返回叠入、冲突、worker 删除三份清单。取不取由主 agent（本工具）或人（终端界面的 /take，同一套文字）决定。
// - 叠加本身在执行层 worker-overlay.ts：只写 worker 改过的文件，不删除不回退，冲突不写入、worker 分支与工作树原样保留，
//   不设撤销。
// - 续接后从会话记录找回的之前运行的 worker（previous-workers.ts）：已收尾的照常可取，只有派出没有收尾的不可取用。
// - 取用依赖 worker 的工作树还在（日常使用里工作树不自动清理，由人用 git worktree remove 处理；跑批器每次运行收尾自行清理）；
//   工作树已清理即返回明确的一句。
// - 写工作目录，归写档、按写操作审批；与 spawn_worker 共用同一个工具槽（编排器与治理根），注册范围相同（265–267：只给终端
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
import { skippedFilesText } from "../state/snapshot-config.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import { type SpawnWorkerSlot, TAKE_WORKER_TOOL } from "./spawn-worker-tool.ts";

export { TAKE_WORKER_TOOL };

// 工具说明（定稿原文）
export const TAKE_WORKER_DESCRIPTION = [
  "把一个已收尾的 worker 自己的改动叠进你的工作目录。worker 从派出时拍的快照开工；本工具只取快照之后它改过的文件，以快照里的版本为共同祖先逐文件三方合并，写进你的工作目录。",
  "只写入 worker 改过的文件，它没碰的文件一律不动；不删除、不回退你工作目录里的任何文件。worker 删除的文件不自动删，只在结果里列出，由你决定删不删。",
  "叠不上的文件（你在同一处也改了）不写入，列在冲突清单里；worker 的分支与工作树原样保留，查看它在这些文件上的改动：git -C <工作树路径> diff <快照号> -- <文件>。叠加没有撤销：叠之前先看清交回的摘要与改动文件。",
  "多个 worker 的改动按需要逐个取，前一个取完再取下一个；后取的若和先取的改了同一处，会列为冲突。",
  "返回三份清单：已叠入的文件、有冲突未写入的文件、worker 删除的文件。",
].join("\n");

// 参数（说明为定稿原文）
export const TakeWorkerParamsSchema = Type.Object({
  worker: Type.String({
    description: "worker 的名字，即 spawn_worker 交回结果里的名字（分支 pigeon/<名>）",
  }),
});
export type TakeWorkerParams = Static<typeof TakeWorkerParamsSchema>;

// 文件列表：顿号相接；一个都没有时写"无"
function fileList(files: readonly string[]): string {
  return files.length > 0 ? files.join("、") : "无";
}

// 各情形的返回文字（定稿原文）
export const TAKE_WORKER_TEXTS = {
  taken: (name: string, result: OverlayResult, view: { worktree: string; base: string }) =>
    `已把 worker ${name} 的改动叠进工作目录。叠入的文件（${result.applied.length}）：${fileList(result.applied)}。` +
    `冲突未写入的文件（${result.conflicts.length}）：${fileList(result.conflicts)}` +
    (result.conflicts.length > 0
      ? `；查看 worker 在这些文件上的改动：git -C ${view.worktree} diff ${view.base.slice(0, 12)} -- <文件>`
      : "") +
    `。worker 删除的文件（${result.deletedByWorker.length}，未删）：${fileList(result.deletedByWorker)}。`,
  noChanges: (name: string) => `worker ${name} 相对起点快照没有改动，工作目录未变。`,
  running: (name: string) => `worker ${name} 还没收尾，等它交回后再取。`,
  unknown: (name: string) => `没有名为 ${name} 的 worker；用 spawn_worker 交回结果里的名字。`,
  worktreeGone: (name: string) => `worker ${name} 的工作树已清理，改动无法取用。`,
  noStart: (name: string) => `worker ${name} 没有记录起点快照，改动无法取用。`,
  // 续接后从会话记录找回的、只有派出没有收尾的（权威链审计 ②）
  interrupted: (name: string) =>
    `worker ${name} 是之前的运行派出的，随上次进程退出而中断、没有交回结果，改动不可取用；它的分支与工作树留在原处。`,
  failed: (name: string, reason: string, applied: readonly string[]) =>
    `取用 worker ${name} 的改动失败：${reason}。已叠入的文件（${applied.length}）：${fileList(applied)}。`,
  // 决策 377：只读的 explorer 不建工作树、不交改动
  readOnly: (name: string) =>
    `worker ${name} 是只读的 explorer，没有改动可取用；它的结论在交回的摘要里。`,
} as const;

// 决策 381：worker 新建却因过大没写进树、因而没叠入的文件（附在叠入结果之后；不属定稿原文）
export function overlaySkippedLine(result: OverlayResult): string {
  return result.skipped !== undefined && result.skipped.length > 0
    ? `\n未叠入的大文件（${result.skipped.length}，worker 新建、未跟踪且过大，留在它的工作树里）：${skippedFilesText(result.skipped)}`
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
    governanceRoot: string;
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
      text: TAKE_WORKER_TEXTS.failed(name, "这个 worker 没有工作树", []),
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
      repoRoot: host.governanceRoot,
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
      return target !== undefined ? protectedOverlayPaths(target, host.governanceRoot) : [];
    },
    async execute(_toolCallId, params): Promise<PigeonToolResult<TakeWorkerDetails>> {
      const host = slot.host;
      if (host === undefined) {
        return reply(TAKE_WORKER_TEXTS.failed(params.worker, "本会话没有装配编排器", []), {
          worker: params.worker,
          rejected: "unbound",
        });
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
