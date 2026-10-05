// CLI replay 命令（M4 S4，D4 一次性渲染）：把单个 Run 的只读重建时间线渲染为静态人读报告打印 stdout，可 grep/less，
// 无交互步进。语义锁定：只读重建（黑匣子回放），绝不重新执行真实副作用（ROADMAP §M4 完成证据）——不构造 Agent、
// 不调 streamFn、不执行任何工具。读新会话存储（决策 180 / 181）：经只读读取器读会话文件、投影成原生视图
// （state/session-view.ts，与 trace 同一投影源），从不写文件。
// 与 trace 的区别：trace 按轮次与工具调用聚合；replay 是原始时间流——该 Run 的全部条目（Run 开始、消息、代码快照、
// 验证、worker、分叉、授权、Run 收尾）按会话文件里的顺序逐条呈现。
import { createHash } from "node:crypto";
import {
  continuationLine,
  evalVerdictLabel,
  failureBadge,
  pruneLine,
  repetitionLine,
  shortId,
  summarizeArgs,
} from "../application/format.ts";
import { messageLines } from "../application/history.ts";
import {
  listSessionRefs,
  loadSessionView,
  readSessionView,
} from "../persistence/session-catalog.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { workerWorkspaceLabel } from "../state/session-payloads.ts";
import {
  isSyntheticFailure,
  type SessionView,
  unfinishedCheckpointMarks,
  unfinishedCheckpointText,
  type ViewItem,
  type ViewRun,
} from "../state/session-view.ts";
import { missingSessionError } from "./trace.ts";

// 毫秒时间戳（UTC）：HH:MM:SS.mmm——时间线是黑匣子回放，毫秒序对崩溃分析有意义
function timeOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 23);
}

// 时间线上的条目类型名：消息为 message，自定义条目为它的 customType
const ITEM_TYPE: Record<ViewItem["kind"], string> = {
  message: "message",
  "run-start": "pigeon.run-start",
  "run-end": "pigeon.run-end",
  verification: "pigeon.verification",
  checkpoint: "pigeon.checkpoint",
  "checkpoint-mark": "pigeon.checkpoint-mark",
  worker: "pigeon.worker",
  fork: "pigeon.fork",
  grant: "pigeon.grant",
  hook: "pigeon.hook",
  continuation: "pigeon.continuation",
  repetition: "pigeon.repetition",
  prune: "pigeon.prune",
  "background-job": "pigeon.background-job",
};

