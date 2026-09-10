// 治理边界桥接：src/tools 下唯一允许 import @earendil-works/* 的文件
// （.dependency-cruiser.js 收口，M3 切片 2）。其余 tools 文件一律从这里拿上游类型的本地别名，
// 使上游类型耦合收敛到单点。
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

// AgentTool 兼容形状：name/description/parameters + execute；本仓库工具均为自建实现
export type PigeonAgentTool<TParameters extends TSchema, TDetails> = AgentTool<
  TParameters,
  TDetails
>;
export type PigeonToolResult<TDetails> = AgentToolResult<TDetails>;
