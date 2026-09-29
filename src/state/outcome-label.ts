// 尝试结果的五个标签（M7 S1，决策 072；ROADMAP §M7 OutcomeLabeler）：由会话现算，不落盘。
// 判定顺序：
//   1. 证据不完整（缺运行结束记录、有悬账）→ 未知：副作用是否发生都不确定时不下确定性结论，验证结论也不例外；
//   2. 被打转检测叫停 → 失败（决策 307：照常验证，但验证结论不压过它）；
//   3. 有验证结论 → 通过即成功、失败即失败、未判定即未知（验证结论压过其余运行终态）；
//   4. 无验证：撞任一上限 → 失败；治理熔断 → 失败；人主动取消 → 放弃；基础设施错误单列；业务失败 → 失败；
//      正常完成与分类为未知的 → 未知（无验证而正常完成不等于做对）。
// 放弃与基础设施错误不进成败对比（由对比方过滤，本文件只贴标签）。纯函数，无 IO。
// 事实从会话存储现算（按整步取，回炉口径见 state/session-judge.ts），本文件只放判据。
import type { OutcomeLabel } from "./attempt-ref.ts";
import type { FailureClass } from "./classification.ts";
import type { EvalVerdict } from "./runtime-events.ts";

export type { OutcomeLabel } from "./attempt-ref.ts";

export interface AttemptOutcomeFacts {
  hasRunEnded: boolean;
  // 这一步的悬账条数（带工具调用而没有工具结果）
  pendingCount: number;
  // 失败四分类（null = 正常收尾）
  failure: FailureClass | null;
  limitHit: boolean;
  // 这一步的最后一个 Run 被打转检测叫停（决策 307：照常验证，但成败算失败，验证结论不压过它）；缺省 = 否
  looping?: boolean;
  // 最后一条验证结论；缺省 = 无验证
  verdict?: EvalVerdict;
}

export function labelAttempt(facts: AttemptOutcomeFacts): OutcomeLabel {
  if (!facts.hasRunEnded || facts.pendingCount > 0) {
    return "Unknown";
  }
  if (facts.looping === true) {
    return "Failed";
  }
  if (facts.verdict !== undefined) {
    return facts.verdict === "pass" ? "Passed" : facts.verdict === "fail" ? "Failed" : "Unknown";
  }
  if (facts.limitHit) {
    return "Failed";
  }
  const failure = facts.failure;
  if (failure === null) {
    return "Unknown";
  }
  switch (failure.category) {
    case "cancelled":
      return failure.breaker ? "Failed" : "Abandoned";
    case "infrastructure":
      return "InfrastructureError";
    case "business":
      return "Failed";
    default:
      return "Unknown";
  }
}
