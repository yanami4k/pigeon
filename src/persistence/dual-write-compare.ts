// 双写对照（决策 180 / 206）：给定一次运行（一个会话），用只读读取器读新存储、用现有物化读旧账本，逐项比对两边的对应关系，
// 输出差异清单。读者分段改读新存储时以它确认"同一次运行的新旧记录说的是同一件事"。本段覆盖四项：
// - 消息：条数、顺序、角色、所属 Run 与 Run 内序号；正文用旧账本自己的抽取口径（同样的截断与思考持久化选项）处理新存储里的
//   完整消息，算出的内容哈希须与旧条目回指的哈希逐字一致；
// - Run 开始：Run 的先后与配置各字段，新存储的系统提示全文按旧记录的系统提示哈希核对；
// - Run 收尾：有无收尾、结束方式（由旧账本的收尾事件、撞上限与熔断记录、末轮停止原因推出）、消息条数；
// - 验证记录：条数、顺序与各项结论。
// 其余几类条目（代码快照、worker、分叉、授权）留待改读对应读者时补上。本模块只读，不改任何文件。
import { isDeepStrictEqual } from "node:util";
import type { RunStartedRecord } from "../state/event-log.ts";
import {
  buildMessageContent,
  hashContentBlocks,
  type MessageContentOptions,
  sha256Hex,
} from "../state/message-content.ts";
import {
  type RunEndData,
  type RunEnding,
  type RunStartData,
  SessionEntryType,
  type VerificationData,
} from "../state/session-entries.ts";
import { omittedThinkingOf } from "../state/thinking-omission.ts";
import { materializeSession } from "./event-log.ts";
import {
  branchEntries,
  locateSessionFile,
  readSessionFile,
  type StoredEntry,
} from "./session-reader.ts";

export type CompareArea = "会话文件" | "消息" | "Run 开始" | "Run 收尾" | "验证记录";

export interface DualWriteDiff {
  area: CompareArea;
  // 哪一条（如"Run run_x 第 3 条消息"）
  where: string;
  detail: string;
}

export interface DualWriteComparison {
  sessionId: string;
  // 新存储里的会话文件（没有即 undefined）
  newPath?: string;
  // 比对过的条数
  counted: { messages: number; runs: number; verifications: number };
  diffs: DualWriteDiff[];
}

// Run 开始里逐项比对的配置字段（系统提示另按哈希核对）
const RUN_START_FIELDS = [
  "model",
  "policy",
  "advertisedTools",
  "taskDirective",
  "memory",
  "skills",
  "mcpTools",
  "mcpServers",
  "verify",
  "retryOnFail",
  "budget",
  "repairRounds",
] as const;

interface NewRun {
  start: RunStartData;
  end?: RunEndData;
  messages: StoredEntry[];
}

function customData<T>(entry: StoredEntry, customType: string): T | undefined {
  return entry.type === "custom" && entry.customType === customType ? (entry.data as T) : undefined;
}

// 新存储主分支按 Run 切段：Run 开始之后到下一个 Run 开始之前的消息属于它
function splitRuns(entries: readonly StoredEntry[]): { runs: NewRun[]; orphanMessages: number } {
  const runs: NewRun[] = [];
  let orphanMessages = 0;
  for (const entry of entries) {
    const start = customData<RunStartData>(entry, SessionEntryType.RunStart);
    if (start !== undefined) {
      runs.push({ start, messages: [] });
      continue;
    }
    const current = runs.at(-1);
    const end = customData<RunEndData>(entry, SessionEntryType.RunEnd);
    if (end !== undefined) {
      if (current !== undefined) {
        current.end = end;
      }
      continue;
    }
    if (entry.type === "message") {
      if (current === undefined) {
        orphanMessages += 1;
      } else {
        current.messages.push(entry);
      }
    }
  }
  return { runs, orphanMessages };
}

// 旧账本推出的结束方式：撞上限记录优先；确以中止收尾时有熔断记录即熔断；否则按末轮停止原因
function expectedEnding(input: {
  limit?: RunEnding;
  breaker: boolean;
  stopReason?: string;
}): RunEnding {
  if (input.limit !== undefined) {
    return input.limit;
  }
  switch (input.stopReason) {
    case "aborted":
      return input.breaker ? "breaker" : "aborted";
    case "stop":
    case "length":
    case "deferred":
      return "completed";
    default:
      return "error";
  }
}

function stepsOf(data: { steps?: ReadonlyArray<{ name: string; verdict: string }> }) {
  return data.steps?.map((step) => [step.name, step.verdict]);
}

