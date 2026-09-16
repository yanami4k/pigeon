// worker 角色与委派策略（M5.5 S2，决策 040）：角色是参数不是执行体；worker 策略只能从父策略里挑子集——
// allow 只缩（角色默认工具 ∩ 父 allow，再剔除父 deny），deny 只增（原样继承父 deny），审批模式不升级
// （父 prompt 不派 yolo 子）。assertPolicySubset 是构造之外的第二道校验，派出前必过。
import { MCP_TOOL_PREFIX } from "../mcp/registry-bridge.ts";
import { READ_SESSION_ENTRY_TOOL, SEARCH_SESSIONS_TOOL } from "../memory/search-tools.ts";
import type { DelegatedPolicy, WorkerRole } from "../state/event-log.ts";
import { REVIEW_ENTRY_TOOL, REVIEW_SNAPSHOT_TOOL } from "../state/review.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";

export class WorkerPolicyError extends Error {}

export const WORKER_ROLES: readonly WorkerRole[] = [
  "reviewer",
  "explorer",
  "implementer",
  "tester",
];

// 角色默认工具（ROADMAP §M5.5 角色表）；tester 的 run_command 另受 .pigeon/commands.json 角色清单限定（048）
export const ROLE_TOOLS: Readonly<Record<WorkerRole, readonly string[]>> = {
  // M6（决策 064 子裁决 ⑤）：Reviewer 只读被审的那一次 Run 的冻结快照，不做跨会话检索；
  // 白名单只有这两个只读工具，任何写档、终端、消息与浏览器工具一律不在其中
  reviewer: [REVIEW_SNAPSHOT_TOOL, REVIEW_ENTRY_TOOL],
  explorer: ["read_file", SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL],
  implementer: ["read_file", "edit_file"],
  tester: ["read_file", "run_command"],
};

// 角色表的推理档位列（决策 050）：在场即覆盖启动参数的全局值，缺省继承全局。第一版四个角色都继承
export const ROLE_THINKING_LEVELS: Readonly<Partial<Record<WorkerRole, ThinkingLevel>>> = {};

// 角色表的模型接入覆盖列（M6，决策 064 子裁决 ③）：在场即覆盖主会话的模型接入与标识，缺省继承。
// streamFnSpec 是插件模块说明符，由装配层预先加载成 StreamFn（工厂本身同步，不在此处做 IO）；
// provider 与 modelId 只是身份标签，进注入快照与 run.started。第一版四个角色都留空
export interface RoleModelOverride {
  streamFnSpec?: string;
  provider?: string;
  modelId?: string;
}

export const ROLE_MODEL_OVERRIDES: Readonly<Partial<Record<WorkerRole, RoleModelOverride>>> = {};

export function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

// M6（决策 064 子裁决 ⑤）：绑定被审 Run 的只读快照工具。它们不在主会话的工具清单里（主会话不需要读自己的快照），
// 只读、不写任何东西、作用域只限父会话自己的那一次 Run，故不受"子策略必须在父 allow 里"的约束；
// 父策略的 deny 照旧生效，其余工具一律照常受子集约束
export const SCOPED_REVIEW_TOOLS: readonly string[] = [REVIEW_SNAPSHOT_TOOL, REVIEW_ENTRY_TOOL];

export function deriveWorkerPolicy(parent: ToolPolicyLike, role: WorkerRole): DelegatedPolicy {
  const deny = [...new Set(parent.deny)];
  // M5.7 S4：implementer 另继承父策略里的 MCP 工具（外部写工具照样逐次审批）；其余角色不继承
  const inherited =
    role === "implementer"
      ? parent.allow.filter((tool) => tool.startsWith(`${MCP_TOOL_PREFIX}__`))
      : [];
  const allow = [...ROLE_TOOLS[role], ...inherited].filter(
    (tool) =>
      (parent.allow.includes(tool) ||
        (role === "reviewer" && SCOPED_REVIEW_TOOLS.includes(tool))) &&
      !deny.includes(tool)
  );
  return { allow, deny, approvalMode: parent.approvalMode };
}

export function assertPolicySubset(child: ToolPolicyLike, parent: ToolPolicyLike): void {
  const widened = child.allow.filter(
    (tool) =>
      (!parent.allow.includes(tool) && !SCOPED_REVIEW_TOOLS.includes(tool)) ||
      parent.deny.includes(tool)
  );
  if (widened.length > 0) {
    throw new WorkerPolicyError(`worker 策略超出父策略：${widened.join("、")}`);
  }
  const dropped = parent.deny.filter((tool) => !child.deny.includes(tool));
  if (dropped.length > 0) {
    throw new WorkerPolicyError(`worker 策略丢了父策略的 deny：${dropped.join("、")}`);
  }
  if (child.approvalMode === "yolo" && parent.approvalMode !== "yolo") {
    throw new WorkerPolicyError("worker 审批模式不能高于父策略（父 prompt 不派 yolo 子）");
  }
}
