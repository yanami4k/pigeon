// CLI trace 命令（M4 S3，D4 一次性渲染）：把会话（或单个 Run）的关联视图渲染为静态人读报告打印 stdout，可 grep/less。
// 读新会话存储（决策 180 / 181）：经只读读取器读会话文件、投影成原生视图（state/session-view.ts），从不写文件——
// 读的可能是别的进程正在追加的会话。一轮 = 一条助手消息 + 它发起的工具调用，工具调用按调用号与结果消息配对。
// 旧视图里的审批、回执、确证、熔断记录、待对账与落盘缺口随这些记录停写（184）与断号诊断去掉（181）不再呈现。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { evalVerdictLabel, failureBadge, shortId, summarizeArgs } from "../application/format.ts";
import { messageLines } from "../application/history.ts";
import {
  hasLegacyEventFile,
  listSessionRefs,
  loadSessionView,
} from "../persistence/session-catalog.ts";
import { isGitWorktreeWorkspace } from "../state/event-log.ts";
import type { McpServerStatus, McpToolsetEntry } from "../state/mcp-toolset.ts";
import type {
  SessionView,
  ViewChild,
  ViewItem,
  ViewRun,
  ViewToolCall,
} from "../state/session-view.ts";
import { isSyntheticFailure } from "../state/session-view.ts";

const MCP_SERVER_STATE_LABEL: Readonly<Record<McpServerStatus["state"], string>> = {
  idle: "未启动",
  connected: "已连接",
  restarting: "重启中",
  unavailable: "不可用",
  closed: "已关闭",
};

// 冲突项：声明 destructive 却配 read 的按 write；其余冲突是声明只读却配 write / exec，按配置
function describeMcpConflict(entry: McpToolsetEntry): string {
  const declared =
    entry.declaredHint?.destructiveHint === true && entry.configuredTier === "read"
      ? "声明 destructive"
      : "声明只读";
  return `${entry.name}（${declared}，配置 ${entry.configuredTier}，按 ${entry.effectiveTier}）`;
}

type CheckpointItem = Extract<ViewItem, { kind: "checkpoint" }>;

function renderToolCall(
  call: ViewToolCall,
  checkpoints: ReadonlyMap<string, CheckpointItem>,
  lines: string[]
): void {
  lines.push(`    工具调用 ${call.toolCallId} [${call.toolName}]`);
  lines.push(`      提议参数：${summarizeArgs(call.arguments)}`);
  const result = call.result;
  lines.push(
    result === undefined
      ? "      结果：无结果消息（进程中断可能）"
      : `      结果：${result.isError === true ? "出错" : "成功"}`
  );
  const checkpoint = checkpoints.get(call.toolCallId);
  if (checkpoint !== undefined) {
    lines.push(`      代码快照：${checkpoint.data.commit.slice(0, 12)}（${checkpoint.data.ref}）`);
  }
}

// 带正文渲染选项（M5 S2，决策 045）：缺省 = 不带正文
export interface TraceRenderOptions {
  withContent?: boolean;
}

// 派出的 worker 一行：已收尾给状态与结果并给进入命令；未收尾如实标注（进程中断可能），给 resume 入口
function renderChildLine({ spawned, settled }: ViewChild): string {
  const base = `  ${spawned.name}（${spawned.role}）｜ 会话 ${shortId(spawned.childSessionId)}`;
  if (settled === undefined) {
    return (
      `${base} ｜ 未收尾：有派出无收尾（进程中断可能；` +
      `用 resume ${spawned.childSessionId} 进入该 worker 会话）`
    );
  }
  let line = `${base} ｜ ${settled.status} ｜ ${settled.turns} 轮`;
  if (settled.result !== undefined) {
    line += ` ｜ 改动 ${(settled.result.changedFiles ?? []).length} 个文件`;
  }
  if (settled.error !== undefined) {
    line += ` ｜ 原因：${settled.error}`;
  }
  return `${line} ｜ 进入：trace ${spawned.childSessionId}`;
}

function runStopReason(run: ViewRun): string | undefined {
  return run.end?.stopReason ?? run.turns.at(-1)?.assistant.stopReason;
}

