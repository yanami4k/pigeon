// 失败四分类（M4 S2，D7 判据表）：取消（含子类「治理熔断」）/ 业务失败 / 基础设施错误 / 未知。
// 设计约束：
//   - 纯函数，判据只依赖传入事实——会话读者（state/session-judge.ts、session-view.ts）与活适配器
//     （RunResult.failure）共用同一套 Run 级判据，杜绝两套口径漂移；工具级判据在 session-judge.ts；
//   - 默认桶是「未知」而非「业务失败」：宁可标「不知道」不贴错标签——
//     标签要喂 M6+ 蒸馏，贴错 = 毒信号；
//   - null = 非失败（正常完成）。

export type FailureClass =
  // 取消；breaker=true 即子类「治理熔断」（trace 中「用户取消」与「治理熔断」必须一眼可分）
  | { category: "cancelled"; breaker: boolean }
  // 业务失败：输出截断 / 工具域错误 / 模型侧非法调用
  | { category: "business" }
  // 基础设施错误：provider 故障（syntheticFailure）/ 环境异常
  | { category: "infrastructure" }
  // 未知（默认桶）：崩溃残留、判据均不匹配
  | { category: "unknown" };

export interface RunOutcomeFacts {
  // 末条 assistant turn 的 stopReason；缺省 + hasTurnCompleted=false = 崩溃残留
  stopReason?: string;
  // 末条 assistant 消息是上游合成的失败消息（M1 检测 = provider 侧故障）
  syntheticFailure: boolean;
  // 本 Run 有熔断落闸记录（breaker 族）
  breakerTripped: boolean;
  hasTurnCompleted: boolean;
  // run.ended（agent_end）是否在场：缺失 = 循环没有跑到终点（进程死于中途），
  // 无论末条 turn 的 stopReason 是什么都不能判正常（M4 验收 O-1，decisions.md 023）。
  // 活侧 RunResult 在 agent_end 之后计算，恒为 true；abort 路径上游照常发 agent_end
  hasRunEnded: boolean;
}

export function classifyRunOutcome(facts: RunOutcomeFacts): FailureClass | null {
  if (!facts.hasRunEnded || !facts.hasTurnCompleted) {
    return { category: "unknown" }; // 崩溃残留（无 run.ended）/ 无任何 turn 收尾（D8 迁移会话）
  }
  if (facts.stopReason === "aborted") {
    return { category: "cancelled", breaker: facts.breakerTripped };
  }
  if (facts.stopReason === "length") {
    return { category: "business" };
  }
  if (facts.syntheticFailure) {
    return { category: "infrastructure" };
  }
  if (
    facts.stopReason === "stop" ||
    facts.stopReason === "toolUse" ||
    facts.stopReason === "deferred"
  ) {
    return null; // 正常收尾不是失败
  }
  return { category: "unknown" }; // error（非合成）/ pending / 意外值 → 默认桶
}
