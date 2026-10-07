// 网关的逐请求留存（决策 394）：开启后，网关把每个作业每一步的模型请求与回复落到该作业目录的 gateway/ 下，供跑完后转成
// Scout 转录（转换不在这里）。只记不改：转发的请求体与回复逐字不变，留存出错只告警、不影响转发。
//   布局：gateway/step-<步序>/try-<第几次>/ 下 requests.jsonl（请求读完即写一行）、responses.jsonl（结束时一行）、
//        replies.gz（各次回复的原始正文，一次一段 gzip，按偏移取）、large.gz（大字段，同样按偏移取）；
//        gateway/blobs/<sha256>.json 为系统提示与工具定义的整段，同一作业只存一份。重做与续跑另开下一个 try。
//   请求只存增量：同一次尝试里找此前的请求，其 messages 恰为本次的前缀（取最长的），只存其后新增的消息并记下它的编号；
//        找不到（第一次、上下文被压缩改写、另一路对话）即存全量并标 full。另记 messages、system、tools 以外的顶层字段
//        （模型与参数），system 与 tools 只记摘要（整段在作业里第一次出现时存进 blobs），以及顶层字段的先后。
//   cache_control（格式第 2 版）：客户端每次请求把缓存断点挪到最新的消息上，上一次带断点的消息这次不带了。比对前缀与存的
//        增量一律是去掉 cache_control 的消息；每次请求里 cache_control 所在的位置（消息下标、内容块下标、在对象里是第几个键）
//        与取值另记，读取时放回原处，增量加位置逐字还原出原请求的消息。第 1 版的记录没有位置与字段先后，照旧读。
//   大字段：messages、system、tools 以外的顶层字段序列化超过 LARGE_FIELD_BYTES 的（例如外部 agent 每次请求附带的增量
//        会话日志）不进参数，记字段名、大小与 sha256，内容 gzip 后另存；一题里至多用掉单题上限的四分之一，超出只记大小与摘要。
//   回复：原始正文（SSE 或 JSON）另存；responses.jsonl 记交回的状态码、耗时、用量、停止原因；非 200 记错误正文的前 2000 字。
//        读回复时客户端断开或读流出错的照记已收到正文里的用量与错误，用量不齐（没能计价）的标 usageMissing。
//   鉴权：请求头里名字含 auth、key、token、secret、cookie、password 的一律不存；落盘的每段文字先去掉配置的 key 与上游回显的
//        打码密钥片段（scrubKeys）。
//   上限：单题（同一步各次尝试合计）与单作业（续跑时接着已落盘的量算）的落盘字节。放不下即截断并标明：这次请求只记一行
//        摘要（编号、大小、sha256、消息条数，标 truncated），放不下的回复正文不存、标 truncated。摘要行与回复行总是写。
//   不在一步之内（beginStep 与它返回的结束函数之间）的请求不记。跑完的作业可整个删掉 gateway/（removeRetention）。
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { scrubKeys } from "./model-limits.ts";

// 留存格式的版本（身份头记它）：落盘的布局或字段一改即加一。第 2 版：增量去掉 cache_control、另记其位置与顶层字段的先后；
// 第 3 版：读回复时中途断开的请求照记已收到正文里的用量，用量不齐的标 usageMissing
export const GATEWAY_RETENTION_VERSION = 3;
export const RETENTION_DIR = "gateway";
const MIB = 1024 * 1024;
// 缺省上限：单题 32 MiB、单作业 512 MiB（估算见审计：一题约 1–2 MiB）
export const DEFAULT_RETENTION_LIMITS: RetentionLimits = {
  maxTaskBytes: 32 * MIB,
  maxJobBytes: 512 * MIB,
};
export const LARGE_FIELD_BYTES = 16 * 1024;
const ERROR_BODY_CHARS = 2000;
const SENSITIVE_HEADER = /auth|key|token|secret|cookie|password/i;

export interface RetentionLimits {
  maxTaskBytes: number;
  maxJobBytes: number;
}

export type RetentionCut = "task-cap" | "job-cap";

export interface BlobRef {
  sha256: string;
  bytes: number;
}

