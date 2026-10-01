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
  StructuredMemoryManifestSchema,
} from "../state/injection-manifest.ts";
import { PushedMemoryLayersSchema } from "../state/learned-memory.ts";
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
// v12（决策 134 / 157 / 159）：顶层增加结构化记忆的开局留痕 structuredMemory（开关、挑选方式、开局给了哪几条；
// 段落本身已拼进 systemPrompt），verify 增可选命名分步——均可缺省
// v13（决策 191、192、207）：顶层增加推送的记忆 learnedMemory（开局冻结的 MEMORY.md 身份，段落本身已拼进 systemPrompt）
// 与复盘标记 memoryReview（复盘会话的种类与模板版本；不叫 review，免得与 v11 删掉的旧审阅字段同名，旧快照照常可读）——均可缺省
// v14（决策 331、332）：删除复盘标记 memoryReview（复盘随之删除）；推送的记忆由单层的 learnedMemory 改为两层的 pushedMemory
// （各层身份与记忆文字的版本）。会话记录里旧 Run 开始条目的两个旧字段照常可读，见 session-entries.ts
export const INJECTION_SNAPSHOT_VERSION = 14;

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
  // transformContext 留给 M10 外部 Provider 的逐调用动态召回
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
  // 结构化记忆的开局留痕（决策 134 / 157）：决策 174 删除结构化记忆后已停写，只为旧会话与 v12 快照照常可读而保留
  structuredMemory: Type.Optional(StructuredMemoryManifestSchema),
  // 推送的记忆（决策 332）：推送开着时在场，记开局冻结的两层记忆的身份、上限与记忆文字的版本
  pushedMemory: Type.Optional(PushedMemoryLayersSchema),
});

export type InjectionSnapshot = Static<typeof InjectionSnapshotSchema>;
