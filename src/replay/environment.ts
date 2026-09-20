// 验证环境摘要与批准失效判据（M8 S8，决策 091）。
//
// 摘要记全：模型标识与版本、harness 提交号、Node 与平台、预算参数、验证命令、同时装载的经验集合内容哈希
// 与明细、四组通过次数与结论、各次运行的会话号（后两项在回执记录里，见 state/event-log.ts）。
//
// 失效判据只看封闭四项清单——判据开放会让"批准还算不算数"随时间悄悄漂移，清单增删须单独裁决：
//   1. model：模型标识（provider + id）。不同的模型跑出来的通过率不可互相引用；
//   2. experienceSet：同时装载的经验集合内容哈希。回放测的是"这一套经验一起装载"的效果，集合变了结论就不适用；
//   3. budget：预算参数（轮次、墙钟、token 三项上限，加单轮输出上限）。预算变了成功率跟着变，
//      与经验无关——"单轮输出上限也算预算参数"是本实现对 091 中"预算参数"的口径，收紧与放宽同样算变化；
//   4. verifyCommand：验证命令本身。判成败的尺子换了，旧结论无从比较。
//
// 清单外的项（harness 提交号与是否有未提交改动、Node 版本、平台、验证命令的超时与来源、推理档位、
// 经验明细）只记录不判定：它们进回执供人阅读，但不自动让批准失效。
import { createHash } from "node:crypto";
import type { LoadedExperience, VerificationEnvironment } from "../state/event-log.ts";

// 封闭清单的四个键，顺序即判定与展示顺序
export const APPROVAL_STALENESS_KEYS = [
  "model",
  "experienceSet",
  "budget",
  "verifyCommand",
] as const;
export type ApprovalStalenessKey = (typeof APPROVAL_STALENESS_KEYS)[number];

export interface StalenessReason {
  key: ApprovalStalenessKey;
  // 给人看的一句话：批准时是什么、现在是什么
  detail: string;
}

// 经验集合内容哈希：按 种类/名字/内容哈希 规范排序后拼接取 sha256——
// 与登记顺序无关（同一套经验换个装载顺序仍是同一套），任一条内容变一个字节即变，增删一条也变
export function experienceSetHash(experiences: readonly LoadedExperience[]): string {
  const lines = experiences
    .map((entry) => `${entry.kind}/${entry.name}/${entry.contentHash}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

// 预算参数的可比形态：缺省即"该项不设限"，与设了限是两回事，故用显式文案而非空串
function budgetShape(environment: VerificationEnvironment): string {
  const { budget, model } = environment;
  const item = (value: number | undefined): string => (value === undefined ? "不设限" : `${value}`);
  return [
    `轮次 ${item(budget.maxTurns)}`,
    `墙钟 ${item(budget.wallClockMs)}`,
    `token ${item(budget.maxTokens)}`,
    `单轮输出 ${item(model.maxOutputTokens)}`,
  ].join("，");
}

// 批准所依据的环境与当下环境的差异；空数组 = 批准仍然有效。
// unknown 列出"当下这一侧取不到值"的项：它们既不判为相同也不判为不同，直接跳过。
// 这是 091 理由里点名要避开的失效模式——拿一个编出来的值（例如把"没有预算"当成"不设限"）
// 去和回执里的真实数字比，会让每一条验过的经验每次开会话都报一次假失效，最后导致该机制被关掉。
export function stalenessReasons(
  approved: VerificationEnvironment,
  current: VerificationEnvironment,
  unknown: ReadonlySet<ApprovalStalenessKey> = new Set()
): StalenessReason[] {
  const reasons: StalenessReason[] = [];
  const approvedModel = `${approved.model.provider}/${approved.model.id}`;
  const currentModel = `${current.model.provider}/${current.model.id}`;
  if (!unknown.has("model") && approvedModel !== currentModel) {
    reasons.push({
      key: "model",
      detail: `模型标识：批准时 ${approvedModel}，现在 ${currentModel}`,
    });
  }
  if (!unknown.has("experienceSet") && approved.experienceSetHash !== current.experienceSetHash) {
    reasons.push({
      key: "experienceSet",
      detail: `经验集合内容哈希：批准时 ${approved.experienceSetHash.slice(0, 12)}，现在 ${current.experienceSetHash.slice(0, 12)}`,
    });
  }
  const approvedBudget = budgetShape(approved);
  const currentBudget = budgetShape(current);
  if (!unknown.has("budget") && approvedBudget !== currentBudget) {
    reasons.push({
      key: "budget",
      detail: `预算参数：批准时（${approvedBudget}），现在（${currentBudget}）`,
    });
  }
  if (!unknown.has("verifyCommand") && approved.verify.command !== current.verify.command) {
    reasons.push({
      key: "verifyCommand",
      detail: `验证命令：批准时 ${approved.verify.command}，现在 ${current.verify.command}`,
    });
  }
  return reasons;
}

export function isApprovalStale(
  approved: VerificationEnvironment,
  current: VerificationEnvironment,
  unknown: ReadonlySet<ApprovalStalenessKey> = new Set()
): boolean {
  return stalenessReasons(approved, current, unknown).length > 0;
}