// 一段 gzip 在 replies.gz 或 large.gz 里的位置
export interface GzSlice {
  offset: number;
  length: number;
}

export interface LargeFieldRef {
  field: string;
  bytes: number;
  sha256: string;
  // 存了内容即有；只记大小与摘要时没有
  slice?: GzSlice;
}

// 一处 cache_control：第几条消息、其 content 里第几个块（没有即在消息本身上）、在该对象里是第几个键、取值
export interface CacheControlMark {
  message: number;
  block?: number;
  key: number;
  value: unknown;
}

export interface RetainedRequest {
  id: number;
  at: string;
  bodyBytes: number;
  bodySha256: string;
  headers?: Record<string, string>;
  // 顶层字段的先后（第 2 版起）
  order?: string[];
  params?: Record<string, unknown>;
  system?: BlobRef;
  tools?: BlobRef & { count: number };
  // base 为前缀所在的请求编号；full 为存了全量。delta 为去掉 cache_control 的消息（第 1 版原样）。被截断的只有 count
  messages?: { count: number; base?: number; full?: true; delta?: unknown[] };
  // 这次请求的消息里 cache_control 的全部位置（第 2 版起，有才记）
  cacheControl?: CacheControlMark[];
  large?: LargeFieldRef[];
  truncated?: RetentionCut;
  // 请求体不是 JSON 对象：只记大小与摘要
  unparsed?: true;
}

export interface RetainedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RetainedResponse {
  id: number;
  at: string;
  ms: number;
  // 交回客户端的状态码；客户端中止、没交回为 0
  status: number;
  usage?: RetainedUsage;
  // 读回复时中途断开、已收到的正文里用量不齐，没能计价（第 3 版起）
  usageMissing?: true;
  stopReason?: string | null;
  error?: string;
  body?: string;
  reply?: { bytes: number; slice?: GzSlice; truncated?: RetentionCut };
}

// 网关交来的一次请求的结局
export interface ExchangeOutcome {
  status: number;
  // 200 的回复正文（中途断流时为已收到的部分）；非 200 的错误正文
  text?: string;
  usage?: RetainedUsage;
  usageMissing?: true;
  error?: string;
}

export interface RetainedExchange {
  finish(outcome: ExchangeOutcome): void;
}

interface TryState {
  dir: string;
  nextId: number;
  // 此前各次请求完整 messages 的链式摘要 → 请求编号（只记全文落了盘的）
  chains: Map<string, number>;
  // 这一题（各次尝试合计）已落盘的字节、其中大字段的字节
  taskBytes: number;
  largeBytes: number;
  // replies.gz、large.gz 当前的长度（追加的偏移）
  ends: Map<string, number>;
}

