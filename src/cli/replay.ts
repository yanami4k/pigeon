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
  approvalVerdict,
  breakerScopeLabel,
  describeContentGaps,
  failureBadge,
  shortId,
  summarizeArgs,
} from "../application/format.ts";
import { contentRecordLines, loadContentRecords } from "../application/history.ts";
import { JsonlEventLog, listSessionIds, materializeSession } from "../persistence/event-log.ts";
import type { EventRecord } from "../state/event-log.ts";
import { asRunId, asSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import type { MessageContentRecord } from "../state/message-content.ts";
import { buildRunReplay, type ReplayEvent, type RunReplay } from "../state/replay.ts";

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
    // M5 观察族（决策 043 / 044）：快照摘要、上下文指纹、Skill 读取留痕
    case "run.started": {
      const payload = record.payload;
      const tools = payload.advertisedTools.length > 0 ? payload.advertisedTools.join("、") : "无";
      return (
        `Run 启动快照 ｜ 模型 ${payload.model.provider}/${payload.model.id} ｜ ` +
        `审批模式 ${payload.policy.approvalMode} ｜ 工具 ${tools} ｜ ` +
        `Memory ${payload.memory.length} 个 ｜ Skill ${payload.skills.length} 个 ｜ ` +
        `system prompt ${payload.systemPromptHash.slice(0, 12)}`
      );
    }
    case "llm.request":
      return (
        `模型请求 ｜ 消息 ${record.payload.messageCount} 条 ｜ 约 ${record.payload.estimatedChars} 字符 ｜ ` +
        `上下文指纹 ${record.payload.messagesHash.slice(0, 12)}`
      );
    case "skill.loaded":
      return (
        `Skill 读取 ${record.payload.name}/${record.payload.resourcePath} ｜ ${record.payload.bytes} 字节` +
        `${record.payload.truncated ? "（已截断）" : ""} ｜ 哈希 ${record.payload.hash.slice(0, 12)}`
      );
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
      // M5.7 S3（决策 053）：MCP 回执摘要——参数与返回哈希、返回字节数与截断、server 证据
      const mcp = receipt.mcp;
      if (mcp !== undefined) {
        detail +=
          ` ｜ MCP ${mcp.server}/${mcp.tool}：参数 ${mcp.argsHash.slice(0, 12)} ｜ 返回 ${mcp.resultHash.slice(0, 12)}` +
          `（${mcp.resultBytes} 字节${mcp.truncated ? "，摘要截断" : ""}${mcp.isError ? "，server 报错" : ""}）`;
        if (mcp.serverEvidence !== undefined) {
          detail += ` ｜ server 证据 ${mcp.serverEvidence.hash.slice(0, 12)}${mcp.serverEvidence.truncated ? "（截断）" : ""}`;
        }
      }
      return detail;
    }
    case "breaker":
      return (
        `熔断落闸：${record.toolName}（${breakerScopeLabel(record.scope)}，` +
        `连击 ${record.count}/${record.threshold}，由 ${record.toolCallId} 触发）`
      );
    case "resolution": {
      const outcome = record.outcome === "executed" ? "已执行" : "未执行";
      // M4 S5：人工确认渠道（resume 交互）无哈希证据——用户判断即证据
      if (record.method === "human-confirmed") {
        return `确证落账：${shortId(record.executionId)} 人工确认${outcome}（resume 对账交互）`;
      }
      return (
        `确证落账：${shortId(record.executionId)} 哈希自动确证${outcome}` +
        `（实测现状 ${record.evidence?.observedHash ?? "证据缺失"}）`
      );
    }
    // M4 S5：entry 族（D3 映射行）——transcript 第 runSeq 条消息（本 run 内）获得 EntryId
    case "entry":
      return (
        `消息映射 ${shortId(record.id)}：run 内第 ${record.runSeq} 条（${record.role}）` +
        // M5 S1（决策 037）：正文回指哈希；缺省 = M5 前会话，无正文
        (record.contentHash !== undefined ? ` ｜ 正文 ${record.contentHash.slice(0, 12)}` : "")
      );
    // M4 S6：grant 族（决策 3）——放权/撤销留证，时间线原样呈现
    case "grant.created": {
      const scope =
        record.pathPrefix !== undefined ? `，仅限目录 ${record.pathPrefix}` : "（工具级）";
      return `放权创建 ${shortId(record.grantId)} ｜ ${record.tool}${scope} ｜ 首调 ${record.firstCall.toolCallId}`;
    }
    case "grant.revoked":
      return `放权撤销 ${shortId(record.grantId)}`;
    // M4 收口决策 ①：固化规则升格/移除留痕——配置面动作的时间线呈现
    case "grant.promoted": {
      const scope =
        record.pathPrefix !== undefined ? `，仅限目录 ${record.pathPrefix}` : "（工具级）";
      return `固化升格 ${shortId(record.grantId)} ｜ ${record.tool}${scope} → .pigeon/grants.json`;
    }
    case "grant.config-removed": {
      const scope =
        record.pathPrefix !== undefined ? `，仅限目录 ${record.pathPrefix}` : "（工具级）";
      return `固化移除 config#${record.index} ｜ ${record.tool}${scope} ｜ 出处 grant ${shortId(record.grantId)}`;
    }
    // M5.5 S2（决策 040）：worker 编排三族
    case "session.header":
      return (
        `worker 会话头 ｜ ${record.worker.name}（${record.worker.role}）｜ 父会话 ${shortId(record.parentSessionId)}` +
        (record.parentRunId !== undefined ? ` ｜ 父 Run ${shortId(record.parentRunId)}` : "") +
        ` ｜ 分支 ${record.workspace.branch}`
      );
    case "child.spawned": {
      const tools = record.policy.allow.length > 0 ? record.policy.allow.join("、") : "无";
      return (
        `派出 worker ${record.name}（${record.role}）｜ 会话 ${shortId(record.childSessionId)} ｜ ` +
        `分支 ${record.workspace.branch} ｜ 工具 ${tools} ｜ 审批模式 ${record.policy.approvalMode} ｜ ` +
        `上限 ${record.limits.maxTurns} 轮 / ${Math.round(record.limits.wallClockMs / 1000)} 秒`
      );
    }
    case "child.settled": {
      let detail = `worker 收尾 ${record.name} ｜ 会话 ${shortId(record.childSessionId)} ｜ ${record.status} ｜ ${record.turns} 轮`;
      if (record.error !== undefined) {
        detail += ` ｜ 原因：${record.error}`;
      }
      if (record.result !== undefined) {
        detail += ` ｜ 改动 ${record.result.changedFiles.length} 个文件，Receipt ${record.result.receiptIds.length} 条`;
      }
      return detail;
    }
  }
}

