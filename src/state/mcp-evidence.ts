// MCP 回执证据块（M5.7 S3，决策 053）：与既有回执回答同样的问题——执行参数是否审批时那份（argsHash 与 intent
// 原始参数按 037 规范序列化对得上）、实际返回了什么（全文哈希与字节数、文本摘要）、证据完整吗（摘要截断标记，
// §3.3 截断不支撑确定性结论）。server 在 structuredContent 的 evidence 键主动交的证据原样收入，超 16 KiB 截断并
// 标记，哈希恒按整体算。不解析返回语义，不做确证。
import { canonicalJson, sha256Hex } from "./message-content.ts";
import type { ReceiptMcp } from "./receipt.ts";

export const MCP_SERVER_EVIDENCE_MAX_BYTES = 16 * 1024;
export const MCP_RESULT_SUMMARY_MAX_BYTES = 2 * 1024;

export interface McpCallResultLike {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

// UTF-8 字节前缀：不劈开多字节字符
export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// 返回内容的文本渲染：文本块原文，其余块只留类型占位
function resultText(content: readonly unknown[]): string {
  return content
    .map((block) => {
      const item = plainObject(block);
      if (item?.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      return `[${typeof item?.type === "string" ? item.type : "unknown"}]`;
    })
    .join("\n");
}

export function buildMcpEvidence(input: {
  server: string;
  tool: string;
  args: unknown;
  result: McpCallResultLike;
}): ReceiptMcp {
  const { result } = input;
  const contentJson = canonicalJson(result.content);
  const text = resultText(result.content);
  const structured = result.structuredContent;
  const evidenceSource = plainObject(structured);
  let serverEvidence: ReceiptMcp["serverEvidence"];
  if (
    evidenceSource !== undefined &&
    Object.hasOwn(evidenceSource, "evidence") &&
    evidenceSource.evidence !== undefined
  ) {
    const whole = canonicalJson(evidenceSource.evidence);
    const bytes = Buffer.byteLength(whole);
    const hash = sha256Hex(whole);
    serverEvidence =
      bytes <= MCP_SERVER_EVIDENCE_MAX_BYTES
        ? { value: evidenceSource.evidence, bytes, hash, truncated: false }
        : { text: utf8Prefix(whole, MCP_SERVER_EVIDENCE_MAX_BYTES), bytes, hash, truncated: true };
  }
  return {
    server: input.server,
    tool: input.tool,
    argsHash: sha256Hex(canonicalJson(input.args ?? {})),
    isError: result.isError === true,
    resultSummary: utf8Prefix(text, MCP_RESULT_SUMMARY_MAX_BYTES),
    resultHash: sha256Hex(contentJson),
    resultBytes: Buffer.byteLength(contentJson),
    truncated: Buffer.byteLength(text) > MCP_RESULT_SUMMARY_MAX_BYTES,
    ...(structured !== undefined ? { structuredHash: sha256Hex(canonicalJson(structured)) } : {}),
    ...(serverEvidence !== undefined ? { serverEvidence } : {}),
  };
}
