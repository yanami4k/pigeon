// 固化 grant 规则 schema（M4 S6，D6；决策 325 起为 settings.json 的 permissions 一节，三层并集生效）。
// 规则的稳定身份是 promotedFrom.grantId（M4 收口决策 ①）；匹配语义在 tools/grants.ts，
// 写入（/grants save 与 /revoke，只写项目个人一层）在 persistence/grants-config.ts，会话 grant 运行态在 approvals/grant-store.ts。
// M5.5 S5（决策 048）：exec 档规则带 command（精确命令串），加法式字段，版本不变。
import { type Static, Type } from "typebox";
import { type GrantId, GrantIdSchema, SessionIdSchema } from "./ids.ts";

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
  // exec 档：只放行这条一模一样的命令串
  command: Type.Optional(Type.String({ minLength: 1 })),
  // 048 修订：经 shell 运行这条命令已由人确认（缺省 = false，旧规则不能免审需 shell 的命令）
  shell: Type.Optional(Type.Boolean()),
  // 决策 290：网络档（web_fetch）按网站放权——只放行网址主机名与之一模一样（不区分大小写）的调用
  host: Type.Optional(Type.String({ minLength: 1 })),
  promotedFrom: PromotedFromSchema,
});
export type ConfigGrantRule = Static<typeof ConfigGrantRuleSchema>;

// 决策 412：读档禁读名单已撤掉，permissions.readDeny 不再生效。旧设置里写了的照常通过校验、加载，不读取其内容；
// 写法沿用当时的约束（~ 开头或绝对路径）
export const ReadDenyEntrySchema = Type.String({
  minLength: 1,
  pattern: "^(~([/\\\\].*)?|/.*|[A-Za-z]:[/\\\\].*|\\\\\\\\.*)$",
});

export const PermissionsSectionSchema = Type.Object(
  {
    grants: Type.Optional(Type.Array(ConfigGrantRuleSchema)),
    readDeny: Type.Optional(Type.Array(ReadDenyEntrySchema)),
  },
  { additionalProperties: false }
);
export type PermissionsSection = Static<typeof PermissionsSectionSchema>;

// 会话里生效中的授权（建立减撤销）：续跑时由会话存储的授权条目还原，作为会话 grant 运行态的冷恢复种子（决策 3b）
export interface ActiveGrant {
  grantId: GrantId;
  tool: string;
  pathPrefix?: string;
  // 决策 048：exec 档精确命令串
  command?: string;
  // 048 修订：经 shell 已由人确认
  shell?: boolean;
  // 决策 290：按网站放权的主机名
  host?: string;
  createdAt: number;
  firstCall: { toolCallId: string; args: unknown };
}
