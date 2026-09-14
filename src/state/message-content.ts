// 消息内容记录（M5 S1，决策 037 / 045）：旁置内容文件 `<sessionId>.messages.jsonl` 的记录形状、
// 内容块抽取、规范序列化哈希与按块截断。Event Log 仍是唯一状态权威；内容记录是被 entry 的
// contentHash 回指的证据材料，不承载任何状态。本文件是 state 叶子：不依赖上游类型——
// 输入按结构读取（pi-ai 的 UserMessage / AssistantMessage / ToolResultMessage 形状），
// 无 IO（node:crypto 只做哈希计算，与 ids.ts 的随机数同属纯计算依赖）。
import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { EntryIdSchema, RunIdSchema, SessionIdSchema } from "./ids.ts";

export const MESSAGE_CONTENT_VERSION = 1;

// 单个内容块的默认大小上限（UTF-8 字节）：超出截断并可见标记，带全文哈希（037：绝不静默丢弃）
export const DEFAULT_CONTENT_BLOCK_LIMIT_BYTES = 64 * 1024;

export const Sha256HexSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });

// 角色集合 = entry 族的七种 + system（044：system prompt 全文每会话以 system 记录写一次）
export const ContentRoleSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("assistant"),
  Type.Literal("toolResult"),
  Type.Literal("system"),
  Type.Literal("custom"),
  Type.Literal("bashExecution"),
  Type.Literal("branchSummary"),
  Type.Literal("compactionSummary"),
]);
export type ContentRole = Static<typeof ContentRoleSchema>;

export const TextBlockSchema = Type.Object({
  type: Type.Literal("text"),
  // 截断时为 UTF-8 前缀（不劈字符）；标记与全文哈希由渲染方负责可见化
  text: Type.String(),
  truncated: Type.Boolean(),
  // 仅截断时存在：未截断全文的 sha256
  fullHash: Type.Optional(Sha256HexSchema),
});

// thinking 与 text 同形态（045）：redacted = provider 安全过滤编辑掉的块；omitted = 持久化开关
// 关闭时只留字节数与全文哈希、不存正文（"有思维链但未存"如实可见，而非静默消失）
export const ThinkingBlockSchema = Type.Object({
  type: Type.Literal("thinking"),
  thinking: Type.String(),
  truncated: Type.Boolean(),
  fullHash: Type.Optional(Sha256HexSchema),
  redacted: Type.Optional(Type.Boolean()),
  omitted: Type.Optional(Type.Boolean()),
  bytes: Type.Optional(Type.Integer({ minimum: 0 })),
});

// 图片只记元数据，不存数据（037）
export const ImageBlockSchema = Type.Object({
  type: Type.Literal("image"),
  mimeType: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
  hash: Sha256HexSchema,
});

// 工具调用块只记 id 与 name：参数已在 tool.proposed / intent 里，不重复存
export const ToolCallBlockSchema = Type.Object({
  type: Type.Literal("toolCall"),
  id: Type.String(),
  name: Type.String(),
});

// 未知块类型（上游新增块种类）：不静默丢弃，记原始类型与规范序列化哈希
export const UnknownBlockSchema = Type.Object({
  type: Type.Literal("unknown"),
  originalType: Type.String(),
  hash: Sha256HexSchema,
});

export const ContentBlockSchema = Type.Union([
  TextBlockSchema,
  ThinkingBlockSchema,
  ImageBlockSchema,
  ToolCallBlockSchema,
  UnknownBlockSchema,
]);
export type ContentBlock = Static<typeof ContentBlockSchema>;

export const MessageContentRecordSchema = Type.Object({
  version: Type.Literal(MESSAGE_CONTENT_VERSION),
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  // 与 entry 族同一权威键 (runId, runSeq)；system 记录不对应 transcript 消息，runSeq 取 0
  runSeq: Type.Integer({ minimum: 0 }),
  entryId: EntryIdSchema,
  role: ContentRoleSchema,
  timestamp: Type.Integer({ minimum: 0 }),
  blocks: Type.Array(ContentBlockSchema),
  // 内容块规范序列化的 sha256；entry.contentHash 回指它
  contentHash: Sha256HexSchema,
  // toolResult 元数据（历史渲染折叠行与检索命中展示用）
  toolCallId: Type.Optional(Type.String()),
  toolName: Type.Optional(Type.String()),
  isError: Type.Optional(Type.Boolean()),
});
export type MessageContentRecord = Static<typeof MessageContentRecordSchema>;

// 内容记录的业务部分（信封 version / sessionId / runId / runSeq / entryId / timestamp 由写入方盖章）
export type MessageContent = Omit<
  MessageContentRecord,
  "version" | "sessionId" | "runId" | "runSeq" | "entryId" | "timestamp"
>;

export interface MessageContentOptions {
  // 单块上限（UTF-8 字节）；缺省 64 KiB
  blockLimitBytes?: number;
  // thinking 正文是否持久化；缺省 true（045）
  persistThinking?: boolean;
}