interface JobState {
  root: string;
  bytes: number;
  seq: number | undefined;
  step: object | undefined;
  current: TryState | undefined;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 去掉消息本身与其 content 各块上的 cache_control（不改原对象，其余键的先后不变），交回去掉之后的消息与各处位置
export function stripCacheControl(messages: readonly unknown[]): {
  stripped: unknown[];
  marks: CacheControlMark[];
} {
  const marks: CacheControlMark[] = [];
  const without = (obj: Record<string, unknown>, at: { message: number; block?: number }) => {
    const key = Object.keys(obj).indexOf("cache_control");
    if (key === -1) return obj;
    marks.push({ ...at, key, value: obj.cache_control });
    const { cache_control: _cacheControl, ...rest } = obj;
    return rest;
  };
  const stripped = messages.map((m, message) => {
    if (!isObject(m)) return m;
    const msg = without(m, { message });
    if (!Array.isArray(msg.content)) return msg;
    const content = msg.content.map((b: unknown, block: number) =>
      isObject(b) ? without(b, { message, block }) : b
    );
    return { ...msg, content };
  });
  return { stripped, marks };
}

// stripCacheControl 的逆：把各处 cache_control 按原来的键位放回（不改传入的消息）
export function applyCacheControl(
  messages: readonly unknown[],
  marks: readonly CacheControlMark[]
): unknown[] {
  const out = [...messages];
  const insert = (obj: Record<string, unknown>, key: number, value: unknown) => {
    const entries = Object.entries(obj);
    entries.splice(key, 0, ["cache_control", value]);
    return Object.fromEntries(entries);
  };
  for (const { message, block, key, value } of marks) {
    const msg = out[message];
    if (!isObject(msg)) continue;
    if (block === undefined) {
      out[message] = insert(msg, key, value);
    } else if (Array.isArray(msg.content)) {
      const target: unknown = msg.content[block];
      if (!isObject(target)) continue;
      const content = [...msg.content];
      content[block] = insert(target, key, value);
      out[message] = { ...msg, content };
    }
  }
  return out;
}

// 目录下全部文件的字节数；不在为 0
function sizeOf(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return total;
}

// 停止原因：SSE 取 message_delta 的 delta.stop_reason（取最后一次），非流式取正文的 stop_reason；读不到为 null
export function stopReasonOf(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  let reason: string | null = null;
  const take = (v: unknown) => {
    if (typeof v === "string") reason = v;
  };
  if (lines.length === 0) {
    try {
      take((JSON.parse(text) as { stop_reason?: unknown }).stop_reason);
    } catch {
      // 不是 JSON
    }
    return reason;
  }
  for (const line of lines) {
    if (!line.includes('"stop_reason"')) continue;
    try {
      const event = JSON.parse(line.slice(5)) as {
        type?: string;
        delta?: { stop_reason?: unknown };
      };
      if (event.type === "message_delta") take(event.delta?.stop_reason);
    } catch {
      // 非 JSON 的 data 行
    }
  }
  return reason;
}

export interface GatewayRetentionOptions extends RetentionLimits {
  // 网关的真 key：落盘前从每段文字里去掉
  keys: readonly string[];
  now?: () => number;
  warn?: (line: string) => void;
}

export class GatewayRetention {
  private readonly jobs = new Map<string, JobState>();
  private readonly warned = new Set<string>();
  private readonly options: GatewayRetentionOptions;

