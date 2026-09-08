// 注入快照（ROADMAP M1）：Run 启动前冻结的模型/工具/权限/上下文四元组 + Memory/Skill 占位。
// 上游 pi-agent-core 在每个 Run 开始时自行拷贝 context 与 loop config（agent.js createContextSnapshot /
// createLoopConfig），Adapter 在其之上再冻结一份治理侧快照，作为重建等价 Run 的依据。
import { type Static, Type } from "typebox";

export const INJECTION_SNAPSHOT_VERSION = 1;

// M1 占坑：ToolPolicy 的判定语义在 M3 落地，此处仅冻结形状；允许为空集。
export const ToolPolicySchema = Type.Object({
  // 允许执行的工具名清单；空数组 = 不允许任何工具
  allow: Type.Array(Type.String()),
  // 显式禁止的工具名清单
  deny: Type.Array(Type.String()),
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
    // 计划广告给模型的工具名清单；M1 无工具执行，恒为空数组
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
