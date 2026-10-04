// 命令输出虚拟路径的可读来源（决策 356）：分支会话复制来的历史里的 pigeon://outputs/<会话号>/<编号> 指向来源会话的输出，
// 所以本会话之外还认分叉来源一路往上的会话。来源取自会话存储的文件头（分支来历的来源会话，没有即父会话），新开的分支与
// 续接的分支会话同一口径；worker 会话不算（它的输出编号对派出方明确报错，worker 自己也不读派出方的输出）。
import { loadSessionView } from "../persistence/session-catalog.ts";

const MAX_DEPTH = 20;

// 本会话的分叉来源一路往上的会话号：沿文件头往上，遇到 worker 会话或读不到即停，至多 20 层。
// 本会话的文件还没写出时（刚开的分支）用调用方给的来源
export function outputAncestors(
  sessionsDir: string,
  sessionId: string,
  fallbackSource?: string
): string[] {
  const own = loadSessionView(sessionsDir, sessionId);
  const chain: string[] = [];
  let current = own !== undefined ? sourceOf(own) : fallbackSource;
  while (
    current !== undefined &&
    current !== sessionId &&
    chain.length < MAX_DEPTH &&
    !chain.includes(current)
  ) {
    chain.push(current);
    const view = loadSessionView(sessionsDir, current);
    current = view !== undefined ? sourceOf(view) : undefined;
  }
  return chain;
}

function sourceOf(view: NonNullable<ReturnType<typeof loadSessionView>>): string | undefined {
  if (view.worker !== undefined) return undefined;
  return view.branch?.sourceSessionId ?? view.parentSessionId;
}
