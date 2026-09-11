// CLI replay 命令（M4 S4，D4 一次性渲染）：把单个 Run 的只读重建时间线渲染为静态人读
// 报告打印 stdout，可 grep/less，无交互步进。语义锁定：只读重建（黑匣子回放），
// 绝不重新执行真实副作用（ROADMAP §M4 完成证据）——不构造 JsonlEventLog（构造会建目录/
// 开追加句柄）、不跑 recoverSession（会写确证记录）、不构造 Agent、不调 streamFn、
// 不执行任何工具；唯一事实源是 materializeSession（与 trace 同一投影源，§3.5）。
// 与 trace 的区别：trace 是「链式分组治理视图」（按工具调用聚合全链证据）；
// replay 是原始时间流——该 Run 的全部事件日志记录按落盘顺序逐条呈现，异常原位标注。
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type EventRecord,
  JsonlEventLog,
  listSessionIds,
  type MaterializedSession,
  materializeSession,
} from "../persistence/event-log.ts";
import {
  buildRunReplay,
  type ReplayEvent,
  type RunReplay,
} from "../persistence/replay.ts";
import { failureBadge } from "../persistence/trace.ts";
import { asRunId, asSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { approvalVerdict, breakerScopeLabel, shortId, summarizeArgs } from "./format.ts";

// 毫秒时间戳（UTC）：HH:MM:SS.mmm——时间线是黑匣子回放，毫秒序对崩溃分析有意义
function timeOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 23);
}

const ERROR_KIND_LABEL: Record<string, string> = {
  domain: "工具域错误",
  environment: "环境异常",
};

// 单条记录的关键字段摘要（kind 各自的要点，人话）
function recordDetail(record: EventRecord): string {
  switch (record.kind) {
    case "turn.started":
      return "轮次开始";
    case "turn.completed": {
      let detail = `轮次结束 stopReason=${record.payload.stopReason}`;
      if (record.payload.syntheticFailure) {
        detail += "（上游合成失败消息）";
      }
      if (record.payload.errorMessage !== undefined) {
        detail += ` ｜ ${record.payload.errorMessage}`;
      }
      return detail;
    }
    case "tool.proposed":
      return `工具提议 ${record.payload.toolName}（${record.payload.toolCallId}）参数 ${summarizeArgs(record.payload.args)}`;
    case "tool.settled": {
      const payload = record.payload;
      let detail = `工具落定 ${payload.toolName}（${payload.toolCallId}）${payload.isError ? "失败" : "成功"}`;
      if (payload.errorKind !== undefined) {
        detail += ` ｜ 错误归类：${ERROR_KIND_LABEL[payload.errorKind] ?? payload.errorKind}`;
      }
      return detail;
    }
    case "run.ended":
      return `Run 结束（新增消息 ${record.payload.messageCount} 条）`;
    case "intent": {
      let detail =
        `意图落账 ${shortId(record.executionId)} ｜ ${record.toolName}（${record.toolCallId}）｜ ` +
        `审批：${approvalVerdict(record.decision)}（${record.decision.approvedBy}）`;
      const hashes = record.contentHashes;
      if (hashes !== undefined) {
        detail += ` ｜ 哈希：改前 ${hashes.beforeHash} → 预期改后 ${hashes.expectedAfterHash}`;
      }
      return detail;
    }
    case "decision": {
      // 拒绝理由逐字呈现（决策 4 证据链）
      let detail =
        `拒绝落账 ${shortId(record.executionId)} ｜ ${record.toolName}（${record.toolCallId}）｜ ` +
        `${approvalVerdict(record.decision)}（${record.decision.approvedBy}）`;
      if (record.decision.reason !== undefined) {
        detail += ` ｜ 理由：${record.decision.reason}`;
      }
      return detail;
    }
    case "receipt": {
      const receipt = record.receipt;
      const outcome = receipt.executed
        ? receipt.isError
          ? "已执行，有错误"
          : "已执行，无错误"
        : "未执行（副作用未发生）";
      // toolCallId 一并渲染：它是时间线上与 proposed/intent 原位对齐的关联键
      let detail =
        `Receipt 落账 ${shortId(receipt.id)} ｜ ${shortId(receipt.executionId)}` +
        `（${receipt.toolCallId}）：${outcome}`;
      if (receipt.contentAfterHash !== undefined) {
        detail += ` ｜ 实测改后 ${receipt.contentAfterHash}`;
      }
      return detail;
    }
    case "breaker":
      return (
        `熔断落闸：${record.toolName}（${breakerScopeLabel(record.scope)}，` +
        `连击 ${record.count}/${record.threshold}，由 ${record.toolCallId} 触发）`
      );
    case "resolution":
      return (
        `确证落账：${shortId(record.executionId)} 哈希自动确证` +
        `${record.outcome === "executed" ? "已执行" : "未执行"}（实测现状 ${record.evidence.observedHash}）`
      );
  }
}

