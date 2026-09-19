// 会话树（M7 S6，决策 068 / 077；ROADMAP §M7"会话树读取只允许出现在 PiRuntimeAdapter 所在层"）：以上游 pi-agent-core 0.84.4
// 的 Session / JsonlSessionRepo 为存储、buildSessionContext 为上下文还原基础。Pigeon Event Log 是唯一权威事实源，
// 树是派生缓存：可删、可由账本与内容文件重建，不 fsync（上游写入本就不 fsync）。
// - 布局：每个根会话一个树文件，放治理根 .pigeon/trees/（上游按 cwd 编码子目录）；树会话号即根会话号；
// - 通道：根会话走 main 通道；分支会话在分叉条目上建以分支会话号命名的通道；树条目号即账本条目号；
// - 投影：树里的消息由账本投影而来——正文取内容文件，助手消息的停止原因、用量与错误取同一 Run 内对应次序的
//   turn.completed，工具调用参数取 tool.proposed，模型身份取 run.started。写穿与重建共用本投影，结果逐条一致；
//   落盘时已截断或未持久化的内容如实缺失（思考块签名不入账，未持久化与被编辑的思考块不进消息，图片只留占位文字）。
import path from "node:path";
import {
  type AgentMessage,
  buildSessionContext,
  JsonlSessionRepo,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { EventRecord } from "../state/event-log.ts";
import type { MessageContentRecord } from "../state/message-content.ts";
import type { TurnUsage } from "../state/runtime-events.ts";

export const TREE_MAIN_LANE = "main";

export interface LedgerMessageFacts {
  model: { provider: string; id: string };
  // 工具调用号 → 模型给出的参数（tool.proposed）
  toolArgs: ReadonlyMap<string, unknown>;
  // 对应轮次的 turn.completed；该轮没有收尾记录时缺省
  stopReason?: string;
  usage?: TurnUsage;
  errorMessage?: string;
}

const ZERO_USAGE: TurnUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Block = MessageContentRecord["blocks"][number];

function textOf(block: Block): string | undefined {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `[image ${block.mimeType} ${block.bytes} 字节，原图未持久化]`;
    case "unknown":
      return `[未知块 ${block.originalType}]`;
    default:
      return undefined;
  }
}

export function projectLedgerMessage(
  record: MessageContentRecord,
  facts: LedgerMessageFacts
): AgentMessage {
  if (record.role === "assistant") {
    const content: unknown[] = [];
    for (const block of record.blocks) {
      if (block.type === "thinking") {
        if (block.omitted !== true && block.redacted !== true) {
          content.push({ type: "thinking", thinking: block.thinking });
        }
      } else if (block.type === "toolCall") {
        content.push({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: (facts.toolArgs.get(block.id) ?? {}) as Record<string, unknown>,
        });
      } else if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      }
    }
    return {
      role: "assistant",
      content,
      api: "unknown",
      provider: facts.model.provider,
      model: facts.model.id,
      usage: structuredClone(facts.usage ?? ZERO_USAGE),
      stopReason: facts.stopReason ?? "stop",
      ...(facts.errorMessage !== undefined ? { errorMessage: facts.errorMessage } : {}),
      timestamp: record.timestamp,
    } as AgentMessage;
  }
  const content = record.blocks.flatMap((block) => {
    const text = textOf(block);
    return text !== undefined ? [{ type: "text", text }] : [];
  });
  if (record.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: record.toolCallId ?? "",
      toolName: record.toolName ?? "",
      content,
      isError: record.isError ?? false,
      timestamp: record.timestamp,
    } as AgentMessage;
  }
  return { role: "user", content, timestamp: record.timestamp } as AgentMessage;
}

export interface TreeMessage {
  id: string;
  message: AgentMessage;
}

