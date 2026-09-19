// 尝试级配置（M7，决策 071 / 079）：会话级验证命令与失败自动分叉重试次数。会话开始时冻结进注入快照，
// 随 run.started 落盘，事后可证每次尝试用的是哪条验证命令、允许重试几次。Eval 沿用 task.json 的验证器，不走这里。
import { type Static, Type } from "typebox";

// 验证命令：人配置的一行命令（经系统 shell 执行），带超时
export const VerifyConfigSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  timeoutMs: Type.Integer({ minimum: 1 }),
});
export type VerifyConfig = Static<typeof VerifyConfigSchema>;

// 失败自动分叉重试次数：0 为关闭（缺省）
export const RetryOnFailSchema = Type.Integer({ minimum: 0 });
