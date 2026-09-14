// CLI trace 命令（M4 S3，D4 一次性渲染）：把会话（或单个 Run）的关联视图渲染为静态
// 人读报告打印 stdout，可 grep/less。只读纪律：只经 materializeSession 读事件文件——
// 不构造 JsonlEventLog（构造会建目录/开追加句柄）、不跑 recoverSession（会写确证记录）、
// 不触发 D8 旧账本迁移；trace 永不写事件日志与工作区。
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  approvalVerdict,
  breakerScopeLabel,
  describeContentGaps,
  failureBadge,
  shortId,
  summarizeArgs,
} from "../application/format.ts";
import { contentRecordLines, loadContentRecords } from "../application/history.ts";
import { JsonlEventLog, listSessionIds, materializeSession } from "../persistence/event-log.ts";
import type { ChildSettledRecord, SessionHeaderRecord } from "../state/event-log.ts";
import { asRunId, asSessionId, type RunId } from "../state/ids.ts";
import type { ChildLink } from "../state/materialize.ts";
import type { McpServerStatus, McpToolsetEntry } from "../state/mcp-toolset.ts";
import {
  buildSessionTrace,
  type SessionTrace,
  type TraceRun,
  type TraceToolCall,
} from "../state/trace.ts";

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

function renderToolCall(call: TraceToolCall, lines: string[]): void {
  lines.push(`    工具调用 ${call.toolCallId} [${call.toolName}]`);
  lines.push(
    call.proposed === undefined
      ? "      提议参数：<tool.proposed 事件缺失（证据缺口）>"
      : `      提议参数：${summarizeArgs(call.proposed.payload.args)}`
  );
  // 治理出处：intent（批准）或 decision（拒绝）；两者都没有时分两种如实呈现——
  // 执行成功且无任何治理记录 = 读层事件级调用（决策 1：读调用只留事件级，非异常）；
  // 其余 = 未过审批闸（上游拦截/事件落盘缺口）
  const governance = call.intent ?? call.decision;
  if (governance === undefined) {
    const eventLevelOnly = call.settled !== undefined && call.settled.payload.isError === false;
    lines.push(
      eventLevelOnly
        ? "      审批：事件级记录（读调用按决策 1 只留事件级，不落治理族）"
        : "      审批：无治理记录（未过审批闸——上游拦截或事件落盘缺口）"
    );
  } else {
    const decision = governance.decision;
    lines.push(
      `      审批：${approvalVerdict(decision)}（${decision.approvedBy}） ｜ ${shortId(governance.executionId)}`
    );
    // 拒绝理由逐字呈现（决策 4 证据链；也是 M6+ 蒸馏的负样本监督信号）
    if (decision.outcome === "rejected" && decision.reason !== undefined) {
      lines.push(`      拒绝理由：${decision.reason}`);
    }
  }
  // 哈希证据（D5 三方比对的两个静态端）：改前实测 → 预期改后
  const hashes = call.intent?.contentHashes;
  if (hashes !== undefined) {
    lines.push(
      `      哈希证据：改前 ${hashes.beforeHash} → 预期改后 ${hashes.expectedAfterHash}（${hashes.path}）`
    );
  }
  if (call.receipt !== undefined) {
    const receipt = call.receipt;
    const outcome = receipt.executed
      ? receipt.isError
        ? "已执行，有错误"
        : "已执行，无错误"
      : "未执行（副作用未发生）";
    let line = `      Receipt ${shortId(receipt.id)}：${outcome}`;
    if (receipt.contentAfterHash !== undefined) {
      const expected = call.intent?.contentHashes?.expectedAfterHash;
      const verdict =
        expected === undefined
          ? ""
          : receipt.contentAfterHash === expected
            ? "（与预期一致）"
            : "（与预期不符！）";
      line += `；实测改后 ${receipt.contentAfterHash}${verdict}`;
    }
    lines.push(line);
    // M5.5 S5（决策 048）：exec 证据——命令、退出码、输出哈希、文件变化
    const exec = receipt.exec;
    if (exec !== undefined) {
      lines.push(
        `      命令：${exec.command}${exec.alias !== undefined ? `（短名 ${exec.alias}）` : ""} ｜ ` +
          `退出码 ${exec.exitCode ?? "无"}${exec.timedOut ? "（超时终止）" : ""} ｜ ` +
          `输出 ${exec.outputBytes} 字节，哈希 ${exec.outputHash.slice(0, 12)}${exec.truncated ? "（落盘为截断输出）" : ""}`
      );
      lines.push(
        `      文件变化：新增 ${exec.fileChanges.added.length} / 删除 ${exec.fileChanges.removed.length} / ` +
          `修改 ${exec.fileChanges.modified.length}${exec.fileChanges.truncated ? "（文件过多，差异不完整）" : ""}`
      );
    }
  }
  if (call.resolution !== undefined) {
    const resolution = call.resolution;
    const outcome = resolution.outcome === "executed" ? "已执行" : "未执行";
    // M4 S5：人工确认渠道（resume 交互）无哈希证据——用户判断即证据
    lines.push(
      resolution.method === "human-confirmed"
        ? `      确证：人工确认${outcome}（resume 对账交互）`
        : `      确证：哈希自动确证${outcome}（实测现状 ${resolution.evidence?.observedHash ?? "证据缺失"}）`
    );
  }
  for (const breaker of call.breakers) {
    lines.push(
      `      熔断：本调用触发落闸（${breaker.scope}，连击 ${breaker.count}/${breaker.threshold}）`
    );
  }
  lines.push(`      分类：${failureBadge(call.classification?.failure)}`);
  if (call.pendingReconcile) {
    lines.push(
      "      待对账：intent 已落盘但无 Receipt（OutcomeUnknown，禁止盲重放，用 resume 处理）"
    );
  }
  for (const anomaly of call.anomalies) {
    lines.push(`      异常：${anomaly}`);
  }
}

