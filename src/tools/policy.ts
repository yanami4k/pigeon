// 策略求值（M3 决策 4 + M4 S6 决策 3 排律）：纯函数，逐调用判定 auto-allow / deny / prompt。
// 判定矩阵（绑定 docs/decision/m3-key-decisions.md 与 m4-pre-decisions.md 决策 3）：
//   1. 未注册工具 → deny（fail-closed）
//   2. deny 清单绝对：任何模式下精确匹配工具名即拒，yolo / grant / 配置规则一律不豁免
//      （M3 仅精确匹配（工具名级），参数内容模式识别显式排除——做不好的模式识别是虚假安全感）
//   3. grant 命中（会话 grant / 固化配置规则，M4 S6）→ auto-allow——approvedBy 记
//      human:grant / policy:config，审批决定回指出处（每次免审都可审计"凭什么没问人"）
//   3a. 免审批的写档工具（注册时标明，施工默认 Q12：只写学到的记忆）→ auto-allow，与审批模式无关
//   4. yolo → 非 deny 全放行（人事先批发授权，账本上 approvedBy 记 policy:yolo）
//   5. prompt → read 层自动放行；write / exec 层必须人工批准
// 注意：policy.allow 不参与逐调用判定——它约束的是广告给模型的工具集（Adapter 接线层职责）；
// 逐调用判定只依赖注册表 + deny + grant 匹配 + 模式。
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

// grant 命中出处（M4 S6，决策 3）：由 Adapter 注入（会话 grant 存储 / 固化配置规则匹配），
// policy 层不自己求匹配——路径包含判定需要工作区根，那是装配层的依赖
export interface GrantEvaluation {
  readonly source: "session-grant" | "config-rule";
  readonly refId: string;
}

export interface PolicyDecision {
  readonly kind: PolicyDecisionKind;
  // 人读理由；deny 时逐字反馈给模型（spike S2a）
  readonly reason: string;
  // grant 命中时在场（排律第 3 档）：adapter 据此记 approvedBy=human:grant / policy:config
  readonly grant?: GrantEvaluation;
  // 免审批的写档工具放行时在场（排律第 3a 档）：记 approvedBy=policy:auto，不算"需要人来批"
  readonly approvalFree?: true;
}

// 注册表内查工具：fail-closed 由构造保证——调用方无法把未注册工具当作已注册求值。
// grant 为命中出处时插入排律第 3 档（deny 之后、yolo 之前）
export function evaluateToolPolicy(
  registry: ToolRegistry,
  toolName: string,
  policy: ToolPolicyLike,
  grant?: GrantEvaluation
): PolicyDecision {
  const registration = registry.get(toolName);
  if (registration === undefined) {
    return { kind: "deny", reason: `未注册工具（fail-closed）：${toolName}` };
  }
  if (policy.deny.includes(toolName)) {
    return { kind: "deny", reason: `deny 清单精确匹配，任何模式一律拒绝：${toolName}` };
  }
  if (grant !== undefined) {
    const origin =
      grant.source === "session-grant"
        ? `会话放权 ${grant.refId}`
        : `固化规则 ${grant.refId}（设置的 permissions 一节）`;
    return {
      kind: "auto-allow",
      reason: `${origin} 命中：${toolName} 免审放行（账本记 ${
        grant.source === "session-grant" ? "human:grant" : "policy:config"
      }，回指出处）`,
      grant,
    };
  }
  if (registration.approvalFree === true) {
    return {
      kind: "auto-allow",
      reason: `免审批的写档工具自动放行：${toolName}`,
      approvalFree: true,
    };
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
