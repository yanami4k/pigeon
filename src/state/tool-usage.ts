// 工具结果里的模型用量（决策 289）：有的工具在执行中另发模型请求（web_fetch 的提炼、web_search 经模型服务端搜索），
// 这些请求不是本会话的一轮，不产生助手消息，用量写在该工具结果消息 details 的 modelUsage 键下，与工具自己的其余
// details 并列；会话用量与花费的汇总把它一并计入。不新增记录种类（与运行面标记同一做法）。

import { Value } from "typebox/value";
import { type TurnUsage, TurnUsageSchema } from "./runtime-events.ts";

export const TOOL_RESULT_USAGE_KEY = "modelUsage";

// 从工具结果消息的 details 里取模型用量；没有或形状不对返回 undefined
export function toolResultModelUsage(details: unknown): TurnUsage | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return undefined;
  }
  const usage = (details as Record<string, unknown>)[TOOL_RESULT_USAGE_KEY];
  return Value.Check(TurnUsageSchema, usage) ? usage : undefined;
}

// 把一份用量累加到另一份上（就地修改 target）
export function addTurnUsage(target: TurnUsage, extra: TurnUsage): void {
  target.input += extra.input;
  target.output += extra.output;
  target.cacheRead += extra.cacheRead;
  target.cacheWrite += extra.cacheWrite;
  target.totalTokens += extra.totalTokens;
  target.cost.input += extra.cost.input;
  target.cost.output += extra.cost.output;
  target.cost.cacheRead += extra.cost.cacheRead;
  target.cost.cacheWrite += extra.cost.cacheWrite;
  target.cost.total += extra.cost.total;
}
