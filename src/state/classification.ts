// 失败四分类（M4 S2，D7 判据表）：取消（含子类「治理熔断」）/ 业务失败 / 基础设施错误 / 未知。
// 设计约束：
//   - 纯函数，判据只依赖传入事实——冷物化（事件日志重建，event-log.ts）与活适配器
//     （RunResult.failure）共用同一套判据，杜绝两套口径漂移；
//   - 默认桶是「未知」而非「业务失败」：宁可标「不知道」不贴错标签——
//     标签要喂 M6+ 蒸馏，贴错 = 毒信号；
//   - null = 非失败（正常完成 / 被拒绝的治理闭环 / 确证已执行）。
import type { ToolErrorKind } from "./tool-execution.ts";

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
  // 空回复异常结束（决策 170 ②）：活侧取自 Run 结果，新存储取自收尾条目的结束方式；旧账本没有这项事实，缺省为否
  emptyReply?: boolean;
}

export function classifyRunOutcome(facts: RunOutcomeFacts): FailureClass | null {
  if (!facts.hasRunEnded || !facts.hasTurnCompleted) {
    return { category: "unknown" }; // 崩溃残留（无 run.ended）/ 无任何 turn 收尾（D8 迁移会话）
  }
  if (facts.stopReason === "aborted") {
    return { category: "cancelled", breaker: facts.breakerTripped };
  }
  // 空回复与撞输出上限同属模型输出的问题：业务失败
  if (facts.stopReason === "length" || facts.emptyReply === true) {
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

export interface ToolOutcomeFacts {
  // 有 decision 拒绝行（治理闭环，不是失败）
  rejected: boolean;
  hasReceipt: boolean;
  executed: boolean;
  isError: boolean;
  // settled 事件携带的域/环境归类（M4 S2）；缺省 = 判不出
  errorKind?: ToolErrorKind;
  // 哈希自动确证结果（D5）；缺省 = 未确证
  resolved?: "executed" | "not-executed";
  // settled isError 且无任何账本治理记录 ⟺ 上游拦截（参数校验失败/幽灵工具名）
  intercepted: boolean;
  // 所在 Run 的终态事实（abort 归取消，熔断切断归治理熔断子类）
  runAborted: boolean;
  runBreakerTripped: boolean;
}

export function classifyToolOutcome(facts: ToolOutcomeFacts): FailureClass | null {
  if (facts.rejected) {
    return null; // 拒绝是治理闭环，不是失败
  }
  if (facts.resolved === "executed") {
    return null; // 确证已执行，销账
  }
  if (facts.resolved === "not-executed") {
    // 死于 intent 与 dispatch 之间：Run 被中断（abort）归取消，否则是崩溃残留（未知）
    return facts.runAborted
      ? { category: "cancelled", breaker: facts.runBreakerTripped }
      : { category: "unknown" };
  }
  if (facts.intercepted) {
    return { category: "business" }; // 模型侧非法调用（参数校验失败/幽灵工具名）
  }
  if (!facts.hasReceipt) {
    return { category: "unknown" }; // 悬账未确证（OutcomeUnknown 残留）
  }
  if (facts.executed && !facts.isError) {
    return null; // 成功不是失败
  }
  if (!facts.isError) {
    return { category: "unknown" }; // executed=false 且 isError=false 且无 decision：不应出现的组合
  }
  // 执行出错：abort 优先（取消/治理熔断），再按错误归类，判不出落默认桶
  if (facts.runAborted) {
    return { category: "cancelled", breaker: facts.runBreakerTripped };
  }
  if (facts.errorKind === "domain") {
    return { category: "business" };
  }
  if (facts.errorKind === "environment") {
    return { category: "infrastructure" };
  }
  return { category: "unknown" };
}