export function compareDualWrite(input: {
  sessionsDir: string;
  sessionId: string;
  // 与该会话运行时旧账本的正文选项一致（思考是否持久化、单块上限）；缺省同运行面缺省
  content?: MessageContentOptions;
}): DualWriteComparison {
  const diffs: DualWriteDiff[] = [];
  const counted = { messages: 0, runs: 0, verifications: 0 };
  const old = materializeSession(input.sessionsDir, input.sessionId as never);
  const located = locateSessionFile(input.sessionsDir, input.sessionId);
  const view = located !== undefined ? readSessionFile(located.path) : undefined;
  if (located === undefined || view === undefined) {
    diffs.push({ area: "会话文件", where: input.sessionId, detail: "新存储里没有这个会话的文件" });
    return { sessionId: input.sessionId, counted, diffs };
  }
  for (const warning of view.warnings) {
    diffs.push({ area: "会话文件", where: located.path, detail: `读取告警：${warning}` });
  }
  const main = branchEntries(view, view.lanes.get("main") ?? null);
  // 分支会话的文件开头是从来源复制来的历史（分叉点及之前），旧账本的分支会话从空开始：跳过复制段
  const copied = old.branchHeader !== undefined ? copiedPrefix(main, old.runStarteds) : 0;
  const { runs, orphanMessages } = splitRuns(main.slice(copied));
  if (orphanMessages > 0) {
    diffs.push({
      area: "消息",
      where: "Run 之外",
      detail: `新存储有 ${orphanMessages} 条消息不在任何 Run 开始之后`,
    });
  }

  // Run 开始：先后与配置
  const oldRuns: RunStartedRecord[] = old.runStarteds;
  counted.runs = Math.max(oldRuns.length, runs.length);
  if (oldRuns.length !== runs.length) {
    diffs.push({
      area: "Run 开始",
      where: "全部",
      detail: `旧账本 ${oldRuns.length} 个 Run，新存储 ${runs.length} 个`,
    });
  }
  const newRunById = new Map(runs.map((run) => [run.start.runId as string, run]));
  oldRuns.forEach((record, index) => {
    const run = runs[index];
    const where = `Run ${record.runId}`;
    if (run === undefined || run.start.runId !== record.runId) {
      diffs.push({
        area: "Run 开始",
        where,
        detail: `第 ${index + 1} 个 Run 在新存储里是 ${run?.start.runId ?? "（缺）"}`,
      });
      return;
    }
    for (const field of RUN_START_FIELDS) {
      const before = (record.payload as Record<string, unknown>)[field];
      const after = (run.start as Record<string, unknown>)[field];
      if (!isDeepStrictEqual(before, after)) {
        diffs.push({
          area: "Run 开始",
          where,
          detail: `${field} 不一致：旧 ${JSON.stringify(before)}，新 ${JSON.stringify(after)}`,
        });
      }
    }
    if (sha256Hex(run.start.systemPrompt) !== record.payload.systemPromptHash) {
      diffs.push({ area: "Run 开始", where, detail: "系统提示全文与旧记录的哈希对不上" });
    }
  });

  // 消息：按 (runId, runSeq) 对应
  const oldContent = new Map<string, string | undefined>(
    old.entries.map((entry) => [entry.id as string, entry.contentHash])
  );
  const newMessageCount = runs.reduce((sum, run) => sum + run.messages.length, 0);
  counted.messages = Math.max(old.entries.length, newMessageCount);
  if (old.entries.length !== newMessageCount) {
    diffs.push({
      area: "消息",
      where: "全部",
      detail: `旧账本 ${old.entries.length} 条，新存储 ${newMessageCount} 条`,
    });
  }
  for (const entry of old.entries) {
    const where = `Run ${entry.runId} 第 ${entry.runSeq} 条消息`;
    const stored = newRunById.get(entry.runId)?.messages[entry.runSeq - 1];
    if (stored === undefined) {
      diffs.push({ area: "消息", where, detail: "新存储里没有对应消息" });
      continue;
    }
    const message = stored.message as { role?: string } | undefined;
    if (message?.role !== entry.role) {
      diffs.push({ area: "消息", where, detail: `角色：旧 ${entry.role}，新 ${message?.role}` });
      continue;
    }
    const expectedHash = oldContent.get(entry.id);
    if (expectedHash === undefined) {
      continue;
    }
    if (legacyContentHash(message, input.content ?? {}) !== expectedHash) {
      diffs.push({ area: "消息", where, detail: "按旧账本口径重算的正文哈希与旧条目回指不一致" });
    }
  }

  // Run 收尾：旧账本的收尾事件、撞上限、熔断与末轮停止原因
  const endedByRun = new Map<string, number>();
  const stopByRun = new Map<string, string>();
  for (const event of old.runtimeEvents) {
    if (event.kind === "run.ended") {
      endedByRun.set(event.runId, event.payload.messageCount);
    } else if (event.kind === "turn.completed") {
      stopByRun.set(event.runId, event.payload.stopReason);
    }
  }
  const limitByRun = new Map(old.limitHits.map((hit) => [hit.runId as string, hit.payload.limit]));
  const breakerRuns = new Set(old.breakers.map((breaker) => breaker.runId as string));
  for (const record of oldRuns) {
    const where = `Run ${record.runId}`;
    const run = newRunById.get(record.runId);
    const messageCount = endedByRun.get(record.runId);
    if (run === undefined) {
      continue;
    }
    if (messageCount === undefined) {
      if (run.end !== undefined) {
        diffs.push({ area: "Run 收尾", where, detail: "旧账本未收尾，新存储有收尾条目" });
      }
      continue;
    }
    if (run.end === undefined) {
      diffs.push({ area: "Run 收尾", where, detail: "旧账本已收尾，新存储缺收尾条目" });
      continue;
    }
    const limit = limitByRun.get(record.runId);
    const stopReason = stopByRun.get(record.runId);
    const expected = expectedEnding({
      ...(limit !== undefined ? { limit } : {}),
      breaker: breakerRuns.has(record.runId),
      ...(stopReason !== undefined ? { stopReason } : {}),
    });
    if (run.end.ending !== expected) {
      diffs.push({
        area: "Run 收尾",
        where,
        detail: `结束方式：按旧账本应为 ${expected}，新存储为 ${run.end.ending}`,
      });
    }
    if (run.end.messageCount !== messageCount) {
      diffs.push({
        area: "Run 收尾",
        where,
        detail: `消息条数：旧 ${messageCount}，新 ${run.end.messageCount}`,
      });
    }
  }

  // 验证记录：按落盘顺序
  const newVerifications = main.slice(copied).flatMap((entry) => {
    const data = customData<VerificationData>(entry, SessionEntryType.Verification);
    return data !== undefined ? [data] : [];
  });
  counted.verifications = Math.max(old.attemptVerifieds.length, newVerifications.length);
  if (old.attemptVerifieds.length !== newVerifications.length) {
    diffs.push({
      area: "验证记录",
      where: "全部",
      detail: `旧账本 ${old.attemptVerifieds.length} 条，新存储 ${newVerifications.length} 条`,
    });
  }
  old.attemptVerifieds.forEach((record, index) => {
    const data = newVerifications[index];
    if (data === undefined) {
      return;
    }
    const where = `第 ${index + 1} 条验证（Run ${record.target.runId}）`;
    const pairs: Array<[string, unknown, unknown]> = [
      ["target", record.target, data.target],
      ["runId", record.runId, data.runId],
      ["verdict", record.verdict, data.verdict],
      ["exitCode", record.exitCode, data.exitCode],
      ["command", record.command, data.command],
      ["outputHash", record.outputHash, data.outputHash],
      ["timedOut", record.timedOut, data.timedOut],
      ["workspace", record.workspace, data.workspace],
      ["steps", stepsOf(record), stepsOf(data)],
    ];
    for (const [field, before, after] of pairs) {
      if (!isDeepStrictEqual(before, after)) {
        diffs.push({
          area: "验证记录",
          where,
          detail: `${field} 不一致：旧 ${JSON.stringify(before)}，新 ${JSON.stringify(after)}`,
        });
      }
    }
  });

  return { sessionId: input.sessionId, newPath: located.path, counted, diffs };
}