// 带正文渲染选项（M5 S2，决策 045）：runId → 该 Run 按消息序的正文行；缺省 = 纯治理视图
export interface TraceRenderOptions {
  contentByRun?: ReadonlyMap<string, readonly string[]>;
  // M5.5 S4（决策 040）：worker 父子投影——会话头（本会话是 worker）、派出的 worker 与孤立 settled
  workers?: {
    header?: SessionHeaderRecord;
    children: readonly ChildLink[];
    orphanSettleds: readonly ChildSettledRecord[];
  };
}

// 派出的 worker 一行：已收尾给状态与结果并给进入命令；未收尾如实标注（进程中断可能），给 resume 入口
function renderChildLine({ spawned, settled }: ChildLink): string {
  const base = `  ${spawned.name}（${spawned.role}）｜ 会话 ${shortId(spawned.childSessionId)}`;
  if (settled === undefined) {
    return (
      `${base} ｜ 未收尾：有 child.spawned 无 child.settled（进程中断可能；` +
      `用 resume ${spawned.childSessionId} 进入该 worker 会话对账）`
    );
  }
  let line = `${base} ｜ ${settled.status} ｜ ${settled.turns} 轮`;
  if (settled.result !== undefined) {
    line += ` ｜ 改动 ${settled.result.changedFiles.length} 个文件 ｜ Receipt ${settled.result.receiptIds.length} 条`;
  }
  if (settled.error !== undefined) {
    line += ` ｜ 原因：${settled.error}`;
  }
  return `${line} ｜ 进入：trace ${spawned.childSessionId}`;
}

