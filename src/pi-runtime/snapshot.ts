// 注入快照（ROADMAP M1）：Run 启动前冻结的模型/工具/权限/上下文四元组 + Memory/Skill 占位。
// 上游 pi-agent-core 在每个 Run 开始时自行拷贝 context 与 loop config（agent.js createContextSnapshot /
// createLoopConfig），Adapter 在其之上再冻结一份治理侧快照，作为重建等价 Run 的依据。
import { type Static, Type } from "typebox";
import type { Migration } from "../state/migration.ts";
import { ApprovalModeSchema } from "../tools/policy.ts";

// v2：ToolPolicy 增加 approvalMode（M3 决策 4，yolo = 人事先批发授权）
export const INJECTION_SNAPSHOT_VERSION = 2;

// 逐调用判定语义在 src/tools/policy.ts；此处冻结形状。allow 约束广告给模型的工具集，
// deny 清单绝对（任何模式精确匹配即拒）；approvalMode 决定非 deny 工具走人工批准还是批发授权。
export const ToolPolicySchema = Type.Object({
  // 允许广告给模型的工具名清单；空数组 = 不广告任何工具
  allow: Type.Array(Type.String()),
  // 显式禁止的工具名清单；绝对，yolo 不豁免
  deny: Type.Array(Type.String()),
  // 审批模式：prompt 逐次问人 / yolo 事先批发授权（账本 approvedBy 记 policy:yolo）
  approvalMode: ApprovalModeSchema,
});
export type ToolPolicy = Static<typeof ToolPolicySchema>;

export const InjectionSnapshotSchema = Type.Object({
  version: Type.Literal(INJECTION_SNAPSHOT_VERSION),
  model: Type.Object({
    provider: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }),
  }),
  tools: Type.Object({
    policy: ToolPolicySchema,
    // 计划广告给模型的工具名清单；实际广告集由 Adapter 按 执行体 ∩ allow ∩ 已注册 决定（M3 起）
    advertised: Type.Array(Type.String()),
  }),
  context: Type.Object({
    systemPrompt: Type.String(),
  }),
  // M1 占坑：Memory 注入在 M5（transformContext）落地，此处允许为空
  memory: Type.Array(Type.Unknown()),
  // M1 占坑：Skill 注入同上
  skills: Type.Array(Type.Unknown()),
  // Unix 毫秒时间戳
  createdAt: Type.Integer({ minimum: 0 }),
});

export type InjectionSnapshot = Static<typeof InjectionSnapshotSchema>;

// v1 → v2：ToolPolicy 补 approvalMode，默认 "prompt"（yolo 必须显式选择，见 M3 决策 4）。
// 迁移管线（src/state/migration.ts）是通用设施、尚无集中注册表（events/receipt/candidate 均未注册），
// 故此处只导出迁移函数，由快照冷加载方按名 "injection-snapshot" 注册使用。
export const migrateInjectionSnapshotV1toV2: Migration = (doc) => {
  const { tools, ...rest } = doc;
  const { policy, ...toolsRest } = tools as { policy: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  return {
    ...rest,
    version: INJECTION_SNAPSHOT_VERSION,
    tools: { ...toolsRest, policy: { ...policy, approvalMode: "prompt" } },
  };
};