function renderEvent(event: ReplayEvent, lines: string[]): void {
  lines.push(`${timeOf(event.record.timestamp)} ${event.record.kind} ｜ ${recordDetail(event.record)}`);
  for (const annotation of event.annotations) {
    lines.push(`  标注：${annotation}`);
  }
}

// 一次性静态渲染（D4：无交互步进，测试为输出文本比对）
export function renderRunReplay(replay: RunReplay): string {
  // 终态：run.ended 是否在场 + 末条 turn.completed 的 stopReason（与 trace 运行头同口径）
  const lastCompleted = [...replay.events]
    .reverse()
    .find((event) => event.record.kind === "turn.completed");
  const stopReason =
    lastCompleted?.record.kind === "turn.completed"
      ? lastCompleted.record.payload.stopReason
      : undefined;
  const terminal = replay.ended
    ? `run.ended 在场，stopReason=${stopReason ?? "无（turn.completed 缺失）"}`
    : "run.ended 缺失";
  const lines: string[] = [
    `回放 Run ${shortId(replay.runId)} ｜ 会话 ${shortId(replay.sessionId)} ｜ ` +
      `事件 ${replay.events.length} 条 ｜ 终态：${terminal} ｜ ` +
      `分类：${failureBadge(replay.classification?.failure)}`,
    "",
  ];
  for (const event of replay.events) {
    renderEvent(event, lines);
  }
  // 崩溃残留与撕裂尾巴：人话标注，绝不假装证据链完整（D2 可见化）
  if (!replay.ended) {
    lines.push("记录到此中断（崩溃可能）：本 Run 无 run.ended 事件");
  }
  if (replay.tornTail) {
    lines.push("会话文件末尾存在半截未写完的记录（撕裂写，已按未持久化丢弃）");
  }
  return `${lines.join("\n")}\n`;
}

export interface ReplayCommandOptions {
  // 工作区根（事件日志在 <root>/.pigeon/sessions/）
  root: string;
  runId: string;
  // 缺省时跨会话扫描定位 Run；歧义（同 runId 出现在多个会话）响亮失败要求消歧
  sessionId?: string;
}

function renderSession(materialized: MaterializedSession, runId: RunId): string | null {
  const replay = buildRunReplay(materialized, runId);
  return replay === null ? null : renderRunReplay(replay);
}

// 只读渲染入口：Run/会话不存在或歧义时响亮报错并列出可选项，绝不静默产出空报告
export function runReplayCommand(options: ReplayCommandOptions): string {
  const sessionsDir = join(options.root, ".pigeon", "sessions");
  const runId = asRunId(options.runId);
  if (options.sessionId !== undefined) {
    const sessionId: SessionId = asSessionId(options.sessionId);
    if (!existsSync(JsonlEventLog.filePathFor(sessionsDir, sessionId))) {
      const available = listSessionIds(sessionsDir);
      throw new Error(
        `会话不存在：${options.sessionId}` +
          (available.length > 0 ? `。已有会话：${available.join("、")}` : "（尚无会话记录）")
      );
    }
    const materialized = materializeSession(sessionsDir, sessionId);
    const rendered = renderSession(materialized, runId);
    if (rendered === null) {
      const known = [...new Set(materialized.records.map((record) => record.runId as string))];
      throw new Error(
        `该会话无 Run ${options.runId}` +
          (known.length > 0 ? `。已有 Run：${known.join("、")}` : "（该会话无任何记录）")
      );
    }
    return rendered;
  }
  // 未指定会话：扫全部会话文件定位 Run（每个会话一次冷物化，与 trace 同一只读路径）
  const sessionIds = listSessionIds(sessionsDir);
  const hits: Array<{ sessionId: SessionId; rendered: string }> = [];
  const knownRuns: string[] = [];
  for (const sessionId of sessionIds) {
    const materialized = materializeSession(sessionsDir, sessionId);
    for (const known of new Set(materialized.records.map((record) => record.runId as string))) {
      knownRuns.push(`${known}（会话 ${sessionId}）`);
    }
    const rendered = renderSession(materialized, runId);
    if (rendered !== null) {
      hits.push({ sessionId, rendered });
    }
  }
  if (hits.length === 0) {
    throw new Error(
      `Run 不存在：${options.runId}` +
        (knownRuns.length > 0 ? `。已有 Run：${knownRuns.join("、")}` : "（尚无会话记录）")
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `Run ${options.runId} 出现在多个会话：${hits.map((hit) => hit.sessionId as string).join("、")}。` +
        "请用 --session 指定会话消歧"
    );
  }
  return hits[0]?.rendered as string;
}