  constructor(options: GatewayRetentionOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private warnOnce(id: string, line: string): void {
    if (this.warned.has(id)) return;
    this.warned.add(id);
    (this.options.warn ?? ((l: string) => process.stderr.write(`[网关留存] ${l}\n`)))(line);
  }

  private scrub(text: string): string {
    return scrubKeys(text, this.options.keys);
  }

  // 跑批器：这个作业的这一步开始（返回结束函数）。尝试目录在这一步第一次有请求时才建
  beginStep(job: string, jobDir: string, seq: number): () => void {
    const root = path.join(jobDir, RETENTION_DIR);
    let st = this.jobs.get(job);
    if (st === undefined || st.root !== root) {
      st = { root, bytes: sizeOf(root), seq: undefined, step: undefined, current: undefined };
      this.jobs.set(job, st);
    }
    const step = {};
    const state = st;
    state.seq = seq;
    state.step = step;
    state.current = undefined;
    return () => {
      if (state.step !== step) return;
      state.seq = undefined;
      state.step = undefined;
      state.current = undefined;
    };
  }

  // 网关：读完一次请求的请求体之后调用；这个作业不在一步之内即不记（undefined）
  open(job: string, raw: Buffer, headers: IncomingHttpHeaders): RetainedExchange | undefined {
    const st = this.jobs.get(job);
    if (st?.seq === undefined) return undefined;
    try {
      st.current ??= this.newTry(st.root, st.seq);
      const tr = st.current;
      const id = tr.nextId++;
      const started = this.now();
      this.writeRequest(st, tr, id, raw, headers, started);
      return {
        finish: (outcome) => {
          try {
            this.writeResponse(st, tr, id, started, outcome);
          } catch (error) {
            this.warnOnce("write", `留存写入失败（此后照常转发）：${this.scrub(String(error))}`);
          }
        },
      };
    } catch (error) {
      this.warnOnce("write", `留存写入失败（此后照常转发）：${this.scrub(String(error))}`);
      return undefined;
    }
  }

  private newTry(root: string, seq: number): TryState {
    const stepDir = path.join(root, `step-${seq}`);
    mkdirSync(stepDir, { recursive: true });
    let n = 1;
    while (existsSync(path.join(stepDir, `try-${n}`))) n++;
    const dir = path.join(stepDir, `try-${n}`);
    mkdirSync(dir);
    return {
      dir,
      nextId: 1,
      chains: new Map(),
      taskBytes: sizeOf(stepDir),
      largeBytes: 0,
      ends: new Map(),
    };
  }

  // 超出哪一项上限；都没超为 undefined
  private cutFor(st: JobState, tr: TryState, bytes: number): RetentionCut | undefined {
    const cut =
      st.bytes + bytes > this.options.maxJobBytes
        ? "job-cap"
        : tr.taskBytes + bytes > this.options.maxTaskBytes
          ? "task-cap"
          : undefined;
    if (cut !== undefined) {
      this.warnOnce(
        `${st.root}-${cut === "job-cap" ? "" : tr.dir}`,
        `留存到了${cut === "job-cap" ? "单作业" : "单题"}上限（${st.root}）：放不下的请求与回复只记摘要，标 truncated`
      );
    }
    return cut;
  }

  private spend(st: JobState, tr: TryState, bytes: number): void {
    st.bytes += bytes;
    tr.taskBytes += bytes;
  }

  private appendLine(st: JobState, tr: TryState, file: string, record: object): void {
    const line = `${this.scrub(JSON.stringify(record))}\n`;
    appendFileSync(path.join(tr.dir, file), line);
    this.spend(st, tr, Buffer.byteLength(line));
  }

  // 追加一段 gzip，交回它的位置
  private appendGz(st: JobState, tr: TryState, file: string, gz: Buffer): GzSlice {
    const offset = tr.ends.get(file) ?? 0;
    appendFileSync(path.join(tr.dir, file), gz);
    tr.ends.set(file, offset + gz.length);
    this.spend(st, tr, gz.length);
    return { offset, length: gz.length };
  }

  private writeRequest(
    st: JobState,
    tr: TryState,
    id: number,
    raw: Buffer,
    headers: IncomingHttpHeaders,
    started: number
  ): void {
    const head = {
      id,
      at: new Date(started).toISOString(),
      bodyBytes: raw.length,
      bodySha256: sha256(raw),
    };
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      body = undefined;
    }
    if (!isObject(body)) {
      this.appendLine(st, tr, "requests.jsonl", { ...head, unparsed: true });
      return;
    }
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || SENSITIVE_HEADER.test(name)) continue;
      kept[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    const { messages, system, tools, ...rest } = body;
    const params: Record<string, unknown> = {};
    const large: LargeFieldRef[] = [];
    for (const [field, value] of Object.entries(rest)) {
      const text = JSON.stringify(value);
      const bytes = Buffer.byteLength(text);
      if (bytes <= LARGE_FIELD_BYTES) {
        params[field] = value;
        continue;
      }
      // 大字段：内容另存（一题至多用掉单题上限的四分之一），超出或到了上限只记大小与摘要
      const ref: LargeFieldRef = { field, bytes, sha256: sha256(text) };
      // 四分之一已用满即不再压缩
      const gz =
        tr.largeBytes < this.options.maxTaskBytes / 4
          ? gzipSync(Buffer.from(this.scrub(text), "utf8"))
          : undefined;
      if (gz === undefined || tr.largeBytes + gz.length > this.options.maxTaskBytes / 4) {
        this.warnOnce(
          `large-${tr.dir}`,
          `大字段到了单题上限的四分之一（${tr.dir}）：此后只记大小与摘要`
        );
      } else if (this.cutFor(st, tr, gz.length) === undefined) {
        ref.slice = this.appendGz(st, tr, "large.gz", gz);
        tr.largeBytes += gz.length;
      }
      large.push(ref);
    }
    // system 与 tools 的整段：作业里第一次出现时存进 blobs
    const blobs: { file: string; text: string }[] = [];
    const blob = (value: unknown): BlobRef => {
      const text = this.scrub(JSON.stringify(value));
      const ref = { sha256: sha256(text), bytes: Buffer.byteLength(text) };
      const file = path.join(st.root, "blobs", `${ref.sha256}.json`);
      if (!existsSync(file) && !blobs.some((b) => b.file === file)) blobs.push({ file, text });
      return ref;
    };
    const record: RetainedRequest = {
      ...head,
      headers: kept,
      order: Object.keys(body),
      params,
      ...(system !== undefined ? { system: blob(system) } : {}),
      ...(tools !== undefined
        ? { tools: { ...blob(tools), count: Array.isArray(tools) ? tools.length : 0 } }
        : {}),
      ...(large.length > 0 ? { large } : {}),
    };
    // 增量：此前某次请求的完整 messages 恰为本次的前缀即只存其后的部分（取最长的前缀）。比的与存的都是去掉 cache_control
    // 的消息，cache_control 的位置另记
    let chain: string | undefined;
    if (Array.isArray(messages)) {
      const { stripped, marks } = stripCacheControl(messages);
      const chains: string[] = [];
      let h = "";
      for (const m of stripped) {
        h = sha256(`${h}\n${JSON.stringify(m)}`);
        chains.push(h);
      }
      chain = chains.at(-1);
      let base: number | undefined;
      let baseCount = 0;
      for (let k = chains.length; k >= 1 && base === undefined; k--) {
        base = tr.chains.get(chains[k - 1] as string);
        if (base !== undefined) baseCount = k;
      }
      record.messages = {
        count: messages.length,
        ...(base !== undefined ? { base } : { full: true as const }),
        delta: stripped.slice(baseCount),
      };
      if (marks.length > 0) record.cacheControl = marks;
    } else if (messages !== undefined) {
      record.params = { ...params, messages };
    }
    const blobBytes = blobs.reduce((n, b) => n + Buffer.byteLength(b.text), 0);
    const cut = this.cutFor(st, tr, blobBytes + Buffer.byteLength(JSON.stringify(record)) + 1);
    if (cut !== undefined) {
      const count = Array.isArray(messages) ? { messages: { count: messages.length } } : {};
      this.appendLine(st, tr, "requests.jsonl", {
        ...head,
        ...count,
        ...(large.length > 0 ? { large } : {}),
        truncated: cut,
      });
      return;
    }
    for (const b of blobs) {
      mkdirSync(path.dirname(b.file), { recursive: true });
      writeFileSync(b.file, b.text);
      this.spend(st, tr, Buffer.byteLength(b.text));
    }
    this.appendLine(st, tr, "requests.jsonl", record);
    if (chain !== undefined) tr.chains.set(chain, id);
  }

