// 人工审批接口（ROADMAP §M3 + 决策 3：CLI REPL 内联审批，切片 4 实现 CLI）。
// Adapter 的 beforeToolCall 审批闸在策略判定为 prompt 时调用注入的 ApprovalHandler；
// 本文件只定义注入点，不含任何交互实现。
//
// 决策 1：审批动作只有批准/拒绝，无"人工改参数"——拒绝理由逐字反馈给模型（spike S2a），
// 让模型自我修正后重提，而不是人替模型修参数。
import { dirname } from "node:path";
import type { GrantId, RunId, SessionId } from "../state/ids.ts";
import type { ToolRiskTier } from "../tools/registry.ts";

export interface ApprovalRequest {
  readonly toolName: string;
  readonly toolCallId: string;
  // 模型原始参数（审批闸入场时的快照；批准后按原样执行，无改参通道）
  readonly args: unknown;
  // 写工具的执行前 diff 预览（工具实现 PreviewableTool 能力时提供）
  readonly diffPreview?: string;
  // 本次调用所在 Run（M4 S6：审批提示 [a]/[d] 创建会话 grant 时写入 grant.created
  // 事件的出处 run——grant 在 Run 内出生，runId 恒在场）
  readonly runId?: RunId;
  // M5.5（决策 040）：请求来源会话与 worker 标签——worker 的审批汇聚到父级面板时在场，
  // 面板据此区分来源；主会话自己的请求缺省
  readonly sessionId?: SessionId;
  readonly worker?: { readonly name: string; readonly role: string };
  // M5.5 S3（决策 040）：放权落点——[a]/[d] 创建的会话 grant 写进请求来源会话的存储。
  // worker 请求由其装配根挂上 worker 自己的存储（grant 只活在该 worker 会话内）；
  // 缺省 = 审批 handler 绑定的主会话存储
  readonly grants?: GrantCreator;
  // M5.5 S5（决策 048）：工具风险分层——exec 档的 [a] 收窄为这条一模一样的命令串
  readonly tier?: ToolRiskTier;
  // 048 修订：exec 调用将实际执行的命令串（短名已展开，面板原样显示，不做改写）与是否需经 shell
  readonly command?: string;
  readonly needsShell?: boolean;
}

// 会话 grant 的创建面（SessionGrantStore 满足）
export interface GrantCreator {
  create(input: {
    tool: string;
    pathPrefix?: string;
    command?: string;
    shell?: boolean;
    firstCall: { toolCallId: string; args: unknown };
    runId?: RunId;
  }): { grantId: GrantId; tool: string };
  // 能否建按目录限定的放权（缺省能）；日常沙箱的会话不能（决策 253），审批不提供 [d]
  readonly pathScoped?: boolean;
}

// 这次审批提供不提供 [d]（cli 与 tui 共用）：调用带 path 参数、不是 exec 档、放权落点能建目录限定的放权
export function offersDirectoryGrant(
  request: ApprovalRequest,
  grants: Pick<GrantCreator, "pathScoped"> | undefined
): boolean {
  return (
    request.tier !== "exec" &&
    extractPathArg(request.args) !== undefined &&
    grants?.pathScoped !== false
  );
}

export interface ApprovalDecision {
  readonly approved: boolean;
  // 拒绝时必填更佳：理由逐字成为模型可见的 error toolResult
  readonly reason?: string;
  // 理由来源（决策 066）：human = 人写（TUI [r]、CLI 输入了理由）；缺省时治理层按
  // 有无理由推定（有理由 = 人写，无理由 = 系统兜底文案），记入决定记录供学习侧区分
  readonly reasonSource?: "human" | "system-default";
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

// 调用的路径参数：grant 目录限定只认 args.path 字符串（与 tools/grants.ts 匹配口径一致）。
// cli 与 tui 两个审批 Actor 共用（M2 S3：单一约定，不各造一份）
export function extractPathArg(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("path" in args)) {
    return undefined;
  }
  const path: unknown = args.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

// exec 调用的命令串：精确命令放权只认 args.command 字符串（与 tools/grants.ts 匹配口径一致）
export function extractCommandArg(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("command" in args)) {
    return undefined;
  }
  const command: unknown = args.command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

// exec 审批面板的命令行（048 修订）：原样显示将执行的命令串，需 shell 时标明；非 exec 调用返回 undefined。
// 终端控制序列由各 Actor 的输出边界统一净化（036）
export function execCommandLine(request: ApprovalRequest): string | undefined {
  if (request.tier !== "exec") {
    return undefined;
  }
  const command = request.command ?? extractCommandArg(request.args);
  if (command === undefined) {
    return undefined;
  }
  return `命令${request.needsShell === true ? "（经 shell）" : ""}：${command}`;
}

// exec 档 [a] 键的提示文案（cli 与 tui 共用）
export function execGrantKeyLabel(request: ApprovalRequest): string {
  return request.needsShell === true
    ? "[a] 本会话允许这条命令（精确匹配，经 shell）"
    : "[a] 本会话允许这条命令（精确匹配）";
}

// 放权作用域（M5.5 S5，决策 048 及其修订）：exec 档 [a]/[d] 都收窄为这条一模一样的命令串（精确匹配，§3.9
// 第五条不动，没有目录限定），需 shell 的命令带 shell 标记；其余档 [a] 工具级、[d] 仅限当前调用所在目录
// （决策 3a，无 path 退化为工具级；不提供 [d] 的会话同样退化为工具级，决策 253）。null = exec 调用定位不到命令串，
// 不能创建放权。cli 与 tui 共用
export function grantScopeFor(
  request: ApprovalRequest,
  key: "a" | "d",
  grants?: Pick<GrantCreator, "pathScoped">
): { pathPrefix?: string; command?: string; shell?: boolean } | null {
  if (request.tier === "exec") {
    const command = extractCommandArg(request.args);
    if (command === undefined) {
      return null;
    }
    return request.needsShell === true ? { command, shell: true } : { command };
  }
  const pathArg = extractPathArg(request.args);
  return key === "d" && pathArg !== undefined && offersDirectoryGrant(request, grants)
    ? { pathPrefix: dirname(pathArg) }
    : {};
}

// 放权提示里的作用域后缀（cli 与 tui 共用）
export function commandScopeNote(scope: { command?: string; shell?: boolean }): string {
  if (scope.command === undefined) {
    return "";
  }
  return `，仅限命令 ${scope.command}${scope.shell === true ? "（经 shell）" : ""}`;
}
