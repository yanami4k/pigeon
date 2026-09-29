// 脚本派出的 worker 的审批（决策 302、303 的脚本部分）："本次脚本内同类都允许"。
// 同类的口径：
// - 跑命令：程序名加第一个子命令词（npm test、git status）；第二个词像路径或参数（含 / 或 .，或以 - 开头）即只取程序名
//   （pytest a.py 取 pytest）。命令需经 shell，或含管道、重定向、串联与命令替换的符号时不给同类（一条放行的命令后面可以接任何
//   东西）。
// - 高危程序不提供整批放行，照常逐次请示：命令里任一词的程序名在高危名单里，或以高危的两词命令开头。
// - 网络档：同一网站。其余工具：同一工具加同一目录（调用带 path 时），无路径即同一工具。
// 放行只在同一次脚本运行内生效，脚本结束即失效；其余照 303（汇到主会话、写明 worker、超时或无人值守即可恢复交回、事后补批）。
import path from "node:path";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "../approvals/handler.ts";

// 高危程序（单词）与两词命令：不提供"本次脚本内同类都允许"
export const SCRIPT_KIND_DENY_PROGRAMS: readonly string[] = [
  "rm",
  "sudo",
  "su",
  "chmod",
  "chown",
  "dd",
  "mkfs",
  "curl",
  "wget",
  "ssh",
  "scp",
];
export const SCRIPT_KIND_DENY_COMMANDS: readonly string[] = ["git push", "git reset", "git clean"];

// 同类的键与给人看的描述
export interface ScriptApprovalKind {
  key: string;
  text: string;
}

const SHELL_SYNTAX = /[|&;<>`$(){}\n]/;

function programOf(word: string): string {
  // mkfs.ext4 之类按 mkfs 算
  const base = path.posix.basename(word.replace(/\\/g, "/"));
  return base.split(".")[0] ?? base;
}

function commandKind(command: string, needsShell: boolean): ScriptApprovalKind | undefined {
  const trimmed = command.trim();
  if (trimmed === "" || needsShell || SHELL_SYNTAX.test(trimmed)) return undefined;
  const words = trimmed.split(/\s+/);
  if (words.some((word) => SCRIPT_KIND_DENY_PROGRAMS.includes(programOf(word)))) return undefined;
  const program = programOf(words[0] ?? "");
  const second = words[1];
  const head =
    second !== undefined && /^[A-Za-z][\w:-]*$/.test(second) ? `${program} ${second}` : program;
  if (SCRIPT_KIND_DENY_COMMANDS.some((deny) => head === deny || head.startsWith(`${deny} `))) {
    return undefined;
  }
  return { key: `command\n${head}`, text: `跑命令 ${head}` };
}

// 一个请求的同类；高危或说不清的给 undefined（面板不提供 [s]）
export function scriptApprovalKind(request: ApprovalRequest): ScriptApprovalKind | undefined {
  const args = request.args as { command?: unknown; path?: unknown } | undefined;
  if (request.command !== undefined || typeof args?.command === "string") {
    return commandKind(request.command ?? String(args?.command ?? ""), request.needsShell === true);
  }
  if (request.host !== undefined) {
    return { key: `host\n${request.host}`, text: `访问网站 ${request.host}` };
  }
  if (typeof args?.path === "string" && args.path !== "") {
    const dir = path.posix.dirname(args.path.replace(/\\/g, "/"));
    return {
      key: `tool\n${request.toolName}\n${dir}`,
      text: `用 ${request.toolName} 处理 ${dir === "." ? "工作区根目录" : `${dir}/`} 下的文件`,
    };
  }
  return { key: `tool\n${request.toolName}`, text: `调用 ${request.toolName}` };
}

// 脚本运行的一面：查运行是否在场、脚本名，记下与判定放行的同类
export interface ScriptKindRegistry {
  title(runId: string): string | undefined;
  allows(runId: string, key: string): boolean;
  allow(runId: string, key: string): void;
}

// 包在汇聚审批入口外面：脚本派出的 worker 的请求——同类已放行即直接批准；否则补上脚本名与同类交给人，人选了同类都允许即记下
export function wrapScriptApprovals(
  handler: ApprovalHandler,
  registry: () => ScriptKindRegistry | undefined
): ApprovalHandler {
  return async (request): Promise<ApprovalDecision> => {
    const runId = request.script?.runId;
    const runs = registry();
    const title = runId !== undefined ? runs?.title(runId) : undefined;
    if (runId === undefined || runs === undefined || title === undefined) {
      return handler(request);
    }
    const kind = scriptApprovalKind(request);
    if (kind !== undefined && runs.allows(runId, kind.key)) {
      return { approved: true };
    }
    const decision = await handler({
      ...request,
      script: { runId, title, ...(kind !== undefined ? { kind: kind.text } : {}) },
    });
    if (decision.approved && decision.scope === "script-kind" && kind !== undefined) {
      runs.allow(runId, kind.key);
    }
    return decision;
  };
}
