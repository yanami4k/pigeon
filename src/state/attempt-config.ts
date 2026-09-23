// 尝试级配置（M7，决策 071 / 079；M8，决策 081 / 087）：会话级验证命令、失败自动分叉重试次数与本次尝试的预算。
// 三者在会话开始时冻结进注入快照，随 run.started 落盘，事后可证每次尝试用的是哪条验证命令、允许重试几次、
// 拿的是多大预算。Eval 沿用 task.json 的验证器，不走验证命令这条路。
// 本模块只放 schema；项目级配置文件的读取在 persistence/verify-config.ts，来源优先级在 application/launch-flags.ts。
import { type Static, Type } from "typebox";

// 验证命令的来源（决策 081）：启动参数压过项目级配置文件；两者都没有即未配置（标签现算为未知）
export const VerifyConfigSourceSchema = Type.Union([Type.Literal("flag"), Type.Literal("project")]);
export type VerifyConfigSource = Static<typeof VerifyConfigSourceSchema>;

// 验证的一个命名分步（决策 159）：步名与一行命令（经系统 shell 执行）
export const VerifyStepSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  command: Type.String({ minLength: 1, maxLength: 4000 }),
  // 在哪个目录下执行（相对工作区根、正斜杠，不得越出工作区；加法式可缺省，缺省即工作区根）。
  // 工具报出的相对路径据此换算成相对工作区根的路径
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
});
export type VerifyStep = Static<typeof VerifyStepSchema>;

// 验证命令：人配置的一行命令（经系统 shell 执行），带超时。
// M8（决策 081）：加法式新增来源字段——M7 写下的旧快照没有该字段，读取时不补、不猜。
// 决策 159：加法式新增命名分步——在场时各步全跑、各出结论，command 只是各步的展示串（不再整条执行），
// 超时按每步各自计时；缺省即单条命令的旧配置，视为只有一步
export const VerifyConfigSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  timeoutMs: Type.Integer({ minimum: 1 }),
  source: Type.Optional(VerifyConfigSourceSchema),
  steps: Type.Optional(Type.Array(VerifyStepSchema, { minItems: 1 })),
});
export type VerifyConfig = Static<typeof VerifyConfigSchema>;

// 失败自动分叉重试次数：0 为关闭（缺省）
export const RetryOnFailSchema = Type.Integer({ minimum: 0 });

// 回炉轮数（决策 142 / 143）：验证不过就在同一会话里接着修，最多修这么多轮。只在开启时冻结（至少 1）；
// 缺省即关闭，快照与 run.started 都不带
export const RepairRoundsSchema = Type.Integer({ minimum: 1 });

// 本次尝试的预算（M8，决策 087）：回放必须沿用被验证那次尝试的预算，不得放宽——预算因此必须在账本里可得。
// 四项均可缺省：缺省即"该项不设限"，回放沿用同样的不设限，不是放宽。
// maxOutputTokens 与模型标识一起记在 run.started 的 model 段，不重复进本块。
export const AttemptBudgetSchema = Type.Object({
  maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  wallClockMs: Type.Optional(Type.Integer({ minimum: 1 })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type AttemptBudget = Static<typeof AttemptBudgetSchema>;

// .pigeon/verify.json（M8 S1，决策 081）：验证命令的项目级配置——人配一次，本项目所有会话继承。
// 写入方只有人（手工编辑），读取在 persistence/verify-config.ts；超时缺省由 application 层补齐
export const VERIFY_CONFIG_VERSION = 1;

// 决策 159：command 与 steps 二选一（读取时校验）；steps 加法式可缺省，v1 旧文件逐字有效，不升版本
export const VerifyConfigFileSchema = Type.Object({
  version: Type.Literal(VERIFY_CONFIG_VERSION),
  command: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  steps: Type.Optional(Type.Array(VerifyStepSchema, { minItems: 1, maxItems: 20 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  // 回炉轮数（决策 142 / 143）：启动参数优先；缺省 0 即关闭。加法式可缺省，v1 旧文件逐字有效，不升版本
  repairRounds: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type VerifyConfigFile = Static<typeof VerifyConfigFileSchema>;
