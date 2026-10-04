// 手动分叉命令层（M7 S6，决策 079）：cli 与 tui 主会话共用一份。
// 用法：/fork [--at <条目号> | --at <Run 号前缀>:<条目号>] ["新输入"]
// - 缺省分叉点：最近一次 Run 的任务开始处（第一条人输入的消息，跳过开工状态块）；只给条目号时指最近一次 Run；Run 号可用唯一前缀（trace 里显示的短号）；
// - 分叉点末条是用户消息或工具结果时不给新输入直接续跑；末条是助手消息时必须给新输入；
// - 分支在独立工作树里续跑，跑完回报分支会话、工作树、终态与标签。
// 分叉点从会话存储定位；本会话在会话存储里没有文件时明确报错。
import { loadStoreSession } from "../persistence/session-view.ts";
import type { RunId } from "../state/ids.ts";
import { type StoreSessionView, storeMessageAt } from "../state/session-judge.ts";
import type { ForkPoint } from "../state/session-payloads.ts";
import { isStatusText } from "../state/status-text.ts";
import { ForkError, type ForkRunOptions, runForkBranch } from "./fork.ts";
import type { OpenedSessionRuntime } from "./session-runtime.ts";
import { sessionsDirOf } from "./workspace.ts";

export const FORK_USAGE =
  '用法：/fork [--at <条目号> | --at <Run 号前缀>:<条目号>] ["新输入"]（缺省从最近一次 Run 的任务开始处分叉）';

export class ForkCommandError extends Error {}

export interface ForkAt {
  runPrefix?: string;
  runSeq?: number;
}

export function parseForkCommand(raw: string): { at?: ForkAt; input?: string } {
  let rest = raw.trim();
  let at: ForkAt | undefined;
  const atMatch = /^--at\s+(\S+)\s*/.exec(rest);
  if (atMatch !== null) {
    const spec = atMatch[1] ?? "";
    const colon = spec.lastIndexOf(":");
    const runPrefix = colon >= 0 ? spec.slice(0, colon) : undefined;
    const runSeq = Number(colon >= 0 ? spec.slice(colon + 1) : spec);
    if (!Number.isInteger(runSeq) || runSeq < 1 || runPrefix === "") {
      throw new ForkCommandError(`--at 需要 <条目号> 或 <Run 号前缀>:<条目号>（${FORK_USAGE}）`);
    }
    at = { ...(runPrefix !== undefined ? { runPrefix } : {}), runSeq };
    rest = rest.slice(atMatch[0].length);
  } else if (rest.startsWith("--")) {
    throw new ForkCommandError(FORK_USAGE);
  }
  let input = rest.trim();
  const quoted =
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("“") && input.endsWith("”"));
  if (input.length >= 2 && quoted) {
    input = input.slice(1, -1).trim();
  }
  return { ...(at !== undefined ? { at } : {}), ...(input !== "" ? { input } : {}) };
}

// 任务开始处：Run 里第一条人输入的用户消息（决策 363：跳过排在前面的开工状态块）；找不到时为第 1 条
function taskSeqOf(session: StoreSessionView, runId: RunId): number {
  const messages = session.runs.find((run) => run.runId === runId)?.messages ?? [];
  const index = messages.findIndex((ref) => {
    if (ref.message.role !== "user") {
      return false;
    }
    const content = ref.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((block: { type?: string; text?: string }) =>
                block.type === "text" ? (block.text ?? "") : ""
              )
              .join("")
          : "";
    return !isStatusText(text);
  });
  return index >= 0 ? index + 1 : 1;
}

// 分叉点定位：Run 顺序取会话里 Run 开始条目的先后
export function resolveForkPoint(session: StoreSessionView, at: ForkAt): ForkPoint {
  const runs: RunId[] = session.runs.map((run) => run.runId);
  let runId: RunId | undefined;
  if (at.runPrefix !== undefined) {
    const prefix = at.runPrefix;
    const matches = runs.filter((run) => run.startsWith(prefix));
    if (matches.length !== 1) {
      throw new ForkCommandError(
        matches.length === 0
          ? `本会话没有以 ${prefix} 开头的 Run`
          : `Run 号前缀 ${prefix} 不唯一（${matches.length} 个），请给更长的前缀`
      );
    }
    runId = matches[0];
  } else {
    runId = runs.at(-1);
  }
  if (runId === undefined) {
    throw new ForkCommandError("本会话还没有任何 Run，没有可分叉的位置");
  }
  const runSeq = at.runSeq ?? taskSeqOf(session, runId);
  if (storeMessageAt(session, { runId, runSeq }) === undefined) {
    throw new ForkCommandError(`该 Run 里没有第 ${runSeq} 条`);
  }
  return { runId, runSeq };
}

export async function runForkCommand(input: {
  governanceRoot: string;
  opened: OpenedSessionRuntime;
  args: string;
  run: ForkRunOptions;
}): Promise<string> {
  const { at, input: nextInput } = parseForkCommand(input.args);
  const sessionId = input.opened.bundle.adapter.sessionId;
  if (input.opened.bundle.adapter.isRunning()) {
    throw new ForkCommandError("当前 Run 还在进行中，收尾后再分叉");
  }
  // 本会话的写者先落盘，再从会话存储读
  await input.opened.bundle.sessionStore.flush();
  const loaded = loadStoreSession(sessionsDirOf(input.governanceRoot), sessionId);
  if (loaded === undefined) {
    throw new ForkError(`本会话 ${sessionId} 在会话存储里没有文件（会话存储打开失败），不能分叉`);
  }
  const forkPoint = resolveForkPoint(loaded.view, at ?? {});
  const result = await runForkBranch({
    governanceRoot: input.governanceRoot,
    sourceSessionId: sessionId,
    sourceStore: input.opened.bundle.sessionStore,
    forkPoint,
    trigger: "manual",
    // 复用运行面已挂的快照器实例：同一会话只能有一个实例，否则两边各自算序号会写同一个 ref
    ...(input.opened.checkpoints !== undefined
      ? { checkpointer: input.opened.checkpoints.checkpointer }
      : {}),
    // 决策 325：分支沿用来源会话的设置快照
    run: {
      settings: input.opened.bundle.settings,
      ...input.run,
      ...(nextInput !== undefined ? { input: nextInput } : {}),
    },
  });
  return [
    `已分叉：分叉点 ${forkPoint.runId} 第 ${forkPoint.runSeq} 条 ｜ 快照 ${result.checkpoint.commit.slice(0, 12)}`,
    `  分支会话 ${result.branchSessionId} ｜ 工作树 ${result.workspace.path}（分支 ${result.workspace.branch}）`,
    `  终态 ${result.status} ｜ 标签 ${result.label}`,
    `  进入分支：resume ${result.branchSessionId}`,
  ].join("\n");
}
