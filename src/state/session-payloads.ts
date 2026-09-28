// 会话事实的载荷形状（决策 177 / 184）：worker 编排、分叉、授权与验证各写入点交给新会话存储的输入，以及它们共用的
// 子结构（角色、工作区、委派策略、上限、分叉点、快照引用）。纯类型、无 IO；写成哪种自定义条目或文件头见 session-entries.ts。
import { type Static, Type } from "typebox";
import { Sha256HexSchema } from "./hashing.ts";
import { GrantIdSchema, RunIdSchema, SessionIdSchema } from "./ids.ts";
import { EvalVerdictSchema } from "./runtime-events.ts";
import { VerifyStepResultSchema } from "./verify-steps.ts";

// worker 角色（M5.5 S2，决策 040；M8 决策 082 加验证器）。
// 决策 137 / 158：reviewer、distiller、verifier 已停用、不再派出；取值保留，项目命令配置里仍记着它们，删值会使其读不出。
// 可派出的角色见 orchestration/roles.ts
export const WorkerRoleSchema = Type.Union([
  Type.Literal("reviewer"),
  Type.Literal("explorer"),
  Type.Literal("implementer"),
  Type.Literal("tester"),
  Type.Literal("distiller"),
  Type.Literal("verifier"),
]);
export type WorkerRole = Static<typeof WorkerRoleSchema>;

// 隔离工作区：git 工作树（M5.5；M8 决策 082 加可选起点提交）与"无工作区"（M6，决策 064）。
// 决策 137 之后不再产生无工作区（只读角色已退役），该成员保留在联合里使形状不变
export const GitWorktreeWorkspaceSchema = Type.Object({
  kind: Type.Literal("git-worktree"),
  baseCommit: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" })),
  path: Type.String({ minLength: 1 }),
  branch: Type.String({ minLength: 1 }),
});
export const NoWorkspaceSchema = Type.Object({ kind: Type.Literal("none") });
export const WorkerWorkspaceSchema = Type.Union([GitWorktreeWorkspaceSchema, NoWorkspaceSchema]);
export type WorkerWorkspace = Static<typeof WorkerWorkspaceSchema>;
export type GitWorktreeWorkspace = Static<typeof GitWorktreeWorkspaceSchema>;

// 类型谓词：只有 git 工作树形状才有路径与分支（无工作区的 worker 两者皆无）
export function isGitWorktreeWorkspace(
  workspace: WorkerWorkspace
): workspace is GitWorktreeWorkspace {
  return workspace.kind === "git-worktree";
}

// 委派策略摘要：与 InjectionSnapshot.tools.policy 同形（state 是叶子层，不引 tools 的 schema）
export const DelegatedPolicySchema = Type.Object({
  allow: Type.Array(Type.String({ minLength: 1 })),
  deny: Type.Array(Type.String({ minLength: 1 })),
  approvalMode: Type.Union([Type.Literal("prompt"), Type.Literal("yolo")]),
});
export type DelegatedPolicy = Static<typeof DelegatedPolicySchema>;

// 轮次与墙钟两个上限，另有可选的累计 token 上限（缺省不限）
export const WorkerLimitsSchema = Type.Object({
  maxTurns: Type.Integer({ minimum: 1 }),
  wallClockMs: Type.Integer({ minimum: 1 }),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type WorkerLimits = Static<typeof WorkerLimitsSchema>;

export const ChildSettledStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("aborted"),
  Type.Literal("cancelled"),
  Type.Literal("turn-limit"),
  Type.Literal("wall-clock-limit"),
  Type.Literal("token-limit"),
  // 派出失败（工作树或运行面建不起来）：以收尾收口保证派出与收尾配对
  Type.Literal("spawn-failed"),
]);
export type ChildSettledStatus = Static<typeof ChildSettledStatusSchema>;

// worker 结构化结果：分支、改动文件清单（工作树内相对路径）、自述摘要；无工作区的 worker 没有分支与改动文件。
// structured 承载模型交回的结构化内容（编排器收尾时取运行面的结构化结果），生产代码暂无读取方，不写进会话存储
export const ChildResultSchema = Type.Object({
  branch: Type.Optional(Type.String({ minLength: 1 })),
  changedFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  summary: Type.String(),
  summaryTruncated: Type.Boolean(),
  structured: Type.Optional(Type.Unknown()),
});
export type ChildResult = Static<typeof ChildResultSchema>;

// 分叉点：来源会话里某次 Run 的条目号（含该条，之后的消息不进分支）
export const ForkPointSchema = Type.Object({
  runId: RunIdSchema,
  runSeq: Type.Integer({ minimum: 1 }),
});
export type ForkPoint = Static<typeof ForkPointSchema>;

// 分叉点快照引用：分叉点之前最近的快照提交与其 ref
export const CheckpointRefSchema = Type.Object({
  ref: Type.String({ minLength: 1 }),
  commit: Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }),
});
export type CheckpointRef = Static<typeof CheckpointRefSchema>;

export const ForkTriggerSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("retry-on-fail"),
]);
export type ForkTrigger = Static<typeof ForkTriggerSchema>;

// ---- 写入点交给会话存储的输入（runId 可缺省：人以命令派出或授权时没有活动 Run） ----

const OptionalRunId = { runId: Type.Optional(RunIdSchema) } as const;

