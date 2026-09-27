// 思考不持久化（045）在新会话存储上的形状：选项关闭时，助手消息里的思考块在写入前剥去，消息上另记"略去的思考"——
// 每块的原位置、UTF-8 字节数、全文 sha256 与是否被 provider 编辑，与旧账本略去思考时保存的信息量相同。
// 续跑时 pi 按会话文件还原的上下文里因此没有思考（同旧账本的投影）；读者据标记在原位置提示"未持久化，N 字节"。
// 纯函数、无 IO（node:crypto 只做哈希计算）。
import { createHash } from "node:crypto";

// 消息上存放标记的键（上游消息类型之外的附加字段，provider 转换时不读）
export const OMITTED_THINKING_KEY = "pigeonOmittedThinking";

export interface OmittedThinking {
  // 在原 content 数组里的位置
  index: number;
  bytes: number;
  hash: string;
  redacted?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 剥去助手消息里的思考块，返回新消息；不是助手消息或没有思考块时原样返回（不复制）
export function omitThinking<T>(message: T): T {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  const omitted: OmittedThinking[] = [];
  const content: unknown[] = [];
  message.content.forEach((block: unknown, index) => {
    if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string") {
      omitted.push({
        index,
        bytes: Buffer.byteLength(block.thinking, "utf8"),
        hash: createHash("sha256").update(block.thinking).digest("hex"),
        ...(block.redacted === true ? { redacted: true as const } : {}),
      });
    } else {
      content.push(block);
    }
  });
  if (omitted.length === 0) {
    return message;
  }
  return { ...message, content, [OMITTED_THINKING_KEY]: omitted } as T;
}

// 读消息上的标记；没有或形状不对即空清单
export function omittedThinkingOf(message: Record<string, unknown>): OmittedThinking[] {
  const value = message[OMITTED_THINKING_KEY];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is OmittedThinking =>
      isRecord(item) &&
      Number.isSafeInteger(item.index) &&
      Number.isSafeInteger(item.bytes) &&
      typeof item.hash === "string"
  );
}