// 单条条目的关键字段摘要（各类型的要点，通俗措辞）
function itemDetail(item: ViewItem): string {
  switch (item.kind) {
    case "run-start": {
      const data = item.data;
      const tools = data.advertisedTools.length > 0 ? data.advertisedTools.join("、") : "无";
      const hash = createHash("sha256").update(data.systemPrompt).digest("hex");
      return (
        `Run 启动快照 ｜ 模型 ${data.model.provider}/${data.model.id} ｜ ` +
        `审批模式 ${data.policy.approvalMode} ｜ 工具 ${tools} ｜ ` +
        `Memory ${data.memory.length} 个 ｜ Skill ${data.skills.length} 个 ｜ ` +
        `system prompt ${hash.slice(0, 12)}`
      );
    }
    case "message": {
      const message = item.message;
      let detail = `消息 ${message.entryId}：run 内第 ${message.runSeq} 条（${message.role}）`;
      if (message.role === "assistant") {
        detail += ` ｜ stopReason=${message.stopReason ?? "无"}`;
        if (isSyntheticFailure(message)) {
          detail += "（上游合成失败消息）";
        }
        if (message.errorMessage !== undefined) {
          detail += ` ｜ ${message.errorMessage}`;
        }
        for (const block of message.blocks) {
          if (block.type === "toolCall") {
            detail += ` ｜ 工具调用 ${block.name}（${block.id}）参数 ${summarizeArgs(block.arguments)}`;
          }
        }
      } else if (message.role === "toolResult") {
        detail +=
          ` ｜ 工具结果 ${message.toolName ?? "?"}（${message.toolCallId ?? "?"}）` +
          `${message.isError === true ? "失败" : "成功"}`;
      }
      return detail;
    }
    case "run-end": {
      const data = item.data;
      let detail = `Run 收尾 ｜ 结束方式 ${data.ending} ｜ 新增消息 ${data.messageCount} 条`;
      if (data.stopReason !== undefined) {
        detail += ` ｜ stopReason=${data.stopReason}`;
      }
      if (data.errorMessage !== undefined) {
        detail += ` ｜ ${data.errorMessage}`;
      }
      return detail;
    }
    case "verification": {
      const data = item.data;
      return (
        `尝试验证 ｜ 会话 ${shortId(data.target.sessionId)} Run ${shortId(data.target.runId)} ｜ ` +
        `${evalVerdictLabel(data.verdict)} ｜ 退出码 ${data.exitCode ?? "无"}${data.timedOut ? "（超时）" : ""} ｜ ` +
        `命令 ${data.command.join(" ")} ｜ ${data.durationMs} 毫秒`
      );
    }
    case "checkpoint":
      return `工作区快照 ${item.data.commit.slice(0, 12)} ｜ 工具调用 ${item.data.toolCallId}`;
    case "checkpoint-mark":
      return `${unfinishedCheckpointText(item.data)} ｜ 工具调用 ${item.data.toolCallId}`;
    case "worker": {
      const data = item.data;
      if (data.event === "spawned") {
        const tools = data.policy.allow.length > 0 ? data.policy.allow.join("、") : "无";
        return (
          `派出 worker ${data.name}（${data.role}）｜ 会话 ${shortId(data.childSessionId)} ｜ ` +
          `${workerWorkspaceLabel(data.workspace)} ｜ ` +
          `工具 ${tools} ｜ 审批模式 ${data.policy.approvalMode} ｜ ` +
          `上限 ${data.limits.maxTurns} 轮 / ${Math.round(data.limits.wallClockMs / 1000)} 秒`
        );
      }
      let detail = `worker 收尾 ${data.name} ｜ 会话 ${shortId(data.childSessionId)} ｜ ${data.status} ｜ ${data.turns} 轮`;
      if (data.error !== undefined) {
        detail += ` ｜ 原因：${data.error}`;
      }
      if (data.result !== undefined) {
        detail += ` ｜ 改动 ${(data.result.changedFiles ?? []).length} 个文件`;
      }
      return detail;
    }
    case "fork": {
      const data = item.data;
      return (
        `分叉 ｜ 分叉点 Run ${shortId(data.forkPoint.runId)} 第 ${data.forkPoint.runSeq} 条 ｜ ` +
        `分支会话 ${shortId(data.branchSessionId)} ｜ 快照 ${data.checkpoint.commit.slice(0, 12)} ｜ ` +
        `${data.trigger === "manual" ? "手动" : "失败自动重试"}`
      );
    }
    case "grant": {
      const data = item.data;
      if (data.event === "revoked") {
        return `放权撤销 ${shortId(data.grantId)}`;
      }
      const scope = data.pathPrefix !== undefined ? `，仅限目录 ${data.pathPrefix}` : "（工具级）";
      return `放权创建 ${shortId(data.grantId)} ｜ ${data.tool}${scope} ｜ 首调 ${data.firstCall.toolCallId}`;
    }
    case "hook": {
      const data = item.data;
      return (
        `钩子 ${data.event}${data.matcher !== undefined ? `（匹配 ${data.matcher}）` : ""} ｜ ${data.conclusion} ｜ ` +
        `退出码 ${data.exitCode ?? "无"}${data.timedOut ? "（超时）" : ""} ｜ ${data.durationMs} 毫秒 ｜ ` +
        `命令 ${data.command}`
      );
    }
    case "continuation":
      return continuationLine(item.data);
    case "repetition":
      return repetitionLine(item.data);
    case "prune":
      return pruneLine(item.data);
    case "background-job": {
      // 决策 365：后台作业的启动与结束
      const data = item.data;
      return data.event === "started"
        ? `后台作业启动 ｜ ${data.jobId} ｜ 命令 ${data.command}`
        : `后台作业结束 ｜ ${data.jobId} ｜ ${data.state}${data.reason !== undefined ? `（${data.reason}）` : ""} ｜ 退出码 ${data.exitCode ?? "无"} ｜ 输出 ${data.outputBytes} 字节`;
    }
  }
}

