// 取用 worker 自身改动的工具 take_worker（决策 279）：把一个已收尾的 worker 相对起点快照自己的改动，以三方方式叠进主工作目录，
// 返回叠入、冲突、worker 删除三份清单。取不取由主 agent（本工具）或人（终端界面的 /take，同一套文字）决定。
// - 叠加本身在执行层 worker-overlay.ts：只写 worker 改过的文件，不删除不回退，冲突不写入、worker 分支与工作树原样保留，
//   不设撤销。
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
} from "../execution/worker-overlay.ts";
import type { WorkerOrchestrator } from "../orchestration/workers.ts";
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
  failed: (name: string, reason: string, applied: readonly string[]) =>
    `取用 worker ${name} 的改动失败：${reason}。已叠入的文件（${applied.length}）：${fileList(applied)}。`,
} as const;

export interface TakeWorkerDetails {
  worker: string;
  result?: OverlayResult;
  rejected?: "unknown" | "running" | "worktree-gone" | "no-start" | "unbound" | "failed";
}

// 取用一个 worker 的改动并给出文字（工具与终端界面的 /take 共用）
export function takeWorkerChanges(
  host: { orchestrator: Pick<WorkerOrchestrator, "status">; governanceRoot: string },
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
    text: empty
      ? TAKE_WORKER_TEXTS.noChanges(name)
      : TAKE_WORKER_TEXTS.taken(name, result, { worktree: status.workspace.path, base }),
    details: { worker: name, result },
  };
}

function reply(text: string, details: TakeWorkerDetails): PigeonToolResult<TakeWorkerDetails> {
  return { content: [{ type: "text", text }], details };
}

// 与 spawn_worker 共用同一个槽：编排器建好后 bind 一次，两件工具都能用
export function createTakeWorkerTool(
  slot: SpawnWorkerSlot
): PigeonAgentTool<typeof TakeWorkerParamsSchema, TakeWorkerDetails> {
  return {
    name: TAKE_WORKER_TOOL,
    label: TAKE_WORKER_TOOL,
    description: TAKE_WORKER_DESCRIPTION,
    parameters: TakeWorkerParamsSchema,
    executionMode: "sequential",
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
