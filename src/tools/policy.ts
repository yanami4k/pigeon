// 策略求值（M3 决策 4）：纯函数，逐调用判定 auto-allow / deny / prompt。
// 判定矩阵（绑定 docs/decision/m3-key-decisions.md）：
//   1. 未注册工具 → deny（fail-closed）
//   2. deny 清单绝对：任何模式下精确匹配工具名即拒，yolo 不豁免；M3 仅精确匹配（工具名级），
//      参数内容模式识别显式排除出 M3（做不好的模式识别是虚假安全感）
//   3. yolo → 非 deny 全放行（人事先批发授权，账本上 approvedBy 记 policy:yolo）
//   4. prompt → read 层自动放行；write / exec 层必须人工批准
// 注意：policy.allow 不参与逐调用判定——它约束的是广告给模型的工具集（Adapter 接线层职责）；
// 逐调用判定只依赖注册表 + deny + 模式。
import { type Static, Type } from "typebox";
import type { ToolRegistry } from "./registry.ts";

// 审批模式：prompt 逐次问人 / yolo 事先批发授权（InjectionSnapshot.tools.policy 冻结，模型不可自改）
export const ApprovalModeSchema = Type.Union([Type.Literal("prompt"), Type.Literal("yolo")]);
export type ApprovalMode = Static<typeof ApprovalModeSchema>;

// 与 pi-runtime InjectionSnapshot.tools.policy 结构对齐；结构类型解耦，避免 tools → pi-runtime 依赖
export interface ToolPolicyLike {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly approvalMode: ApprovalMode;
}

export type PolicyDecisionKind = "auto-allow" | "deny" | "prompt";

export interface PolicyDecision {
  readonly kind: PolicyDecisionKind;
  // 人读理由；deny 时逐字反馈给模型（spike S2a）
  readonly reason: string;
}

// 注册表内查工具：fail-closed 由构造保证——调用方无法把未注册工具当作已注册求值
export function evaluateToolPolicy(
  registry: ToolRegistry,
  toolName: string,
  policy: ToolPolicyLike
): PolicyDecision {
  const registration = registry.get(toolName);
  if (registration === undefined) {
    return { kind: "deny", reason: `未注册工具（fail-closed）：${toolName}` };
  }
  if (policy.deny.includes(toolName)) {
    return { kind: "deny", reason: `deny 清单精确匹配，任何模式一律拒绝：${toolName}` };
  }
  if (policy.approvalMode === "yolo") {
    return {
      kind: "auto-allow",
      reason: `yolo 模式事先批发授权：${toolName}（账本记 approvedBy=policy:yolo）`,
    };
  }
  if (registration.tier === "read") {
    return { kind: "auto-allow", reason: `只读工具自动放行：${toolName}` };
  }
  return {
    kind: "prompt",
    reason: `${registration.tier} 层工具必须人工批准：${toolName}`,
  };
}