// 按旧账本的抽取口径重算新存储消息的正文哈希。思考不持久化时新存储已剥去思考块、只留略去标记，
// 旧账本存的是正文为空、带字节数与全文哈希的略去块：按标记在原位置补回旧口径的块再算
function legacyContentHash(message: unknown, options: MessageContentOptions): string {
  const omitted = omittedThinkingOf(message as Record<string, unknown>);
  const rebuilt = buildMessageContent(message as never, options);
  if (omitted.length === 0) {
    return rebuilt.contentHash;
  }
  const blocks: unknown[] = [...rebuilt.blocks];
  for (const item of [...omitted].sort((a, b) => a.index - b.index)) {
    blocks.splice(Math.min(item.index, blocks.length), 0, {
      type: "thinking",
      thinking: "",
      truncated: false,
      omitted: true,
      bytes: item.bytes,
      fullHash: item.hash,
      ...(item.redacted === true ? { redacted: true } : {}),
    });
  }
  return hashContentBlocks(blocks as never);
}

// 分支文件开头从来源复制来的条目数：复制段止于分支自己的第一个 Run 开始（以旧账本里该分支的 Run 为准）
function copiedPrefix(main: readonly StoredEntry[], own: readonly RunStartedRecord[]): number {
  const ownRuns = new Set<string>(own.map((record) => record.runId));
  const first = main.findIndex((entry) => {
    const start = customData<RunStartData>(entry, SessionEntryType.RunStart);
    return start !== undefined && ownRuns.has(start.runId);
  });
  return first === -1 ? main.length : first;
}
