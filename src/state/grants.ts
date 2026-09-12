// 固化 grant 规则 schema（M4 S6，D6：项目级 .pigeon/grants.json，JSON + 版本化 typebox schema）。
// 规则的稳定身份是 promotedFrom.grantId（M4 收口决策 ①）；匹配语义在 tools/grants.ts，
// 文件读写在 persistence/grants-config.ts，会话 grant 运行态在 approvals/grant-store.ts。
import { type Static, Type } from "typebox";
import { GrantIdSchema, SessionIdSchema } from "./ids.ts";

export const GRANTS_CONFIG_VERSION = 1;

// 升格出处（promotedFrom）：哪次会话、哪次动作、首次批准的调用——团队共享工具权限
// 是未来的显式决策，本设计先把每条固化规则的出处结构化留证
export const PromotedFromSchema = Type.Object({
  grantId: GrantIdSchema,
  sessionId: SessionIdSchema,
  firstCall: Type.Object({
    toolCallId: Type.String({ minLength: 1 }),
    args: Type.Unknown(),
  }),
  promotedAt: Type.Integer({ minimum: 0 }),
});
export type PromotedFrom = Static<typeof PromotedFromSchema>;

export const ConfigGrantRuleSchema = Type.Object({
  tool: Type.String({ minLength: 1 }),
  pathPrefix: Type.Optional(Type.String({ minLength: 1 })),
  promotedFrom: PromotedFromSchema,
});
export type ConfigGrantRule = Static<typeof ConfigGrantRuleSchema>;

export const GrantsConfigFileSchema = Type.Object({
  version: Type.Literal(GRANTS_CONFIG_VERSION),
  grants: Type.Array(ConfigGrantRuleSchema),
});