function renderRun(run: TraceRun, lines: string[], options: TraceRenderOptions = {}): void {
  const lastCompleted = [...run.turns].reverse().find((turn) => turn.completed !== undefined);
  const stopReason = lastCompleted?.completed?.payload.stopReason;
  let header =
    `Run ${shortId(run.runId)} ｜ 终态 stopReason=${stopReason ?? "无（turn.completed 缺失）"}` +
    ` ｜ 分类：${failureBadge(run.classification?.failure)}`;
  if (!run.ended) {
    header += " ｜ run.ended 缺失（崩溃残留可能）";
  }
  lines.push(header);
  // M5 S5（决策 044）：Run 启动快照摘要——回答"这个 Run 用的哪版模型、策略、工具、Memory 与 Skill"
  if (run.started !== undefined) {
    const payload = run.started.payload;
    const tools = payload.advertisedTools.length > 0 ? payload.advertisedTools.join("、") : "无";
    const injected = payload.memory.filter((entry) => entry.included).length;
    lines.push(
      `  启动快照：模型 ${payload.model.provider}/${payload.model.id} ｜ 审批模式 ${payload.policy.approvalMode} ｜ ` +
        `工具 ${tools} ｜ Memory ${payload.memory.length} 个（注入 ${injected}） ｜ Skill ${payload.skills.length} 个 ｜ ` +
        `system prompt ${payload.systemPromptHash.slice(0, 12)} ｜ 模型请求 ${run.llmRequestCount} 次`
    );
    // M5.7 S3（决策 052）：MCP 工具集里注解与配置冲突的工具、非连接状态的 server、清单变更通知
    const conflicts = (payload.mcpTools ?? []).filter((entry) => entry.conflict === true);
    if (conflicts.length > 0) {
      lines.push(`  MCP 工具集冲突：${conflicts.map(describeMcpConflict).join("、")}`);
    }
    for (const server of payload.mcpServers ?? []) {
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
  }
  // D2 冷侧缺口（M4 收口决策 ③）：撕裂尾巴与 entry 断号在 Run 头下如实标注，
  // 措辞与 replay 同口径——绝不假装证据链完整
  if (run.tornTail) {
    lines.push("  缺口：会话文件末尾存在半截未写完的记录（撕裂写，已按未持久化丢弃）");
  }
  if (run.entryGaps.length > 0) {
    lines.push(`  缺口：entry 映射断号，缺第 ${run.entryGaps.join("、")} 条（写盘失败留证缺口）`);
  }
  // M5 S1（决策 037）：entry 回指的正文缺失或哈希不符
  if (run.contentGaps.length > 0) {
    lines.push(`  缺口：${describeContentGaps(run.contentGaps)}`);
  }
  for (const anomaly of run.anomalies) {
    lines.push(`  异常：${anomaly}`);
  }
  for (const breaker of run.breakers) {
    lines.push(
      `  熔断落闸：${breaker.toolName}（${breakerScopeLabel(breaker.scope)}，` +
        `连击 ${breaker.count}/${breaker.threshold}，由 ${breaker.toolCallId} 触发）`
    );
  }
  for (const turn of run.turns) {
    const time =
      turn.started === undefined
        ? "时刻未知"
        : new Date(turn.started.timestamp).toISOString().slice(11, 19);
    let turnHeader = `  第 ${turn.index} 轮 ｜ ${time}(UTC)`;
    if (turn.completed !== undefined) {
      turnHeader += ` ｜ stopReason=${turn.completed.payload.stopReason}`;
      if (turn.completed.payload.syntheticFailure) {
        turnHeader += "（上游合成失败消息）";
      }
      // M5 S5（决策 044）：本轮 token 与成本（M5 前的记录无 usage 不显示）
      const usage = turn.completed.payload.usage;
      if (usage !== undefined) {
        turnHeader +=
          ` ｜ tokens 输入 ${usage.input} / 输出 ${usage.output} / 缓存读 ${usage.cacheRead} / ` +
          `缓存写 ${usage.cacheWrite} ｜ $${usage.cost.total.toFixed(4)}`;
      }
    } else {
      turnHeader += " ｜ turn.completed 缺失";
    }
    lines.push(turnHeader);
    for (const call of turn.toolCalls) {
      renderToolCall(call, lines);
    }
  }
  const content = options.contentByRun?.get(run.runId);
  if (content !== undefined && content.length > 0) {
    lines.push("  正文（按消息序）：");
    for (const text of content) {
      lines.push(`    正文：${text}`);
    }
  }
}

export function renderSessionTrace(trace: SessionTrace, options: TraceRenderOptions = {}): string {
  const toolCallCount = trace.runs.reduce((sum, run) => sum + run.toolCalls.length, 0);
  const pendingCount = trace.runs.reduce(
    (sum, run) => sum + run.toolCalls.filter((call) => call.pendingReconcile).length,
    0
  );
  // 落盘缺口总数（决策 ③）：撕裂尾巴按处计（至多 1）+ 各 Run 缺失的 entry 条数
  const unfinishedCount = trace.runs.filter((run) => !run.ended).length;
  const gapCount =
    (trace.tornTail ? 1 : 0) +
    trace.runs.reduce((sum, run) => sum + run.entryGaps.length + run.contentGaps.length, 0);
  const lines: string[] = [
    `会话 ${shortId(trace.sessionId)} ｜ Run ${trace.runs.length} 个 ｜ ` +
      `工具调用 ${toolCallCount} 次 ｜ 待对账 ${pendingCount} 次 ｜ 落盘缺口 ${gapCount} 处` +
      // 崩溃残留与落盘缺口分开计：前者是循环没跑完，后者是写盘失败（M4 验收 O-1）
      (unfinishedCount > 0 ? ` ｜ 崩溃残留 ${unfinishedCount} 个 Run` : ""),
    "",
  ];
  const workers = options.workers;
  if (workers?.header !== undefined) {
    const header = workers.header;
    lines.splice(
      1,
      0,
      `worker 会话：${header.worker.name}（${header.worker.role}）｜ 分支 ${header.workspace.branch} ｜ ` +
        `父会话 ${header.parentSessionId}（查看：trace ${header.parentSessionId}）`
    );
  }
  if (workers !== undefined && workers.children.length > 0) {
    lines.push(`派出的 worker（${workers.children.length}）：`);
    for (const child of workers.children) {
      lines.push(renderChildLine(child));
    }
    lines.push("");
  }
  // 撕裂尾巴无 Run 归属（末条记录是 REPL 期 grant 事件，或 --run 过滤掉了拥有者）：会话级标注
  if (trace.tornTail && !trace.runs.some((run) => run.tornTail)) {
    lines.push(
      "会话级缺口：会话文件末尾存在半截未写完的记录（撕裂写，已按未持久化丢弃；不归属任何 Run 时间线）"
    );
    lines.push("");
  }
  for (const [index, run] of trace.runs.entries()) {
    if (index > 0) {
      lines.push("");
    }
    renderRun(run, lines, options);
  }
  // 会话级异常项：孤儿记录如实报告（日志损坏或手写），不猜测挂接
  const orphanSettleds = options.workers?.orphanSettleds ?? [];
  if (
    trace.orphanReceipts.length > 0 ||
    trace.orphanResolutions.length > 0 ||
    orphanSettleds.length > 0
  ) {
    lines.push("");
    lines.push("异常项：");
    for (const { receipt, runId } of trace.orphanReceipts) {
      lines.push(
        `  孤儿 Receipt ${shortId(receipt.id)}（Run ${shortId(runId)}，` +
          `executionId ${shortId(receipt.executionId)} 无对应 intent/decision）`
      );
    }
    for (const resolution of trace.orphanResolutions) {
      lines.push(
        `  孤儿 Resolution（Run ${shortId(resolution.runId)}，` +
          `executionId ${shortId(resolution.executionId)} 无对应 intent）`
      );
    }
    for (const settled of orphanSettleds) {
      lines.push(
        `  孤立 child.settled：${settled.name}（会话 ${shortId(settled.childSessionId)}）无对应 child.spawned`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface TraceCommandOptions {
  // 工作区根（事件日志在 <root>/.pigeon/sessions/）
  root: string;
  sessionId: string;
  runId?: string;
  // M5 S2（决策 045）：带正文（默认关）
  withContent?: boolean;
}

// 按 Run 聚合正文行（entry 落盘序）：措辞与 TUI 历史投影同一份（application/history.ts）
function contentByRunOf(
  root: string,
  sessionId: string,
  entries: ReadonlyArray<{ id: string; runId: string; contentHash?: string }>
): Map<string, string[]> {
  const records = loadContentRecords(root, sessionId);
  const byRun = new Map<string, string[]>();
  for (const entry of entries) {
    const record = records.get(entry.id);
    if (record === undefined) {
      continue;
    }
    const lines = byRun.get(entry.runId) ?? [];
    lines.push(...contentRecordLines(record).map((line) => line.text));
    byRun.set(entry.runId, lines);
  }
  return byRun;
}

// 只读渲染入口：会话不存在/Run 不存在时响亮报错并列出可选项，绝不静默产出空报告
export function runTraceCommand(options: TraceCommandOptions): string {
  const sessionsDir = join(options.root, ".pigeon", "sessions");
  const sessionId = asSessionId(options.sessionId);
  if (!existsSync(JsonlEventLog.filePathFor(sessionsDir, sessionId))) {
    const available = listSessionIds(sessionsDir);
    throw new Error(
      `会话不存在：${options.sessionId}` +
        (available.length > 0 ? `。已有会话：${available.join("、")}` : "（尚无会话记录）")
    );
  }
  const materialized = materializeSession(sessionsDir, sessionId);
  const renderOptions: TraceRenderOptions = {
    // M5.5 S4（决策 040）：从主会话可进入 worker 会话；worker 会话回指父会话
    workers: {
      ...(materialized.sessionHeader !== undefined ? { header: materialized.sessionHeader } : {}),
      children: materialized.children,
      orphanSettleds: materialized.orphanChildSettleds,
    },
    ...(options.withContent === true
      ? { contentByRun: contentByRunOf(options.root, sessionId, materialized.entries) }
      : {}),
  };
  if (options.runId === undefined) {
    return renderSessionTrace(buildSessionTrace(materialized), renderOptions);
  }
  const runId: RunId = asRunId(options.runId);
  const trace = buildSessionTrace(materialized, { runId });
  if (trace.runs.length === 0) {
    const known = [...new Set(materialized.records.map((record) => record.runId as string))];
    throw new Error(`该会话无 Run ${options.runId}。已有 Run：${known.join("、")}`);
  }
  return renderSessionTrace(trace, renderOptions);
}
