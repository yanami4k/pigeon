// worker 角色与委派策略（M5.5 S2，决策 040）：角色是参数不是执行体；worker 策略只能从父策略里挑子集——
// allow 只缩（角色默认工具 ∩ 父 allow，再剔除父 deny），deny 只增（原样继承父 deny），审批模式不升级
// （父 prompt 不派 yolo 子）。assertPolicySubset 是构造之外的第二道校验，派出前必过。
// 第一版学习闭环退役（决策 137 / 158）：reviewer、distiller、verifier 三个角色停用、不再派出；
// 账本里的角色取值（WorkerRoleSchema）保留，旧会话记录照常读取。
// 决策 331：worker 只推送记忆、不带记忆工具（写记忆的工具只给有人对话的入口）；决策 249 的"三种角色另带记忆工具"随之取消。
// 决策 287–291：联网的两件工具（web_search、web_fetch）三种角色都带——与主会话同样拿到、同样的审批规则（父策略里有才带；
// 沙箱断网档与跑批器各条件的父策略里没有，角色也不带）。
// 决策 360：派出时可给工具清单，只能取派出方现有工具的子集（主会话专用的除外），不给即按角色取预设——三个角色退化为三份预设；
// 可给每件工具附加作用范围（文件类限路径、跑命令限命令前缀），只能比派出方更窄，派出方限定了的工具没另给即原样沿用。
import { MCP_TOOL_PREFIX } from "../mcp/registry-bridge.ts";
import {
  LIST_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
} from "../memory/search-tools.ts";
import { UPDATE_MEMORY_TOOL } from "../memory/update-memory-tool.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type { DelegatedPolicy, ToolScope, WorkerRole } from "../state/session-payloads.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../tools/host-scope.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import { READ_ONLY_SEARCH_TOOLS } from "../tools/search-tools.ts";
import {
  commandPrefixWords,
  normalizeScopePath,
  SCOPABLE_TOOLS,
  scopeKindOf,
  scopePathLinkProblem,
  scopeWithin,
} from "../tools/tool-scope.ts";
import { WRITE_FILE_TOOL } from "../tools/write-file.ts";

export class WorkerPolicyError extends Error {}

// 可派出的角色（写入侧）：账本角色取值的子集
export type ActiveWorkerRole = Extract<WorkerRole, "explorer" | "implementer" | "tester">;

export const WORKER_ROLES: readonly ActiveWorkerRole[] = ["explorer", "implementer", "tester"];

// 角色预设（ROADMAP §M5.5 角色表；360 起是派出时没给工具清单的缺省）；run_command 另受设置的 commands 一节为该角色登记的
// 清单限定（048；360 起登记了才限）。联网的两件工具三种角色都带（287–291）
const WEB_TOOLS = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL] as const;

export const ROLE_TOOLS: Readonly<Record<ActiveWorkerRole, readonly string[]>> = {
  // explorer 带 grep、glob 两件读档工具（决策 368）
  explorer: [
    "read_file",
    ...READ_ONLY_SEARCH_TOOLS,
    SEARCH_SESSIONS_TOOL,
    READ_SESSION_ENTRY_TOOL,
    LIST_SESSIONS_TOOL,
    ...WEB_TOOLS,
  ],
  implementer: ["read_file", "edit_file", WRITE_FILE_TOOL, ...WEB_TOOLS],
  tester: ["read_file", "run_command", ...WEB_TOOLS],
};

// 角色表的推理档位列（决策 050）：在场即覆盖启动参数的全局值，缺省继承全局。现有角色都继承
export const ROLE_THINKING_LEVELS: Readonly<Partial<Record<WorkerRole, ThinkingLevel>>> = {};

// 角色表的模型接入覆盖列（M6，决策 064 子裁决 ③）：在场即覆盖主会话的模型接入与标识，缺省继承。
// streamFnSpec 是插件模块说明符，由装配层预先加载成 StreamFn（工厂本身同步，不在此处做 IO）；
// provider 与 modelId 只是身份标签，进注入快照与 Run 开始条目。现有角色都留空
export interface RoleModelOverride {
  streamFnSpec?: string;
  provider?: string;
  modelId?: string;
}

export const ROLE_MODEL_OVERRIDES: Readonly<Partial<Record<WorkerRole, RoleModelOverride>>> = {};

export function isWorkerRole(value: string): value is ActiveWorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