function renderRun(
  sessionId: string,
  run: ViewRun,
  lines: string[],
  options: TraceRenderOptions
): void {
  let header =
    `Run ${shortId(run.runId)} ｜ 终态 stopReason=${runStopReason(run) ?? "无（无助手消息）"}` +
    ` ｜ 分类：${failureBadge(run.failure)}`;
  if (run.end === undefined) {
    header += " ｜ Run 收尾缺失（崩溃残留可能）";
  }
  lines.push(header);
  // M5 S5（决策 044）：Run 启动快照摘要——回答"这个 Run 用的哪版模型、策略、工具、Memory 与 Skill"
  const start = run.start;
  const tools = start.advertisedTools.length > 0 ? start.advertisedTools.join("、") : "无";
  const injected = start.memory.filter((entry) => entry.included).length;
  const systemPromptHash = createHash("sha256").update(start.systemPrompt).digest("hex");
  lines.push(
    `  启动快照：模型 ${start.model.provider}/${start.model.id} ｜ 审批模式 ${start.policy.approvalMode} ｜ ` +
      `工具 ${tools} ｜ Memory ${start.memory.length} 个（注入 ${injected}） ｜ Skill ${start.skills.length} 个 ｜ ` +
      `system prompt ${systemPromptHash.slice(0, 12)} ｜ 模型请求 ${run.turns.length} 次`
  );
  // M5.7 S3（决策 052）：MCP 工具集里注解与配置冲突的工具、非连接状态的 server、清单变更通知
  const conflicts = (start.mcpTools ?? []).filter((entry) => entry.conflict === true);
  if (conflicts.length > 0) {
    lines.push(`  MCP 工具集冲突：${conflicts.map(describeMcpConflict).join("、")}`);
  }
  for (const server of start.mcpServers ?? []) {
    if (server.state !== "connected") {
      lines.push(
        `  MCP server ${server.name} ${MCP_SERVER_STATE_LABEL[server.state]}（重启 ${server.restarts} 次` +
          `${server.error !== undefined ? `：${server.error}` : ""}）`
      );
    }
    for (const [list, label] of [
      ["tools", "工具"],
      ["prompts", "prompts "],
    ] as const) {
      const count = (server.listChanges ?? []).filter((change) => change.list === list).length;
      if (count > 0) {
        lines.push(
          `  MCP server ${server.name} 发来${label}清单变更通知 ${count} 次（本会话不变，下个会话生效）`
        );
      }
    }
  }
  if (run.end !== undefined) {
    lines.push(`  结束方式：${run.end.ending}（消息 ${run.end.messageCount} 条）`);
  }
  // 验证记录（071）：回答"这次跑的验证结论是什么、凭哪条命令"
  const checkpoints = new Map<string, CheckpointItem>();
  for (const item of run.items) {
    if (item.kind === "checkpoint") {
      checkpoints.set(item.data.toolCallId, item);
    } else if (item.kind === "verification") {
      const data = item.data;
      // 工具故障的步（决策 170 ③）单列：检查工具自身崩溃、重跑一次仍崩溃，不计入这条验证的结论
      const faulted = (data.steps ?? []).filter((step) => step.toolFault === true);
      lines.push(
        `  验证：${evalVerdictLabel(data.verdict)} ｜ 退出码 ${data.exitCode ?? "无"}${data.timedOut ? "（超时）" : ""} ｜ ` +
          `命令 ${data.command.join(" ")} ｜ ${data.durationMs} 毫秒` +
          (faulted.length > 0
            ? ` ｜ 工具故障（不计入结论）：${faulted.map((step) => step.name).join("、")}`
            : "") +
          (data.target.runId !== run.runId || data.target.sessionId !== sessionId
            ? ` ｜ 目标 会话 ${shortId(data.target.sessionId)} Run ${shortId(data.target.runId)}`
            : "")
      );
    }
  }
  for (const turn of run.turns) {
    const assistant = turn.assistant;
    let turnHeader =
      `  第 ${turn.index} 轮 ｜ ${new Date(assistant.timestamp).toISOString().slice(11, 19)}(UTC)` +
      ` ｜ stopReason=${assistant.stopReason ?? "无"}`;
    if (isSyntheticFailure(assistant)) {
      turnHeader += "（上游合成失败消息）";
    }
    // M5 S5（决策 044）：本轮 token 与成本
    const usage = assistant.usage;
    if (usage !== undefined) {
      turnHeader +=
        ` ｜ tokens 输入 ${usage.input} / 输出 ${usage.output} / 缓存读 ${usage.cacheRead} / ` +
        `缓存写 ${usage.cacheWrite} ｜ $${usage.cost.total.toFixed(4)}`;
    }
    lines.push(turnHeader);
    for (const call of turn.toolCalls) {
      renderToolCall(call, checkpoints, lines);
    }
  }
  if (options.withContent === true) {
    const content = run.messages.flatMap((message) => messageLines(message));
    if (content.length > 0) {
      lines.push("  正文（按消息序）：");
      for (const line of content) {
        lines.push(`    正文：${line.text}`);
      }
    }
  }
}