// 带正文渲染选项（M5 S2，决策 045）：entryId → 内容记录；缺省 = 纯治理时间线
export interface ReplayRenderOptions {
  content?: ReadonlyMap<string, MessageContentRecord>;
}

function renderEvent(event: ReplayEvent, lines: string[], options: ReplayRenderOptions): void {
  lines.push(
    `${timeOf(event.record.timestamp)} ${event.record.kind} ｜ ${recordDetail(event.record)}`
  );
  for (const annotation of event.annotations) {
    lines.push(`  标注：${annotation}`);
  }
  if (event.record.kind === "entry") {
    const record = options.content?.get(event.record.id);
    if (record !== undefined) {
      for (const line of contentRecordLines(record)) {
        lines.push(`  正文：${line.text}`);
      }
    }
  }
}

// 一次性静态渲染（D4：无交互步进，测试为输出文本比对）
export function renderRunReplay(replay: RunReplay, options: ReplayRenderOptions = {}): string {
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
    renderEvent(event, lines, options);
  }
  // 崩溃残留与撕裂尾巴：人话标注，绝不假装证据链完整（D2 可见化）
  if (!replay.ended) {
    lines.push("记录到此中断（崩溃可能）：本 Run 无 run.ended 事件");
  }
  if (replay.tornTail) {
    lines.push("会话文件末尾存在半截未写完的记录（撕裂写，已按未持久化丢弃）");
  }
  // entry 断号尾部汇总（决策 ③）：原位标注之外再给一行总账，grep 一次可见全部缺口
  if (replay.entryGaps.length > 0) {
    lines.push(
      `entry 映射断号：缺第 ${replay.entryGaps.join("、")} 条（写盘失败留证缺口，D3 序号不重排）`
    );
  }
  // M5 S1（决策 037）：正文缺口尾部总账（原位标注之外）
  if (replay.contentGaps.length > 0) {
    lines.push(describeContentGaps(replay.contentGaps));
  }
  return `${lines.join("\n")}\n`;
}

export interface ReplayCommandOptions {
  // 工作区根（事件日志在 <root>/.pigeon/sessions/）
  root: string;
  runId: string;
  // 缺省时跨会话扫描定位 Run；歧义（同 runId 出现在多个会话）响亮失败要求消歧
  sessionId?: string;
  // M5 S2（决策 045）：带正文（默认关）
  withContent?: boolean;
}

function renderSession(
  materialized: MaterializedSession,
  runId: RunId,
  root: string,
  withContent: boolean
): string | null {
  const replay = buildRunReplay(materialized, runId);
  if (replay === null) {
    return null;
  }
  return renderRunReplay(
    replay,
    withContent ? { content: loadContentRecords(root, materialized.sessionId) } : {}
  );
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
    const rendered = renderSession(materialized, runId, options.root, options.withContent === true);
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
    const rendered = renderSession(materialized, runId, options.root, options.withContent === true);
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