// 决策 299：层数放开时，还没到最底层的 worker 另带派出与等待等编排工具（take_worker 除外：叠加只往主工作目录）；
// 名字与 application 层的工具名一致（本层不依赖 application）
export const NESTED_ORCHESTRATION_TOOLS: readonly string[] = [
  "spawn_worker",
  "wait_workers",
  "worker_status",
  "message_worker",
  "stop_worker",
];

// 决策 360：不能交给 worker 的工具——写记忆（331：worker 只推送）、取用 worker 改动（279：叠加只往主工作目录）、
// 提交编排脚本（309）与任务清单（294 B1）只给主会话；派出与等待等编排工具按层数自动给（299），也不在清单里选。
// 名字与 application 层的工具名一致（本层不依赖 application）
export const MAIN_ONLY_TOOLS: readonly string[] = [
  UPDATE_MEMORY_TOOL,
  "take_worker",
  "orchestrate",
  "update_tasks",
  "list_tasks",
  ...NESTED_ORCHESTRATION_TOOLS,
];

// 决策 377：explorer 的工具全在其预设（加层数给的编排工具）以内时只读，不拍快照、不建工作树，直接读派出方的工作区；
// 另给了写、跑命令或 MCP 等工具的 explorer 不再只读，照旧建工作树
export function readsInPlace(
  role: ActiveWorkerRole,
  policy: Pick<DelegatedPolicy, "allow">
): boolean {
  return (
    role === "explorer" &&
    policy.allow.every(
      (tool) => ROLE_TOOLS.explorer.includes(tool) || NESTED_ORCHESTRATION_TOOLS.includes(tool)
    )
  );
}

// 带作用范围的策略：派出方是 worker 时它自己的范围也在场（主会话没有）
export type ScopedPolicy = ToolPolicyLike & { readonly scopes?: readonly ToolScope[] };

export interface WorkerToolRequest {
  // 层数未满时另带编排工具（299）
  orchestration?: boolean;
  // 工具清单；不给即按角色取预设
  tools?: readonly string[];
  scopes?: readonly ToolScope[];
  // worker 起点所在的工作目录：在场即查范围路径自身或其上级是不是符号链接（是即拒，范围路径须为真实路径）
  root?: string;
}

// 派出方能交给 worker 的工具：它自己有的（不在 deny 里），去掉主会话专用的
export function delegableTools(parent: ToolPolicyLike): string[] {
  return parent.allow.filter(
    (tool) => !parent.deny.includes(tool) && !MAIN_ONLY_TOOLS.includes(tool)
  );
}

export function deriveWorkerPolicy(
  parent: ScopedPolicy,
  role: ActiveWorkerRole,
  options: WorkerToolRequest = {}
): DelegatedPolicy {
  const deny = [...new Set(parent.deny)];
  const orchestration = options.orchestration === true ? NESTED_ORCHESTRATION_TOOLS : [];
  const chosen =
    options.tools !== undefined ? checkedTools(parent, options.tools) : presetTools(parent, role);
  const allow = [...chosen, ...orchestration].filter(
    (tool) => parent.allow.includes(tool) && !deny.includes(tool)
  );
  const scopes = workerScopes(parent, allow, options.scopes ?? [], options.root);
  return {
    allow,
    deny,
    approvalMode: parent.approvalMode,
    ...(scopes.length > 0 ? { scopes } : {}),
  };
}

function presetTools(parent: ToolPolicyLike, role: ActiveWorkerRole): string[] {
  // M5.7 S4：implementer 另继承父策略里的 MCP 工具（外部写工具照样逐次审批）；其余角色不继承
  const inherited =
    role === "implementer"
      ? parent.allow.filter((tool) => tool.startsWith(`${MCP_TOOL_PREFIX}__`))
      : [];
  return [...ROLE_TOOLS[role], ...inherited];
}

// 给了清单：去重后逐件须是派出方能交出的工具，否则整次拒绝（不悄悄剔除，免得 worker 少了以为有的工具）
function checkedTools(parent: ToolPolicyLike, tools: readonly string[]): string[] {
  const unique = [...new Set(tools.map((tool) => tool.trim()))];
  if (unique.length === 0 || unique.includes("")) {
    throw new WorkerPolicyError("工具清单不能为空，也不能有空的工具名");
  }
  const delegable = delegableTools(parent);
  const outside = unique.filter((tool) => !delegable.includes(tool));
  if (outside.length > 0) {
    throw new WorkerPolicyError(
      `这些工具不能交给 worker：${outside.join("、")}（可选：${delegable.join("、")}）`
    );
  }
  return unique;
}