export function renderSessionTrace(
  view: SessionView,
  runs: readonly ViewRun[],
  options: TraceRenderOptions = {}
): string {
  const toolCallCount = runs.reduce((sum, run) => sum + run.toolCalls.length, 0);
  const unfinishedCount = runs.filter((run) => run.end === undefined).length;
  const lines: string[] = [
    `会话 ${shortId(view.sessionId)} ｜ Run ${runs.length} 个 ｜ 工具调用 ${toolCallCount} 次` +
      (unfinishedCount > 0 ? ` ｜ 崩溃残留 ${unfinishedCount} 个 Run` : ""),
  ];
  if (view.worker !== undefined && view.parentSessionId !== undefined) {
    const worker = view.worker;
    lines.push(
      `worker 会话：${worker.name}（${worker.role}）｜ ` +
        `${isGitWorktreeWorkspace(worker.workspace) ? `分支 ${worker.workspace.branch}` : "无工作区"} ｜ ` +
        `父会话 ${view.parentSessionId}（查看：trace ${view.parentSessionId}）`
    );
  }
  if (view.branch !== undefined) {
    const branch = view.branch;
    lines.push(
      `分支会话：来源会话 ${branch.sourceSessionId} Run ${shortId(branch.forkPoint.runId)} 第 ${branch.forkPoint.runSeq} 条 ｜ ` +
        `分支 ${branch.workspace.branch} ｜ ${branch.trigger === "manual" ? "手动" : "失败自动重试"}`
    );
  }
  lines.push("");
  if (view.children.length > 0) {
    lines.push(`派出的 worker（${view.children.length}）：`);
    for (const child of view.children) {
      lines.push(renderChildLine(child));
    }
    lines.push("");
  }
  for (const [index, run] of runs.entries()) {
    if (index > 0) {
      lines.push("");
    }
    renderRun(view.sessionId, run, lines, options);
  }
  // 会话级异常项：孤立的收尾、读取时跳过的行与条目如实报告，不猜测挂接
  if (view.orphanSettleds.length > 0 || view.warnings.length > 0) {
    lines.push("");
    lines.push("异常项：");
    for (const settled of view.orphanSettleds) {
      lines.push(
        `  孤立的 worker 收尾：${settled.name}（会话 ${shortId(settled.childSessionId)}）无对应派出`
      );
    }
    for (const warning of view.warnings) {
      lines.push(`  读取告警：${warning}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// 会话在新存储里找不到时的报错：双写之前的旧会话单独说明，其余列出已有会话
export function missingSessionError(sessionsDir: string, sessionId: string): Error {
  if (hasLegacyEventFile(sessionsDir, sessionId)) {
    return new Error(
      `会话 ${sessionId} 创建于新会话存储启用之前，只在旧账本里（用迁移前的只读旧版查看）`
    );
  }
  const available = listSessionRefs(sessionsDir).map((ref) => ref.sessionId);
  return new Error(
    `会话不存在：${sessionId}` +
      (available.length > 0 ? `。已有会话：${available.join("、")}` : "（尚无会话记录）")
  );
}

export interface TraceCommandOptions {
  // 工作区根（会话在 <root>/.pigeon/sessions/）
  root: string;
  sessionId: string;
  runId?: string;
  // M5 S2（决策 045）：带正文（默认关）
  withContent?: boolean;
}

// 只读渲染入口：会话不存在/Run 不存在时响亮报错并列出可选项，绝不静默产出空报告
export function runTraceCommand(options: TraceCommandOptions): string {
  const sessionsDir = join(options.root, ".pigeon", "sessions");
  const view = loadSessionView(sessionsDir, options.sessionId);
  if (view === undefined) {
    throw missingSessionError(sessionsDir, options.sessionId);
  }
  const renderOptions: TraceRenderOptions = { withContent: options.withContent === true };
  if (options.runId === undefined) {
    return renderSessionTrace(view, view.runs, renderOptions);
  }
  const runs = view.runs.filter((run) => run.runId === options.runId);
  if (runs.length === 0) {
    throw new Error(
      `该会话无 Run ${options.runId}。已有 Run：${view.runs.map((run) => run.runId).join("、")}`
    );
  }
  return renderSessionTrace(view, runs, renderOptions);
}