// 结构输入：只读 role / content / toolResult 元数据，不依赖上游类型
export interface ContentSourceMessage {
  role: string;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// 规范序列化：对象键按码点序排序、数组保序、undefined 属性省略（同 JSON.stringify 语义）。
// 哈希必须与字段写入顺序无关，否则不同写入路径算出的哈希会漂移
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const entries = Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    );
  return `{${entries.join(",")}}`;
}

export function hashContentBlocks(blocks: readonly ContentBlock[]): string {
  return sha256Hex(canonicalJson(blocks));
}

// 按记录现有正文重算哈希：冷侧据此识破"内容记录在，但正文被改过"
export function recomputeContentHash(record: Pick<MessageContentRecord, "blocks">): string {
  return hashContentBlocks(record.blocks);
}

// UTF-8 字节上限截断：取不超过上限的最长前缀，不劈开多字节字符与 UTF-16 代理对
export function truncateUtf8(
  text: string,
  limitBytes: number
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= limitBytes) {
    return { text, truncated: false };
  }
  // 前缀字节数随长度单调不减：二分找最长合法前缀
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= limitBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let end = low;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return { text: text.slice(0, end), truncated: true };
}

const ROLES = new Set<string>(ContentRoleSchema.anyOf.map((schema) => schema.const as string));

// 从一条消息抽取内容块并算哈希（纯函数，确定性）：活侧落盘与 llm.request 指纹共用，
// 同一消息 + 同一选项恒得同一 contentHash
export function buildMessageContent(
  message: ContentSourceMessage,
  options: MessageContentOptions = {}
): MessageContent {
  if (!ROLES.has(message.role)) {
    throw new Error(`内容记录不支持的消息角色：${message.role}`);
  }
  const limit = options.blockLimitBytes ?? DEFAULT_CONTENT_BLOCK_LIMIT_BYTES;
  const persistThinking = options.persistThinking ?? true;
  const raw = message.content;
  const sourceBlocks: unknown[] =
    typeof raw === "string" ? [{ type: "text", text: raw }] : Array.isArray(raw) ? raw : [];
  const blocks = sourceBlocks.map((block) => toContentBlock(block, limit, persistThinking));
  const content: MessageContent = {
    role: message.role as ContentRole,
    blocks,
    contentHash: hashContentBlocks(blocks),
  };
  if (typeof message.toolCallId === "string") {
    content.toolCallId = message.toolCallId;
  }
  if (typeof message.toolName === "string") {
    content.toolName = message.toolName;
  }
  if (typeof message.isError === "boolean") {
    content.isError = message.isError;
  }
  return content;
}

function toContentBlock(block: unknown, limit: number, persistThinking: boolean): ContentBlock {
  if (typeof block !== "object" || block === null) {
    return { type: "unknown", originalType: typeof block, hash: sha256Hex(canonicalJson(block)) };
  }
  const source = block as Record<string, unknown>;
  const unknownBlock = (): ContentBlock => ({
    type: "unknown",
    originalType: typeof source.type === "string" ? source.type : "<missing>",
    hash: sha256Hex(canonicalJson(source)),
  });
  switch (source.type) {
    case "text": {
      if (typeof source.text !== "string") {
        return unknownBlock();
      }
      const cut = truncateUtf8(source.text, limit);
      return {
        type: "text",
        text: cut.text,
        truncated: cut.truncated,
        ...(cut.truncated ? { fullHash: sha256Hex(source.text) } : {}),
      };
    }
    case "thinking": {
      if (typeof source.thinking !== "string") {
        return unknownBlock();
      }
      const redacted = source.redacted === true ? { redacted: true } : {};
      if (!persistThinking) {
        return {
          type: "thinking",
          thinking: "",
          truncated: false,
          omitted: true,
          bytes: Buffer.byteLength(source.thinking, "utf8"),
          fullHash: sha256Hex(source.thinking),
          ...redacted,
        };
      }
      const cut = truncateUtf8(source.thinking, limit);
      return {
        type: "thinking",
        thinking: cut.text,
        truncated: cut.truncated,
        ...(cut.truncated ? { fullHash: sha256Hex(source.thinking) } : {}),
        ...redacted,
      };
    }
    case "image": {
      if (typeof source.data !== "string" || typeof source.mimeType !== "string") {
        return unknownBlock();
      }
      const bytes = Buffer.from(source.data, "base64");
      return {
        type: "image",
        mimeType: source.mimeType,
        bytes: bytes.length,
        hash: sha256Hex(bytes),
      };
    }
    case "toolCall":
      return {
        type: "toolCall",
        id: typeof source.id === "string" ? source.id : "",
        name: typeof source.name === "string" ? source.name : "",
      };
    default:
      return unknownBlock();
  }
}

// 读路径校验：失败原样上抛，由读取方（persistence）定性
export function parseMessageContentRecord(raw: unknown): MessageContentRecord {
  return Value.Parse(MessageContentRecordSchema, raw);
}
