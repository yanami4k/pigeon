// 会话事实的载荷形状（决策 177 / 184）：worker 编排、分叉与授权各写入点交给新会话存储的输入，以及它们共用的
// 子结构（角色、工作区、委派策略、上限、分叉点、快照引用）。纯类型、无 IO；写成哪种自定义条目或文件头见 session-entries.ts。
// 决策 322：验证记录已停写，AttemptVerifiedInput 随验证门删除；旧会话里的验证条目形状留在 session-entries.ts 供读取
import { type Static, Type } from "typebox";
import { GrantIdSchema, RunIdSchema, SessionIdSchema } from "./ids.ts";

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

// worker 的工作区：git 工作树（M5.5；M8 决策 082 加可选起点提交）、"无工作区"（M6，决策 064）与共用派出方的工作区（决策 377）。
// 决策 137 之后不再产生无工作区（只读角色已退役），该成员保留在联合里使形状不变
export const GitWorktreeWorkspaceSchema = Type.Object({
  kind: Type.Literal("git-worktree"),
  baseCommit: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" })),
  path: Type.String({ minLength: 1 }),
  branch: Type.String({ minLength: 1 }),
});
export const NoWorkspaceSchema = Type.Object({ kind: Type.Literal("none") });
// 决策 377：只读的 explorer 不建工作树，直接读派出方的工作区（主工作目录或派出方 worker 的工作树）；path 为该目录
export const SharedWorkspaceSchema = Type.Object({
  kind: Type.Literal("shared"),
  path: Type.String({ minLength: 1 }),
});
export const WorkerWorkspaceSchema = Type.Union([
  GitWorktreeWorkspaceSchema,
  NoWorkspaceSchema,
  SharedWorkspaceSchema,
]);
export type WorkerWorkspace = Static<typeof WorkerWorkspaceSchema>;
export type GitWorktreeWorkspace = Static<typeof GitWorktreeWorkspaceSchema>;

// 证据链显示（trace、replay）里 worker 工作区的一段
export function workerWorkspaceLabel(workspace: WorkerWorkspace): string {
  return workspace.kind === "git-worktree"
    ? `分支 ${workspace.branch}`
    : workspace.kind === "shared"
      ? "只读派出方工作区（不建工作树）"
      : "无工作区";
}

// worker 读写所在的目录：工作树或与派出方共用的工作区；无工作区（只剩旧会话）没有
export function workerWorkspacePath(workspace: WorkerWorkspace): string | undefined {
  return workspace.kind === "none" ? undefined : workspace.path;
}

// 类型谓词：只有 git 工作树形状才有路径与分支（无工作区的 worker 两者皆无）
export function isGitWorktreeWorkspace(
  workspace: WorkerWorkspace
): workspace is GitWorktreeWorkspace {
  return workspace.kind === "git-worktree";
}

// 决策 360：worker 某件工具的作用范围（只能比派出方更窄）——文件类工具限工作区相对路径（目录含其下），跑命令限命令前缀
export const ToolScopeSchema = Type.Object({
  tool: Type.String({ minLength: 1 }),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  commandPrefixes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
});
export type ToolScope = Static<typeof ToolScopeSchema>;

// 委派策略摘要：与 InjectionSnapshot.tools.policy 同形（state 是叶子层，不引 tools 的 schema）；
// scopes 为决策 360 的作用范围，派出记录里有才在场（之前的记录没有，即不限）
export const DelegatedPolicySchema = Type.Object({
  allow: Type.Array(Type.String({ minLength: 1 })),
  deny: Type.Array(Type.String({ minLength: 1 })),
  approvalMode: Type.Union([Type.Literal("prompt"), Type.Literal("yolo")]),
  scopes: Type.Optional(Type.Array(ToolScopeSchema)),
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
  // 决策 298：卡住——长时间没有新的模型回复或工具结果，被卡住监控中断
  Type.Literal("stalled"),
]);
export type ChildSettledStatus = Static<typeof ChildSettledStatusSchema>;

