// 注入快照（ROADMAP M1）：Run 启动前冻结的模型/工具/权限/上下文四元组 + Memory/Skill 冻结清单。
// 上游 pi-agent-core 在每个 Run 开始时自行拷贝 context 与 loop config（agent.js createContextSnapshot /
// createLoopConfig），Adapter 在其之上再冻结一份治理侧快照，作为重建等价 Run 的依据。
import { type Static, Type } from "typebox";
import {
  MemoryManifestEntrySchema,
  SkillManifestEntrySchema,
} from "../state/injection-manifest.ts";
import type { Migration } from "../state/migration.ts";
import { ThinkingLevelSchema } from "../state/runtime-events.ts";
import { ApprovalModeSchema } from "../tools/policy.ts";

// v2：ToolPolicy 增加 approvalMode（M3 决策 4，yolo = 人事先批发授权）
// v3（M5 S3，决策 042 / 043）：memory 与 skills 由占位数组收紧为结构化冻结清单
// v4（M5.5 S5，决策 050）：model 段增加推理档位 thinkingLevel（缺省 = off，不请求推理）
// v5（决策 063）：model 段增加单轮输出上限 maxOutputTokens（事后可证每次运行用的上限）
export const INJECTION_SNAPSHOT_VERSION = 5;

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
    // 推理档位（决策 050）：两级来源——启动参数全局值，worker 角色配置覆盖；缺省 off
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
    // 单轮输出上限（决策 063）：装配层包装 streamFn 传入的 maxTokens 配置值；v4 之前的快照缺省
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  tools: Type.Object({
    policy: ToolPolicySchema,
    // 计划广告给模型的工具名清单；实际广告集由 Adapter 按 执行体 ∩ allow ∩ 已注册 决定（M3 起）
    advertised: Type.Array(Type.String()),
  }),
  context: Type.Object({
    // 会话开始时拼好的完整 system prompt（基础提示 + 常驻 Memory 段 + Skill 目录段），冻结后不再变
    systemPrompt: Type.String(),
  }),
  // 常驻 Memory 冻结清单（决策 042）：注入走 system prompt 追加段，不走 transformContext；
  // transformContext 只做只读观察（llm.request），并留给 M10 外部 Provider 的逐调用动态召回
  memory: Type.Array(MemoryManifestEntrySchema),
  // Skill Catalog 冻结清单（决策 043）：每个 Skill 目录下全部文件的哈希清单，load_skill 读取时比对
  skills: Type.Array(SkillManifestEntrySchema),
  // Unix 毫秒时间戳
  createdAt: Type.Integer({ minimum: 0 }),
});

export type InjectionSnapshot = Static<typeof InjectionSnapshotSchema>;

// v1 → v2：ToolPolicy 补 approvalMode，默认 "prompt"（yolo 必须显式选择，见 M3 决策 4）。
// 迁移管线（src/state/migration.ts）是通用设施、尚无集中注册表（events/receipt/candidate 均未注册），
// 故此处只导出迁移函数，由快照冷加载方按名 "injection-snapshot" 注册使用。
// 每个迁移函数只升一级，输出版本写死（不引用当前版本常量，否则常量推进后本级会跳级）
export const migrateInjectionSnapshotV1toV2: Migration = (doc) => {
  const { tools, ...rest } = doc;
  const { policy, ...toolsRest } = tools as { policy: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  return {
    ...rest,
    version: 2,
    tools: { ...toolsRest, policy: { ...policy, approvalMode: "prompt" } },
  };
};

// v2 → v3：memory / skills 由 Type.Unknown 占位数组收紧为结构化清单，版本推进不改内容——
// 旧快照的空数组照过；非空的非结构化占位在目标 schema 校验时被拒绝（不猜着把它们转成清单）
export const migrateInjectionSnapshotV2toV3: Migration = (doc) => ({ ...doc, version: 3 });

// v3 → v4：thinkingLevel 可缺省（缺省 = off），纯版本推进
export const migrateInjectionSnapshotV3toV4: Migration = (doc) => ({ ...doc, version: 4 });

// v4 → v5：maxOutputTokens 可缺省，纯版本推进
export const migrateInjectionSnapshotV4toV5: Migration = (doc) => ({ ...doc, version: 5 });
