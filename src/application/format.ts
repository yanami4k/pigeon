// Actor 报告共用人话格式化助手（trace / replay / resume 菜单等共用，单一约定，禁止各视图
// 自造第二套措辞）。住在 application/（M2 S1，决策 025）：它是 cli 与将来的 tui 唯一同时
// 可达的共享层——resume 流程（application/resume.ts）与 CLI 各只读视图（cli/）都从这里取措辞。
import type { FailureClass } from "../state/classification.ts";
import type { ToolExecutionDecision } from "../state/tool-execution.ts";

// 参数摘要上限（字符）；超出截断并标注原长，防大参数刷屏
const ARGS_SUMMARY_LIMIT = 160;

// 稳定 id 短哈希：`exec_` 等前缀 + ULID 前 8 位 + 省略号；非稳定 id（toolCallId 等）原样
export function shortId(id: string): string {
  const match = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{8}/.exec(id);
  return match === null ? id : `${match[0]}…`;
}

// 模型原始参数的单行摘要；不可序列化时如实说明
export function summarizeArgs(args: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(args) ?? "undefined";
  } catch {
    return "<不可序列化参数>";
  }
  return json.length <= ARGS_SUMMARY_LIMIT
    ? json
    : `${json.slice(0, ARGS_SUMMARY_LIMIT)}…（共 ${json.length} 字符）`;
}

// 批准来源 → 人话（决策 4 证据链：策略决定不能伪装成人工；M4 S6：grant 出处如实标明）
const APPROVED_BY_LABEL: Record<string, string> = {
  human: "人工",
  "policy:yolo": "yolo 批发授权",
  "policy:auto": "策略自动放行",
  "policy:deny": "策略拒绝",
  "human:grant": "人工授权（会话 grant）",
  "policy:config": "策略放行（固化配置）",
};

// 审批决定 → 人话裁决：人工区分批准/拒绝；策略来源直接给标签（不伪装成人工）
export function approvalVerdict(decision: ToolExecutionDecision): string {
  const label = APPROVED_BY_LABEL[decision.approvedBy] ?? decision.approvedBy;
  return label === "人工" ? (decision.outcome === "approved" ? "人工批准" : "人工拒绝") : label;
}

// FailureClass → 人话徽章（D7：「用户取消」与「治理熔断」必须一眼可分）。
// 自 state/trace.ts 归位（M2 S5，决策 032）：徽章是 Actor 共用措辞（cli trace/replay 与
// tui 终态摘要同一口径），不是冷投影结构——state 只留判据（classification.ts），措辞归本模块
export function failureBadge(failure: FailureClass | null | undefined): string {
  if (failure === null || failure === undefined) {
    return "正常";
  }
  switch (failure.category) {
    case "cancelled":
      return failure.breaker ? "治理熔断" : "取消";
    case "business":
      return "业务失败";
    case "infrastructure":
      return "基础设施错误";
    case "unknown":
      return "未知";
  }
}

// 熔断计数粒度 → 人话
export function breakerScopeLabel(scope: string): string {
  const SCOPE_LABEL: Record<string, string> = {
    tool: "按工具名计数",
    fingerprint: "按参数指纹计数",
    intercepted: "上游拦截连击",
  };
  return SCOPE_LABEL[scope] ?? scope;
}