// 带正文渲染选项（M5 S2，决策 045）：缺省 = 不带正文
export interface ReplayRenderOptions {
  withContent?: boolean;
}

// 一次性静态渲染（D4：无交互步进，测试为输出文本比对）
export function renderRunReplay(
  view: SessionView,
  run: ViewRun,
  options: ReplayRenderOptions = {}
): string {
  const terminal =
    run.end === undefined
      ? "Run 收尾缺失"
      : `结束方式 ${run.end.ending}，stopReason=${run.end.stopReason ?? run.turns.at(-1)?.assistant.stopReason ?? "无（无助手消息）"}`;
  // 决策 350：拍摄标记只显示没拍成的（失败的、拍摄中断的各一行），拍成与文件没变的不占行
  const unfinished = unfinishedCheckpointMarks(run.items);
  const shown = run.items.filter(
    (item) => item.kind !== "checkpoint-mark" || unfinished.get(item.data.toolCallId) === item.data
  );
  const lines: string[] = [
    `回放 Run ${shortId(run.runId)} ｜ 会话 ${shortId(view.sessionId)} ｜ ` +
      `条目 ${shown.length} 条 ｜ 终态：${terminal} ｜ 分类：${failureBadge(run.failure)}`,
    "",
  ];
  for (const item of shown) {
    lines.push(`${timeOf(item.timestamp)} ${ITEM_TYPE[item.kind]} ｜ ${itemDetail(item)}`);
    if (options.withContent === true && item.kind === "message") {
      for (const line of messageLines(item.message)) {
        lines.push(`  正文：${line.text}`);
      }
    }
  }
  // 崩溃残留：通俗措辞标注，绝不假装记录完整
  if (run.end === undefined) {
    lines.push("记录到此中断（崩溃可能）：本 Run 无收尾条目");
  }
  return `${lines.join("\n")}\n`;
}

export interface ReplayCommandOptions {
  // 工作区根（会话在 <root>/.pigeon/state/sessions/）
  root: string;
  runId: string;
  // 缺省时跨会话扫描定位 Run；歧义（同 runId 出现在多个会话）响亮失败要求消歧
  sessionId?: string;
  // M5 S2（决策 045）：带正文（默认关）
  withContent?: boolean;
}

// 只读渲染入口：Run/会话不存在或歧义时响亮报错并列出可选项，绝不静默产出空报告
export function runReplayCommand(options: ReplayCommandOptions): string {
  const sessionsDir = sessionsDirOf(options.root);
  const renderOptions: ReplayRenderOptions = { withContent: options.withContent === true };
  if (options.sessionId !== undefined) {
    const view = loadSessionView(sessionsDir, options.sessionId);
    if (view === undefined) {
      throw missingSessionError(sessionsDir, options.sessionId);
    }
    const run = view.runs.find((item) => item.runId === options.runId);
    if (run === undefined) {
      const known = view.runs.map((item) => item.runId);
      throw new Error(
        `该会话无 Run ${options.runId}` +
          (known.length > 0 ? `。已有 Run：${known.join("、")}` : "（该会话无任何 Run）")
      );
    }
    return renderRunReplay(view, run, renderOptions);
  }
  // 未指定会话：扫全部会话文件定位 Run（每个会话读一次，与 trace 同一只读路径）
  const hits: Array<{ view: SessionView; run: ViewRun }> = [];
  const knownRuns: string[] = [];
  for (const ref of listSessionRefs(sessionsDir)) {
    const view = readSessionView(ref);
    if (view === undefined) {
      continue;
    }
    for (const run of view.runs) {
      knownRuns.push(`${run.runId}（会话 ${view.sessionId}）`);
      if (run.runId === options.runId) {
        hits.push({ view, run });
      }
    }
  }
  const [hit] = hits;
  if (hit === undefined) {
    throw new Error(
      `Run 不存在：${options.runId}` +
        (knownRuns.length > 0 ? `。已有 Run：${knownRuns.join("、")}` : "（尚无会话记录）")
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `Run ${options.runId} 出现在多个会话：${hits.map((item) => item.view.sessionId as string).join("、")}。` +
        "请用 --session 指定会话消歧"
    );
  }
  return renderRunReplay(hit.view, hit.run, renderOptions);
}
