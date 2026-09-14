// MCP 工具集摘要（M5.7 S3，决策 052）：run.started 里每个 MCP 工具带 server 注解线索（declaredHint）、配置档位与
// 实际采用的风险档（effectiveTier），不一致的标 conflict；server 状态（含掉线、清单变更通知）一并记下，冷侧可查。
// 更严执行规则写死：声明只读但配置 write / exec，按配置；声明 destructive 但配置 read，按 write。
import { type Static, Type } from "typebox";
import { type McpToolTier, McpToolTierSchema } from "./mcp-config.ts";

// server 注解里的四个行为线索（MCP 协议明文注解不可作安全依据，只当线索）
export const McpDeclaredHintSchema = Type.Object({
  readOnlyHint: Type.Optional(Type.Boolean()),
  destructiveHint: Type.Optional(Type.Boolean()),
  idempotentHint: Type.Optional(Type.Boolean()),
  openWorldHint: Type.Optional(Type.Boolean()),
});
export type McpDeclaredHint = Static<typeof McpDeclaredHintSchema>;

export const McpToolsetEntrySchema = Type.Object({
  // 注册表与模型可见的工具名
  name: Type.String({ minLength: 1 }),
  server: Type.String({ minLength: 1 }),
  // server 侧工具名
  tool: Type.String({ minLength: 1 }),
  configuredTier: McpToolTierSchema,
  effectiveTier: McpToolTierSchema,
  declaredHint: Type.Optional(McpDeclaredHintSchema),
  // 只在冲突时出现
  conflict: Type.Optional(Type.Literal(true)),
});
export type McpToolsetEntry = Static<typeof McpToolsetEntrySchema>;

export const McpServerStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("connected"),
  Type.Literal("restarting"),
  Type.Literal("unavailable"),
  Type.Literal("closed"),
]);

export const McpServerStatusSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  state: McpServerStateSchema,
  // 本会话内已重启次数
  restarts: Type.Integer({ minimum: 0 }),
  // 非连接状态时的最近错误
  error: Type.Optional(Type.String()),
  // 收到的清单变更通知（只记录，本会话工具集不变）
  listChanges: Type.Optional(
    Type.Array(
      Type.Object({
        list: Type.Union([Type.Literal("tools"), Type.Literal("prompts")]),
        at: Type.Integer({ minimum: 0 }),
      })
    )
  ),
});
export type McpServerStatus = Static<typeof McpServerStatusSchema>;

export function effectiveMcpTier(
  configuredTier: McpToolTier,
  declaredHint?: McpDeclaredHint
): { effectiveTier: McpToolTier; conflict: boolean } {
  if (declaredHint?.destructiveHint === true && configuredTier === "read") {
    return { effectiveTier: "write", conflict: true };
  }
  if (declaredHint?.readOnlyHint === true && configuredTier !== "read") {
    return { effectiveTier: configuredTier, conflict: true };
  }
  return { effectiveTier: configuredTier, conflict: false };
}
