// 单次运行的过程指标（决策 061）：从会话账本（事件日志加内容文件）汇总——各工具的调用数与报错数（按 tool.settled 计，
// 被上游拦截、没有执行的调用同样落定并计入）、撞输出上限的轮数（turn.completed 的 stopReason 为 length）、
// 编辑报错分类计数。runner 写结果行与复算既有运行的过程指标用同一个函数。
// 编辑报错分类按 toolResult 报错文案的稳定前缀判定；前缀与两个编辑工具的抛错处共用同一批导出常量
// （tools/edit-mode.ts、tools/hashline.ts、tools/replace-edit.ts），工具文案改动会同步到这里而非静默落"其他"：
//   两种模式共用——输出上限截断：`Tool call "edit_file" was not executed: the response hit the output token limit`；
//     无变化：`编辑没有产生任何实际变化`；
//   hashline——参数校验失败：`Validation failed for tool "edit_file"`；锚点未命中：`edits[i] 的 anchor|endAnchor 未命中`；
//     行号越界：`edits[i] 的 anchor|endAnchor 越界`；
//   replace——原文未找到：`未找到 old_string`；原文不唯一：`old_string 不唯一`；
//   其余（含内容文件里找不到报错正文的调用）归"其他"。
import {
  JsonlEventLog,
  materializeSession,
  readMessageContentFileDetailed,
} from "../persistence/event-log.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import { stepRunsOf } from "../state/repair-step.ts";
import { EDIT_NO_CHANGE_PREFIX, type EditMode } from "../tools/edit-mode.ts";
import { HASHLINE_ANCHOR_MISS_MARK, HASHLINE_OUT_OF_RANGE_MARK } from "../tools/hashline.ts";
import { REPLACE_NOT_FOUND_PREFIX, REPLACE_NOT_UNIQUE_PREFIX } from "../tools/replace-edit.ts";

export interface ToolCallCounts {
  calls: number;
  errors: number;
}

export interface ProcessMetrics {
  // 工具名 → 调用数与报错数
  tools: Record<string, ToolCallCounts>;
  outputLimitTurns: number;
  // 编辑报错类目 → 次数（本模式的全部类目都在，缺省 0）
  editErrors: Record<string, number>;
}

export const EDIT_TOOL_NAME = "edit_file";

export const EDIT_ERROR_CATEGORIES: Readonly<Record<EditMode, readonly string[]>> = {
  hashline: ["schema", "anchor-miss", "line-out-of-range", "no-change", "output-limit", "other"],
  replace: ["not-found", "not-unique", "no-change", "output-limit", "other"],
};

export const EDIT_ERROR_LABELS: Readonly<Record<string, string>> = {
  schema: "参数校验失败",
  "anchor-miss": "锚点未命中",
  "line-out-of-range": "行号越界",
  "not-found": "原文未找到",
  "not-unique": "原文不唯一",
  "no-change": "无变化",
  "output-limit": "输出上限截断",
  other: "其他",
};

const OUTPUT_LIMIT_PREFIX = `Tool call "${EDIT_TOOL_NAME}" was not executed: the response hit the output token limit`;
// hashline 的锚点类报错文案由抛错处模板生成，判据用同一批常量拼回：edits[i] 的 anchor|endAnchor <标记>
const ANCHOR_MISS_PATTERN = new RegExp(
  `^edits\\[\\d+\\] 的 (?:anchor|endAnchor) ${HASHLINE_ANCHOR_MISS_MARK}`
);
const OUT_OF_RANGE_PATTERN = new RegExp(
  `^edits\\[\\d+\\] 的 (?:anchor|endAnchor) ${HASHLINE_OUT_OF_RANGE_MARK}`
);

export function classifyEditError(mode: EditMode, text: string): string {
  const message = text.trimStart();
  if (message.startsWith(OUTPUT_LIMIT_PREFIX)) {
    return "output-limit";
  }
  if (message.startsWith(EDIT_NO_CHANGE_PREFIX)) {
    return "no-change";
  }
  if (mode === "hashline") {
    if (message.startsWith(`Validation failed for tool "${EDIT_TOOL_NAME}"`)) {
      return "schema";
    }
    if (ANCHOR_MISS_PATTERN.test(message)) {
      return "anchor-miss";
    }
    if (OUT_OF_RANGE_PATTERN.test(message)) {
      return "line-out-of-range";
    }
    return "other";
  }
  if (message.startsWith(REPLACE_NOT_FOUND_PREFIX)) {
    return "not-found";
  }
  if (message.startsWith(REPLACE_NOT_UNIQUE_PREFIX)) {
    return "not-unique";
  }
  return "other";
}

export function emptyProcessMetrics(mode: EditMode): ProcessMetrics {
  return {
    tools: {},
    outputLimitTurns: 0,
    editErrors: Object.fromEntries(EDIT_ERROR_CATEGORIES[mode].map((category) => [category, 0])),
  };
}

export interface SummarizeProcessInput {
  sessionsDir: string;
  sessionId: SessionId;
  // 缺省取会话里首个 Run
  runId?: RunId;
  editMode: EditMode;
}

export function summarizeProcess(input: SummarizeProcessInput): ProcessMetrics {
  const metrics = emptyProcessMetrics(input.editMode);
  const session = materializeSession(input.sessionsDir, input.sessionId, { content: false });
  const runId = input.runId ?? session.runStarteds[0]?.runId ?? session.runtimeEvents[0]?.runId;
  if (runId === undefined) {
    return metrics;
  }
  // 回炉（决策 142 / 143）：一步跨若干个 Run，过程指标按整步汇总
  const stepRuns = new Set(stepRunsOf(session, runId));
  const errorText = new Map<string, string>();
  const content = readMessageContentFileDetailed(
    JsonlEventLog.contentFilePathFor(input.sessionsDir, input.sessionId)
  );
  for (const record of content.records) {
    if (
      stepRuns.has(record.runId) &&
      record.role === "toolResult" &&
      record.toolCallId !== undefined
    ) {
      errorText.set(
        record.toolCallId,
        record.blocks.map((block) => (block.type === "text" ? block.text : "")).join("")
      );
    }
  }
  for (const record of session.runtimeEvents) {
    if (!stepRuns.has(record.runId)) {
      continue;
    }
    if (record.kind === "turn.completed" && record.payload.stopReason === "length") {
      metrics.outputLimitTurns += 1;
    } else if (record.kind === "tool.settled") {
      const { toolName, toolCallId, isError } = record.payload;
      const counts = metrics.tools[toolName] ?? { calls: 0, errors: 0 };
      counts.calls += 1;
      if (isError) {
        counts.errors += 1;
        if (toolName === EDIT_TOOL_NAME) {
          const category = classifyEditError(input.editMode, errorText.get(toolCallId) ?? "");
          metrics.editErrors[category] = (metrics.editErrors[category] ?? 0) + 1;
        }
      }
      metrics.tools[toolName] = counts;
    }
  }
  return metrics;
}
