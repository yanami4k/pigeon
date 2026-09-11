// CLI 报告共用人话格式化助手（trace / replay 共用，单一约定，禁止各视图自造第二套措辞）。
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

// 批准来源 → 人话（决策 4 证据链：策略决定不能伪装成人工）
const APPROVED_BY_LABEL: Record<string, string> = {
  human: "人工",
  "policy:yolo": "yolo 批发授权",
  "policy:auto": "策略自动放行",
  "policy:deny": "策略拒绝",
};

// 审批决定 → 人话裁决：人工区分批准/拒绝；策略来源直接给标签（不伪装成人工）
export function approvalVerdict(decision: ToolExecutionDecision): string {
  const label = APPROVED_BY_LABEL[decision.approvedBy] ?? decision.approvedBy;
  return label === "人工" ? (decision.outcome === "approved" ? "人工批准" : "人工拒绝") : label;
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
