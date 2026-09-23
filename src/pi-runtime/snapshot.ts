// 注入快照（ROADMAP M1）：Run 启动前冻结的模型/工具/权限/上下文四元组 + Memory/Skill 冻结清单。
// 上游 pi-agent-core 在每个 Run 开始时自行拷贝 context 与 loop config（agent.js createContextSnapshot /
// createLoopConfig），Adapter 在其之上再冻结一份治理侧快照，作为重建等价 Run 的依据。
import { type Static, Type } from "typebox";
import {
  AttemptBudgetSchema,
  RepairRoundsSchema,
  RetryOnFailSchema,
  VerifyConfigSchema,
} from "../state/attempt-config.ts";
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
// v6（M6，决策 064）：顶层增加审阅配置 review（开关与轮次间隔，会话开始时冻结）
// v7（M7，决策 071 / 079）：顶层增加验证命令配置 verify 与失败自动分叉重试次数 retryOnFail（按会话冻结）
// v8（M8，决策 081 / 087）：顶层增加本次尝试的预算 budget（轮次、墙钟与 token 上限），verify 增来源字段——
// 回放必须沿用被验证那次尝试的预算且不得放宽，预算因此必须在账本里可得（M7 之前只有 worker 尝试的派出记录有）
// v9（M9）：model 段增加采样温度 temperature（评测固定采样；缺省 = 未设，由 provider 决定）与"请求了但未生效"的
// temperatureIgnored（推理开启时上游不把温度交给 provider），context 段增加任务源给的工作方式指令 taskDirective（原文，
// 已拼进 systemPrompt；单列是为了回放与冻结项核对能取到原文）。v9 尚未入库，三个字段一次加齐、均可缺省
// v10（决策 142 / 143）：顶层增加回炉轮数 repairRounds（只在开启时在场；按会话冻结）
// v11（决策 137）：删除 v6 引入的顶层审阅配置 review（第一版学习闭环退役）。对象非严格，
// 旧快照里的该字段读取时忽略；版本推进只为让版本号对应形状
export const INJECTION_SNAPSHOT_VERSION = 11;

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
    // 采样温度（M9）：装配层包装 streamFn 传入；缺省 = 未设。v8 之前的快照缺省
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    // 请求了温度但未生效（推理开启）：如实记下请求值与原因，不记成 temperature
    temperatureIgnored: Type.Optional(
      Type.Object({
        requested: Type.Number({ minimum: 0, maximum: 2 }),
        reason: Type.Literal("reasoning-enabled"),
      })
    ),
  }),
  tools: Type.Object({
    policy: ToolPolicySchema,
    // 计划广告给模型的工具名清单；实际广告集由 Adapter 按 执行体 ∩ allow ∩ 已注册 决定（M3 起）
    advertised: Type.Array(Type.String()),
  }),
  context: Type.Object({
    // 会话开始时拼好的完整 system prompt（基础提示 + 常驻 Memory 段 + Skill 目录段），冻结后不再变
    systemPrompt: Type.String(),
    // 任务源给的工作方式指令原文（已追加在 systemPrompt 末尾；缺省 = 没有）
    taskDirective: Type.Optional(Type.String({ minLength: 1 })),
  }),
  // 常驻 Memory 冻结清单（决策 042）：注入走 system prompt 追加段，不走 transformContext；
  // transformContext 只做只读观察（llm.request），并留给 M10 外部 Provider 的逐调用动态召回
  memory: Type.Array(MemoryManifestEntrySchema),
  // Skill Catalog 冻结清单（决策 043）：每个 Skill 目录下全部文件的哈希清单，load_skill 读取时比对
  skills: Type.Array(SkillManifestEntrySchema),
  // Unix 毫秒时间戳
  createdAt: Type.Integer({ minimum: 0 }),
  // 决策 137：后台审阅配置字段（v6 引入）在 v11 删除。本对象非严格（未设 additionalProperties: false），
  // 旧快照里的 review 字段读取时忽略
  // 会话级验证命令（M7，决策 071）：尝试收尾后由程序在工作区独立执行；未配置缺省（标签为未知）
  verify: Type.Optional(VerifyConfigSchema),
  // 失败自动分叉重试次数（M7，决策 079）：缺省即 0（关闭）
  retryOnFail: Type.Optional(RetryOnFailSchema),
  // 本次尝试的预算（M8，决策 087）：回放沿用它，不得放宽；各项缺省即该项不设限
  budget: Type.Optional(AttemptBudgetSchema),
  // 回炉轮数（决策 142 / 143）：只在开启时在场；缺省即关闭
  repairRounds: Type.Optional(RepairRoundsSchema),
});

export type InjectionSnapshot = Static<typeof InjectionSnapshotSchema>;

// v1 → v2：ToolPolicy 补 approvalMode，默认 "prompt"（yolo 必须显式选择，见 M3 决策 4）。
// 迁移管线（src/state/migration.ts）是通用设施，各 schema 各自持有注册表；快照没有常驻注册表，
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

// v5 → v6：review 可缺省，纯版本推进
export const migrateInjectionSnapshotV5toV6: Migration = (doc) => ({ ...doc, version: 6 });

// v6 → v7：verify 与 retryOnFail 可缺省，纯版本推进
export const migrateInjectionSnapshotV6toV7: Migration = (doc) => ({ ...doc, version: 7 });

// v7 → v8：budget 与 verify.source 均可缺省，纯版本推进——v7 旧快照逐字有效（缺预算 = 当时没记，不补不猜）
export const migrateInjectionSnapshotV7toV8: Migration = (doc) => ({ ...doc, version: 8 });

// v8 → v9：temperature 可缺省（缺省 = 当时没设），纯版本推进
export const migrateInjectionSnapshotV8toV9: Migration = (doc) => ({ ...doc, version: 9 });

// v9 → v10：repairRounds 可缺省（缺省 = 回炉关闭），纯版本推进
export const migrateInjectionSnapshotV9toV10: Migration = (doc) => ({ ...doc, version: 10 });

// v10 → v11：审阅配置字段从 schema 删除，旧快照里的该字段原样留着、读取时忽略（不改写、不猜），纯版本推进
export const migrateInjectionSnapshotV10toV11: Migration = (doc) => ({ ...doc, version: 11 });