// 作用范围：每件工具至多一份，须是 worker 有的工具、种类与登记表（tool-scope.ts）对得上；派出方限定了的工具只能更窄，没另给即沿用派出方的。
// 范围路径不经符号链接（派出时查），"更窄"按字面包含即是按真实路径包含
function workerScopes(
  parent: ScopedPolicy,
  allow: readonly string[],
  given: readonly ToolScope[],
  root: string | undefined
): ToolScope[] {
  const inherited = parent.scopes ?? [];
  const seen = new Set<string>();
  const scopes: ToolScope[] = [];
  for (const scope of given) {
    if (seen.has(scope.tool)) {
      throw new WorkerPolicyError(`${scope.tool} 的作用范围给了不止一份`);
    }
    seen.add(scope.tool);
    if (!allow.includes(scope.tool)) {
      throw new WorkerPolicyError(`worker 没有 ${scope.tool}，不能给它作用范围`);
    }
    const normalized = normalizedScope(scope, root);
    const outer = inherited.find((candidate) => candidate.tool === scope.tool);
    if (outer !== undefined && !scopeWithin(normalized, outer)) {
      throw new WorkerPolicyError(`${scope.tool} 的作用范围不能比派出方的宽`);
    }
    scopes.push(normalized);
  }
  for (const outer of inherited) {
    if (allow.includes(outer.tool) && !seen.has(outer.tool)) {
      scopes.push(outer);
    }
  }
  return scopes;
}

function normalizedScope(scope: ToolScope, root: string | undefined): ToolScope {
  const { tool, paths, commandPrefixes } = scope;
  const kind = scopeKindOf(tool);
  if (kind === "commandPrefixes") {
    if (paths !== undefined || commandPrefixes === undefined || commandPrefixes.length === 0) {
      throw new WorkerPolicyError(`${tool} 的作用范围只能给 commandPrefixes`);
    }
    const prefixes = [...new Set(commandPrefixes.map((prefix) => prefix.trim()))];
    const bad = prefixes.find((prefix) => commandPrefixWords(prefix) === undefined);
    if (bad !== undefined) {
      throw new WorkerPolicyError(
        `命令前缀须是一条不经 shell 的命令的开头（不含管道、重定向、串联、命令替换或换行）：${bad}`
      );
    }
    return { tool, commandPrefixes: prefixes };
  }
  if (kind === "paths") {
    if (commandPrefixes !== undefined || paths === undefined || paths.length === 0) {
      throw new WorkerPolicyError(`${tool} 的作用范围只能给 paths`);
    }
    const normalized = paths.map((given) => ({ given, path: normalizeScopePath(given) }));
    const bad = normalized.find((entry) => entry.path === undefined);
    if (bad !== undefined) {
      throw new WorkerPolicyError(
        `作用范围的路径须相对 worker 工作树的根，不能用 .. 或绝对路径：${bad.given}`
      );
    }
    const unique = [...new Set(normalized.map((entry) => entry.path as string))];
    const linked = root !== undefined ? unique.map((dir) => scopePathLinkProblem(root, dir)) : [];
    const problem = linked.find((reason) => reason !== undefined);
    if (problem !== undefined) {
      throw new WorkerPolicyError(problem);
    }
    return { tool, paths: unique };
  }
  throw new WorkerPolicyError(
    `${tool} 不能附加作用范围（可以附加的：${Object.keys(SCOPABLE_TOOLS).join("、")}）`
  );
}

// 第二道校验（决策 040 修订）：子策略的 allow 必须全在父 allow 里且不碰父 deny；
// 决策 360：父策略限定了范围的工具，子策略须带不比它宽的范围
export function assertPolicySubset(child: ScopedPolicy, parent: ScopedPolicy): void {
  const widened = child.allow.filter(
    (tool) => !parent.allow.includes(tool) || parent.deny.includes(tool)
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
  const widenedScopes = (parent.scopes ?? []).filter((outer) => {
    if (!child.allow.includes(outer.tool)) return false;
    const inner = child.scopes?.find((scope) => scope.tool === outer.tool);
    return inner === undefined || !scopeWithin(inner, outer);
  });
  if (widenedScopes.length > 0) {
    throw new WorkerPolicyError(
      `worker 的作用范围超出父策略：${widenedScopes.map((scope) => scope.tool).join("、")}`
    );
  }
}
