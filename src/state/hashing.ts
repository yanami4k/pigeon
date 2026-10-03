// 哈希与文本小工具：sha256 十六进制串、规范序列化、UTF-8 字节上限截断。state 叶子，无 IO
// （node:crypto 只做哈希计算）。人写的说明（AGENTS.md）与 Skill 的清单哈希、load_skill 的正文截断、会话视图的块哈希共用
import { createHash } from "node:crypto";
import { Type } from "typebox";

export const Sha256HexSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });

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