// 决策 298：worker 结束时的错误类型（非完成时在场）。approval-timeout / approval-unattended 为可恢复（决策 303：补批后能续做）
export const WorkerErrorKindSchema = Type.Union([
  Type.Literal("run-failed"),
  Type.Literal("empty-reply"),
  Type.Literal("exception"),
  Type.Literal("spawn-failed"),
  Type.Literal("cancelled"),
  Type.Literal("aborted"),
  Type.Literal("turn-limit"),
  Type.Literal("wall-clock-limit"),
  Type.Literal("token-limit"),
  Type.Literal("stalled"),
  Type.Literal("looping"),
  Type.Literal("approval-timeout"),
  Type.Literal("approval-unattended"),
]);
export type WorkerErrorKind = Static<typeof WorkerErrorKindSchema>;

// worker 结构化结果：分支、改动文件清单（工作树内相对路径）、自述摘要；无工作区的 worker 没有分支与改动文件。
// structured 承载模型交回的结构化内容（编排器收尾时取运行面的结构化结果），生产代码暂无读取方，不写进会话存储
export const ChildResultSchema = Type.Object({
  branch: Type.Optional(Type.String({ minLength: 1 })),
  changedFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  summary: Type.String(),
  summaryTruncated: Type.Boolean(),
  structured: Type.Optional(Type.Unknown()),
  // 决策 381：worker 新建却因过大没写进交回的树的未跟踪文件（路径相对工作树）；没有即缺省
  skippedFiles: Type.Optional(
    Type.Array(
      Type.Object({ path: Type.String({ minLength: 1 }), bytes: Type.Integer({ minimum: 0 }) })
    )
  ),
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
  // 决策 290：按网站放权的主机名（web_fetch）
  host: Type.Optional(Type.String({ minLength: 1 })),
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

// 决策 312：脚本编排派出的 worker 在派出与收尾条目上加记的字段（不新增记录种类）——脚本运行号、调用指纹，接力时记上游 worker
// 的会话号（续跑时据此判断下游能否复用：上游重做了，下游随之重做）
export const ScriptSpawnTagSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  fingerprint: Type.String({ minLength: 1 }),
  relayFrom: Type.Optional(SessionIdSchema),
});
export type ScriptSpawnTag = Static<typeof ScriptSpawnTagSchema>;

// 收尾条目上的：运行号、指纹与 worker 交回的结构化数据（续跑复用时按输出格式重新校验）
export const ScriptSettleTagSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  fingerprint: Type.String({ minLength: 1 }),
  structured: Type.Optional(Type.Unknown()),
});
export type ScriptSettleTag = Static<typeof ScriptSettleTagSchema>;

export const ChildSpawnedInputSchema = Type.Object({
  ...OptionalRunId,
  childSessionId: SessionIdSchema,
  name: Type.String({ minLength: 1 }),
  role: WorkerRoleSchema,
  task: Type.String({ minLength: 1 }),
  // M7（决策 069）：并行派发同一任务的多个 worker 共享的任务标识；单派缺省
  taskKey: Type.Optional(Type.String({ minLength: 1 })),
  // 决策 294：派出时带的标签（原样带回）
  label: Type.Optional(Type.String({ minLength: 1 })),
  policy: DelegatedPolicySchema,
  limits: WorkerLimitsSchema,
  workspace: WorkerWorkspaceSchema,
  spawnedAt: Type.Integer({ minimum: 0 }),
  // 决策 312：脚本编排派出的调用
  script: Type.Optional(ScriptSpawnTagSchema),
});
export type ChildSpawnedInput = Static<typeof ChildSpawnedInputSchema>;

export const ChildSettledInputSchema = Type.Object({
  ...OptionalRunId,
  childSessionId: SessionIdSchema,
  name: Type.String({ minLength: 1 }),
  status: ChildSettledStatusSchema,
  // 失败、派出失败时的人读原因
  error: Type.Optional(Type.String()),
  // 决策 298：错误类型（非完成时在场）
  errorKind: Type.Optional(WorkerErrorKindSchema),
  // 派出失败时缺省（没有可回收的工作）
  result: Type.Optional(ChildResultSchema),
  // 完成的模型轮次数
  turns: Type.Integer({ minimum: 0 }),
  settledAt: Type.Integer({ minimum: 0 }),
  // 决策 312：脚本编排派出的调用
  script: Type.Optional(ScriptSettleTagSchema),
});
export type ChildSettledInput = Static<typeof ChildSettledInputSchema>;

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