// 一个会话文件的账本 → 树消息（按落盘顺序）。缺正文的条目无从投影，跳过（冷侧另有正文缺口标注）
export function ledgerTreeMessages(input: {
  records: readonly EventRecord[];
  contentByEntryId: ReadonlyMap<string, MessageContentRecord>;
}): TreeMessage[] {
  const toolArgs = new Map<string, unknown>();
  const turnsByRun = new Map<string, Array<Extract<EventRecord, { kind: "turn.completed" }>>>();
  const modelByRun = new Map<string, { provider: string; id: string }>();
  for (const record of input.records) {
    if (record.kind === "tool.proposed") {
      toolArgs.set(record.payload.toolCallId, record.payload.args);
    } else if (record.kind === "turn.completed") {
      turnsByRun.set(record.runId, [...(turnsByRun.get(record.runId) ?? []), record]);
    } else if (record.kind === "run.started" && !modelByRun.has(record.runId)) {
      modelByRun.set(record.runId, {
        provider: record.payload.model.provider,
        id: record.payload.model.id,
      });
    }
  }
  const assistantIndex = new Map<string, number>();
  const messages: TreeMessage[] = [];
  for (const record of input.records) {
    if (record.kind !== "entry") {
      continue;
    }
    const content = input.contentByEntryId.get(record.id);
    if (content === undefined || content.role === "system") {
      continue;
    }
    const facts: LedgerMessageFacts = {
      model: modelByRun.get(record.runId) ?? { provider: "custom", id: "custom" },
      toolArgs,
    };
    if (record.role === "assistant") {
      const index = assistantIndex.get(record.runId) ?? 0;
      assistantIndex.set(record.runId, index + 1);
      const turn = turnsByRun.get(record.runId)?.[index];
      if (turn !== undefined) {
        facts.stopReason = turn.payload.stopReason;
        if (turn.payload.usage !== undefined) {
          facts.usage = turn.payload.usage;
        }
        if (turn.payload.errorMessage !== undefined) {
          facts.errorMessage = turn.payload.errorMessage;
        }
      }
    }
    messages.push({ id: record.id, message: projectLedgerMessage(content, facts) });
  }
  return messages;
}

export interface TreeEntryView {
  id: string;
  parentId: string | null;
  message: AgentMessage;
}

export interface SessionTree {
  readonly rootSessionId: string;
  append(lane: string, messages: readonly TreeMessage[]): Promise<void>;
  createLane(lane: string, atEntryId: string): Promise<void>;
  hasLane(lane: string): Promise<boolean>;
  laneLeaf(lane: string): Promise<string | null>;
  // 通道从根到叶的路径（比对写穿与重建用）
  lanePath(lane: string): Promise<TreeEntryView[]>;
  // 从根到某条目（含）的分支消息，经 buildSessionContext 还原（分叉续跑的 Agent 初始消息）
  messagesUpTo(entryId: string): Promise<AgentMessage[]>;
  remove(): Promise<void>;
}

export function treesDirOf(governanceRoot: string): string {
  return path.join(governanceRoot, ".pigeon", "trees");
}

export async function openSessionTree(input: {
  governanceRoot: string;
  rootSessionId: string;
}): Promise<SessionTree> {
  const env = new NodeExecutionEnv({ cwd: input.governanceRoot });
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: treesDirOf(input.governanceRoot) });
  const existing = (await repo.list({ cwd: input.governanceRoot })).find(
    (metadata) => metadata.id === input.rootSessionId
  );
  const session: Session<
    Awaited<ReturnType<typeof repo.create>> extends Session<infer M> ? M : never
  > =
    existing !== undefined
      ? await repo.open(existing)
      : await repo.create({
          cwd: input.governanceRoot,
          id: input.rootSessionId,
          metadata: { pigeon: { rootSessionId: input.rootSessionId } },
        });
  const messageOf = (entry: { type: string }): AgentMessage | undefined =>
    entry.type === "message" ? (entry as unknown as { message: AgentMessage }).message : undefined;
  return {
    rootSessionId: input.rootSessionId,
    append: async (lane, messages) => {
      for (const item of messages) {
        await session.appendEntry({ type: "message", id: item.id, message: item.message }, lane);
      }
    },
    createLane: (lane, atEntryId) => session.createLane(lane, atEntryId),
    hasLane: async (lane) => (await session.getLanes()).some((pointer) => pointer.lane === lane),
    laneLeaf: async (lane) =>
      (await session.getLanes()).find((pointer) => pointer.lane === lane)?.leafId ?? null,
    lanePath: async (lane) => {
      const leaf = (await session.getLanes()).find((pointer) => pointer.lane === lane)?.leafId;
      if (leaf === undefined || leaf === null) {
        return [];
      }
      const entries = await session.findEntriesOnBranch({ start: leaf, order: "oldestFirst" });
      return entries.flatMap((entry) => {
        const message = messageOf(entry);
        return message !== undefined ? [{ id: entry.id, parentId: entry.parentId, message }] : [];
      });
    },
    messagesUpTo: async (entryId) =>
      buildSessionContext(
        await session.findEntriesOnBranch({ start: entryId, order: "oldestFirst" })
      ).messages,
    remove: async () => {
      await repo.delete(await session.getMetadata());
    },
  };
}
