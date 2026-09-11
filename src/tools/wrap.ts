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

// 可选能力：执行前预览（无副作用），审批闸用它给人工审批展示 diff（M3 切片 3/4）。
// 结构检查（"preview" in tool），不要求工具必实现。
export interface PreviewableTool {
  preview(params: unknown): Promise<string>;
}

// 副作用内容证据（M4 S2 哈希自动确证，D5）：dispatch 准备期由写工具零副作用算出的
// 改前/预期改后内容哈希（snapshotTag 格式），随 intent 落盘，供冷恢复三方比对
export interface ContentEvidence {
  // 工作区相对路径（模型参数原样）
  path: string;
  beforeHash: string;
  expectedAfterHash: string;
}

// 可选能力：内容证据探针。结构检查（"probeContentEvidence" in tool），不要求工具必实现；
// 探针/实测失败返回 null（不抛），治理层凭字段缺省把悬账降级为人工对账
export interface ContentEvidenceTool {
  // dispatch 前：零副作用算出改前/预期改后哈希（与 execute 共享同一预检路径）
  probeContentEvidence(params: unknown): Promise<ContentEvidence | null>;
  // 执行后：实测目标现状内容哈希（receipt 的 contentAfterHash 证据）
  hashContentTarget(params: unknown): string | null;
}
