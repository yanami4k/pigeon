// Reviewer 的两个只读工具（M6 S1，决策 064 子裁决 ⑤）：
//   - review_snapshot：读被审那一次 Run 的冻结快照（对话增量、工具调用、Receipt 摘要）；
//   - review_entry：按条目号回查该 Run 内一条消息的完整原文（快照里被截断或丢弃的内容由此回查）。
// 作用域在装配时绑定（会话号、Run 号、审阅起点）：参数里没有会话或 Run 入口，跨 Run 与跨会话一律读不到。
// 快照在第一次读取时构建并冻结，之后同一审阅内的读取返回同一份内容，主会话此后的写入不影响它。
// 两个工具都是 read 档：不触碰工作区文件、不写任何东西。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  readMessageContentFileDetailed,
  sessionContentFilePath,
} from "../persistence/session-read.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import { REVIEW_ENTRY_TOOL, REVIEW_SNAPSHOT_TOOL } from "../state/review.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import { buildRunSnapshot, type RunSnapshot } from "./snapshot.ts";

// 域错误（模型给了本 Run 里不存在的条目号）：带归类标记，tools/error-kind.ts 读标记归 domain
export class ReviewToolError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

export const ReviewSnapshotParamsSchema = Type.Object({});
export const ReviewEntryParamsSchema = Type.Object({
  runSeq: Type.Integer({ minimum: 1 }),
});
export type ReviewEntryParams = Static<typeof ReviewEntryParamsSchema>;

export interface ReviewScope {
  sessionsDir: string;
  sessionId: SessionId;
  runId: RunId;
  // 上次审阅点（条目号）；首次审阅缺省
  sinceRunSeq?: number;
}

function textOf(parts: readonly string[]): PigeonToolResult<undefined> {
  return { content: [{ type: "text", text: parts.join("\n") }], details: undefined };
}

// 快照 → 模型读的文本：条目号恒在场，截断与丢弃如实标注
export function renderRunSnapshot(snapshot: RunSnapshot): string {
  const lines = [
    `被审运行：会话 ${snapshot.sessionId} ｜ ${snapshot.runId} ｜ 已完成 ${snapshot.turns} 轮`,
    snapshot.sinceRunSeq !== undefined
      ? `本次只含第 ${snapshot.sinceRunSeq} 条之后的增量（另带少量前情）`
      : "本次含该 Run 的全部条目",
  ];
  if (snapshot.omittedEntries > 0) {
    lines.push(
      `（最早的 ${snapshot.omittedEntries} 条已省略，共 ${snapshot.omittedChars} 字符；需要时用 ${REVIEW_ENTRY_TOOL} 按条目号回查）`
    );
  }
  lines.push("--- 对话 ---");
  for (const entry of snapshot.entries) {
    const tool =
      entry.toolName !== undefined
        ? `（${entry.toolName}${entry.isError === true ? "，出错" : ""}）`
        : "";
    const stored = entry.storedTruncated ? "（落盘时已截断）" : "";
    lines.push(`[第 ${entry.runSeq} 条 ${entry.role}${tool}]${stored}`, entry.text);
  }
  lines.push(`--- 工具调用（${snapshot.toolCalls.length}）---`);
  for (const call of snapshot.toolCalls) {
    const outcome =
      call.settled === undefined ? "未落定" : call.settled.payload.isError ? "出错" : "成功";
    const decision =
      call.decision !== undefined
        ? `，拒绝：${call.decision.decision.reason ?? "无理由"}`
        : call.intent !== undefined
          ? `，批准（${call.intent.decision.approvedBy}）`
          : "";
    lines.push(`- ${call.toolName}（${call.toolCallId}）：${outcome}${decision}`);
  }
  lines.push(`--- Receipt（${snapshot.receipts.length}）---`);
  for (const receipt of snapshot.receipts) {
    lines.push(
      `- ${receipt.toolCallId}：${receipt.executed ? (receipt.isError ? "已执行，有错误" : "已执行") : "未执行"} ｜ ${receipt.summary}`
    );
  }
  return lines.join("\n");
}

export function createReviewTools(
  scope: ReviewScope
): Array<
  PigeonAgentTool<typeof ReviewSnapshotParamsSchema | typeof ReviewEntryParamsSchema, undefined>
> {
  // 冻结：第一次读取时构建，之后复用同一份
  let frozen: string | undefined;
  const snapshotTool: PigeonAgentTool<typeof ReviewSnapshotParamsSchema, undefined> = {
    name: REVIEW_SNAPSHOT_TOOL,
    label: REVIEW_SNAPSHOT_TOOL,
    description:
      "读取被审的那一次运行的冻结快照：对话增量（带条目号）、工具调用与审批结果、Receipt 摘要。" +
      "被截断或省略的内容用 review_entry 按条目号回查原文。",
    parameters: ReviewSnapshotParamsSchema,
    executionMode: "parallel",
    async execute(): Promise<PigeonToolResult<undefined>> {
      frozen ??= renderRunSnapshot(buildRunSnapshot(scope));
      return textOf([frozen]);
    },
  };
  const entryTool: PigeonAgentTool<typeof ReviewEntryParamsSchema, undefined> = {
    name: REVIEW_ENTRY_TOOL,
    label: REVIEW_ENTRY_TOOL,
    description:
      "按条目号读取被审运行里一条消息的完整原文（快照里被截断或省略的内容由此回查）。只能读本次被审的运行。",
    parameters: ReviewEntryParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<undefined>> {
      const { runSeq } = Value.Parse(ReviewEntryParamsSchema, params);
      // 作用域：只读被审会话的内容文件，且只认被审 Run 的记录
      const record = readMessageContentFileDetailed(
        sessionContentFilePath(scope.sessionsDir, scope.sessionId)
      ).records.findLast((item) => item.runId === scope.runId && item.runSeq === runSeq);
      if (record === undefined) {
        throw new ReviewToolError(`被审运行里没有第 ${runSeq} 条（条目号应来自 review_snapshot）`);
      }
      const body = record.blocks.map((block) => {
        switch (block.type) {
          case "text":
            return `${block.text}${block.truncated ? "（落盘时已截断）" : ""}`;
          case "thinking":
            return block.omitted === true
              ? "[thinking 未持久化]"
              : block.redacted === true
                ? "[thinking 已被 provider 编辑]"
                : `[thinking] ${block.thinking}`;
          case "toolCall":
            return `[toolCall] ${block.name}`;
          case "image":
            return `[image] ${block.mimeType} ${block.bytes} 字节`;
          default:
            return `[未知块 ${block.originalType}]`;
        }
      });
      const tool = record.toolName !== undefined ? `（${record.toolName}）` : "";
      return textOf([`[第 ${record.runSeq} 条 ${record.role}${tool}]`, ...body]);
    },
  };
  return [snapshotTool, entryTool] as Array<
    PigeonAgentTool<typeof ReviewSnapshotParamsSchema | typeof ReviewEntryParamsSchema, undefined>
  >;
}

// 装配根注册用的元数据：两个工具都是 read 档，不触碰文件系统路径参数
export function reviewToolRegistrations(): ToolRegistration[] {
  const base = {
    tier: "read" as const,
    pathConfinement: { kind: "none" as const },
    executionMode: "parallel" as const,
  };
  return [
    {
      name: REVIEW_SNAPSHOT_TOOL,
      description: "读取被审运行的冻结快照",
      parameters: ReviewSnapshotParamsSchema,
      ...base,
    },
    {
      name: REVIEW_ENTRY_TOOL,
      description: "按条目号回查被审运行的原文",
      parameters: ReviewEntryParamsSchema,
      ...base,
    },
  ];
}