  private writeResponse(
    st: JobState,
    tr: TryState,
    id: number,
    started: number,
    outcome: ExchangeOutcome
  ): void {
    const ended = this.now();
    const record: RetainedResponse = {
      id,
      at: new Date(ended).toISOString(),
      ms: ended - started,
      status: outcome.status,
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
      ...(outcome.usageMissing === true ? { usageMissing: true as const } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
    if (outcome.text !== undefined && outcome.status === 200) {
      record.stopReason = stopReasonOf(outcome.text);
      const raw = Buffer.from(this.scrub(outcome.text), "utf8");
      const gz = gzipSync(raw);
      const cut = this.cutFor(st, tr, gz.length);
      record.reply =
        cut === undefined
          ? { bytes: raw.length, slice: this.appendGz(st, tr, "replies.gz", gz) }
          : { bytes: raw.length, truncated: cut };
    } else if (outcome.text !== undefined) {
      record.body = outcome.text.slice(0, ERROR_BODY_CHARS);
    }
    this.appendLine(st, tr, "responses.jsonl", record);
  }
}

// 读取（按作业目录，可只取一步）：每次尝试列出各次请求与回复；body 为还原出的完整请求体（沿 base 拼回去掉 cache_control
// 的消息，再按记下的位置放回 cache_control；第 2 版起顶层字段按原文先后，第 1 版的键序不保证与原文相同），还原不全的部分
// 列在 missing 里；reply() 取原始回复正文
export interface RetainedExchangeView {
  id: number;
  request: RetainedRequest;
  response: RetainedResponse | undefined;
  body: Record<string, unknown> | undefined;
  missing: string[];
  // 还原出的请求体紧凑序列化后与转发的原文逐字相同（按原文的 sha256 核对；原文带空白排版的为 false）
  exact: boolean;
  reply(): string | undefined;
}

export interface RetainedTry {
  seq: number;
  attempt: number;
  exchanges: RetainedExchangeView[];
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 写到一半的行
    }
  }
  return out;
}

function numbered(dir: string, prefix: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => (name.startsWith(prefix) ? Number(name.slice(prefix.length)) : Number.NaN))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

export function readRetention(jobDir: string, seq?: number): RetainedTry[] {
  const root = path.join(jobDir, RETENTION_DIR);
  const gunzipAt = (file: string, slice: GzSlice) =>
    gunzipSync(readFileSync(file).subarray(slice.offset, slice.offset + slice.length)).toString(
      "utf8"
    );
  const blobOf = (ref: BlobRef): unknown => {
    const file = path.join(root, "blobs", `${ref.sha256}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  };
  const tries: RetainedTry[] = [];
  for (const s of numbered(root, "step-")) {
    if (seq !== undefined && s !== seq) continue;
    for (const attempt of numbered(path.join(root, `step-${s}`), "try-")) {
      const dir = path.join(root, `step-${s}`, `try-${attempt}`);
      const requests = readLines<RetainedRequest>(path.join(dir, "requests.jsonl"));
      const responses = new Map(
        readLines<RetainedResponse>(path.join(dir, "responses.jsonl")).map((r) => [r.id, r])
      );
      const byId = new Map(requests.map((r) => [r.id, r]));
      const memo = new Map<number, unknown[] | undefined>();
      const messagesOf = (id: number): unknown[] | undefined => {
        if (memo.has(id)) return memo.get(id);
        const m = byId.get(id)?.messages;
        let out: unknown[] | undefined;
        if (m?.delta !== undefined) {
          const prior =
            m.full === true ? [] : m.base !== undefined ? messagesOf(m.base) : undefined;
          out = prior === undefined ? undefined : [...prior, ...m.delta];
        }
        memo.set(id, out);
        return out;
      };
      const exchanges = [...requests]
        .sort((a, b) => a.id - b.id)
        .map((request): RetainedExchangeView => {
          const response = responses.get(request.id);
          const missing: string[] = [];
          let body: Record<string, unknown> | undefined;
          if (request.unparsed === true || request.truncated !== undefined) {
            missing.push("body");
          } else {
            body = { ...request.params };
            for (const [name, ref] of [
              ["system", request.system],
              ["tools", request.tools],
            ] as const) {
              if (ref === undefined) continue;
              const value = blobOf(ref);
              if (value === undefined) missing.push(name);
              else body[name] = value;
            }
            for (const ref of request.large ?? []) {
              if (ref.slice === undefined) missing.push(ref.field);
              else body[ref.field] = JSON.parse(gunzipAt(path.join(dir, "large.gz"), ref.slice));
            }
            if (request.messages !== undefined) {
              const messages = messagesOf(request.id);
              if (messages === undefined) missing.push("messages");
              else body.messages = applyCacheControl(messages, request.cacheControl ?? []);
            }
            // 第 2 版起按原文的先后排顶层字段
            const order = request.order ?? [];
            const sorted: Record<string, unknown> = body;
            body = {};
            for (const key of [...order, ...Object.keys(sorted)]) {
              if (key in sorted && !(key in body)) body[key] = sorted[key];
            }
          }
          return {
            id: request.id,
            request,
            response,
            body,
            missing,
            exact: body !== undefined && sha256(JSON.stringify(body)) === request.bodySha256,
            reply: () =>
              response?.reply?.slice === undefined
                ? undefined
                : gunzipAt(path.join(dir, "replies.gz"), response.reply.slice),
          };
        });
      tries.push({ seq: s, attempt, exchanges });
    }
  }
  return tries;
}

// 清理：删掉一个作业目录下的全部留存（跑完、转换之后）
export function removeRetention(jobDir: string): void {
  rmSync(path.join(jobDir, RETENTION_DIR), { recursive: true, force: true });
}
