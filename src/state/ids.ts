// 稳定标识（ROADMAP §4 / M0）：Run、Session、Entry、Execution、Receipt 五类。
// 形态：`<前缀>_<26 位 Crockford Base32 ULID>`。
// 品牌类型（branded type）保证编译期不可混用；as* 函数做运行期校验，供反序列化入口使用。
import { randomBytes } from "node:crypto";
import { Type } from "typebox";

// Crockford Base32 字母表（去除易混淆的 I/L/O/U）
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN_SOURCE = "[0-9A-HJKMNP-TV-Z]{26}";

// ULID：48 位毫秒时间戳 + 80 位随机数，编码为 26 个字符，字典序即时间序
function ulid(now: number = Date.now()): string {
  // 时间部分：10 个字符，大端序
  let time = now;
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD.charAt(time % 32) + head;
    time = Math.floor(time / 32);
  }
  // 随机部分：10 字节 = 80 bit = 16 个字符，每字符 5 bit
  const bytes = randomBytes(10);
  let tail = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      tail += CROCKFORD.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return head + tail;
}

// 标识种类工厂：生成 new*/as* 闭包与对应的 typebox schema，保证前缀只有一处定义
function defineIdKind<Brand>(prefix: string) {
  const pattern = new RegExp(`^${prefix}${ULID_PATTERN_SOURCE}$`);
  const schema = Type.Unsafe<Brand>({ type: "string", pattern: pattern.source });
  return {
    create(): Brand {
      return `${prefix}${ulid()}` as Brand;
    },
    check(value: string): Brand {
      if (typeof value !== "string" || !pattern.test(value)) {
        throw new Error(`非法标识：期望 "${prefix}" + 26 位 ULID，收到 ${JSON.stringify(value)}`);
      }
      return value as Brand;
    },
    schema,
  };
}

export type RunId = string & { readonly __brand: "RunId" };
const runId = defineIdKind<RunId>("run_");
export const newRunId: () => RunId = runId.create;
export const asRunId: (value: string) => RunId = runId.check;
export const RunIdSchema = runId.schema;

export type SessionId = string & { readonly __brand: "SessionId" };
const sessionId = defineIdKind<SessionId>("sess_");
export const newSessionId: () => SessionId = sessionId.create;
export const asSessionId: (value: string) => SessionId = sessionId.check;
export const SessionIdSchema = sessionId.schema;

export type EntryId = string & { readonly __brand: "EntryId" };
const entryId = defineIdKind<EntryId>("entry_");
export const newEntryId: () => EntryId = entryId.create;
export const asEntryId: (value: string) => EntryId = entryId.check;
export const EntryIdSchema = entryId.schema;

export type ExecutionId = string & { readonly __brand: "ExecutionId" };
const executionId = defineIdKind<ExecutionId>("exec_");
export const newExecutionId: () => ExecutionId = executionId.create;
export const asExecutionId: (value: string) => ExecutionId = executionId.check;
export const ExecutionIdSchema = executionId.schema;

export type ReceiptId = string & { readonly __brand: "ReceiptId" };
const receiptId = defineIdKind<ReceiptId>("rcpt_");
export const newReceiptId: () => ReceiptId = receiptId.create;
export const asReceiptId: (value: string) => ReceiptId = receiptId.check;
export const ReceiptIdSchema = receiptId.schema;

// GrantId（M4 S6，决策 3）：会话级工具放权的稳定标识；grant.created/grant.revoked
// 事件族与 intent 的 grantRef 共用
export type GrantId = string & { readonly __brand: "GrantId" };
const grantId = defineIdKind<GrantId>("grant_");
export const newGrantId: () => GrantId = grantId.create;
export const asGrantId: (value: string) => GrantId = grantId.check;
export const GrantIdSchema = grantId.schema;