// 授权建立（M4 S6，决策 3）：firstCall 记录触发创建的那次调用
export const GrantCreatedInputSchema = Type.Object({
  ...OptionalRunId,
  grantId: GrantIdSchema,
  tool: Type.String({ minLength: 1 }),
  // 决策 3a 目录限定：工作区相对目录；缺省 = 工具级（不限路径）
  pathPrefix: Type.Optional(Type.String({ minLength: 1 })),
  // 决策 048：exec 档精确命令串——只放行这条一模一样的命令
  command: Type.Optional(Type.String({ minLength: 1 })),
  shell: Type.Optional(Type.Boolean()),
  createdAt: Type.Integer({ minimum: 0 }),
  firstCall: Type.Object({
    toolCallId: Type.String({ minLength: 1 }),
    args: Type.Unknown(),
  }),
});
export type GrantCreatedInput = Static<typeof GrantCreatedInputSchema>;

export const GrantRevokedInputSchema = Type.Object({
  ...OptionalRunId,
  grantId: GrantIdSchema,
  revokedAt: Type.Integer({ minimum: 0 }),
});
export type GrantRevokedInput = Static<typeof GrantRevokedInputSchema>;

// worker 会话的来历（写进 worker 会话文件头）
export const SessionHeaderInputSchema = Type.Object({
  ...OptionalRunId,
  parentSessionId: SessionIdSchema,
  parentRunId: Type.Optional(RunIdSchema),
  worker: Type.Object({ name: Type.String({ minLength: 1 }), role: WorkerRoleSchema }),
  workspace: WorkerWorkspaceSchema,
  startedAt: Type.Integer({ minimum: 0 }),
});
export type SessionHeaderInput = Static<typeof SessionHeaderInputSchema>;

export const ChildSpawnedInputSchema = Type.Object({
  ...OptionalRunId,
  childSessionId: SessionIdSchema,
  name: Type.String({ minLength: 1 }),
  role: WorkerRoleSchema,
  task: Type.String({ minLength: 1 }),
  // M7（决策 069）：并行派发同一任务的多个 worker 共享的任务标识；单派缺省
  taskKey: Type.Optional(Type.String({ minLength: 1 })),
  policy: DelegatedPolicySchema,
  limits: WorkerLimitsSchema,
  workspace: WorkerWorkspaceSchema,
  spawnedAt: Type.Integer({ minimum: 0 }),
});
export type ChildSpawnedInput = Static<typeof ChildSpawnedInputSchema>;

export const ChildSettledInputSchema = Type.Object({
  ...OptionalRunId,
  childSessionId: SessionIdSchema,
  name: Type.String({ minLength: 1 }),
  status: ChildSettledStatusSchema,
  // 失败、派出失败时的人读原因
  error: Type.Optional(Type.String()),
  // 派出失败时缺省（没有可回收的工作）
  result: Type.Optional(ChildResultSchema),
  // 完成的模型轮次数
  turns: Type.Integer({ minimum: 0 }),
  settledAt: Type.Integer({ minimum: 0 }),
});
export type ChildSettledInput = Static<typeof ChildSettledInputSchema>;

// 通用验证记录（M7，决策 071）：尝试收尾后由程序在该尝试的工作区执行配置的验证命令，模型看不到；
// target 指明对应的会话与 Run
export const AttemptVerifiedInputSchema = Type.Object({
  ...OptionalRunId,
  target: Type.Object({ sessionId: SessionIdSchema, runId: RunIdSchema }),
  // 实际执行的参数数组
  command: Type.Array(Type.String()),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Optional(Type.String()),
  timedOut: Type.Boolean(),
  // 验证命令自身故障（拉不起进程、工作区不存在）
  error: Type.Optional(Type.String()),
  durationMs: Type.Integer({ minimum: 0 }),
  outputBytes: Type.Integer({ minimum: 0 }),
  outputHash: Sha256HexSchema,
  output: Type.String(),
  truncated: Type.Boolean(),
  // 执行验证的工作区（尝试所在的工作树或工作区根）
  workspace: Type.String({ minLength: 1 }),
  verdict: EvalVerdictSchema,
  verifiedAt: Type.Integer({ minimum: 0 }),
  // 决策 159：分步配置下的各步结论；单条命令配置不带
  steps: Type.Optional(Type.Array(VerifyStepResultSchema, { minItems: 1 })),
});
export type AttemptVerifiedInput = Static<typeof AttemptVerifiedInputSchema>;

// 分叉（M7，决策 077）：写进来源会话；新分支标识即分支会话号
export const SessionForkedInputSchema = Type.Object({
  ...OptionalRunId,
  forkPoint: ForkPointSchema,
  branchSessionId: SessionIdSchema,
  checkpoint: CheckpointRefSchema,
  trigger: ForkTriggerSchema,
  forkedAt: Type.Integer({ minimum: 0 }),
});
export type SessionForkedInput = Static<typeof SessionForkedInputSchema>;

// 分支会话的来历（写进分支会话文件头）；分支恒在独立工作树里续跑
export const BranchHeaderInputSchema = Type.Object({
  ...OptionalRunId,
  sourceSessionId: SessionIdSchema,
  forkPoint: ForkPointSchema,
  checkpoint: CheckpointRefSchema,
  workspace: GitWorktreeWorkspaceSchema,
  trigger: ForkTriggerSchema,
  startedAt: Type.Integer({ minimum: 0 }),
});
export type BranchHeaderInput = Static<typeof BranchHeaderInputSchema>;
