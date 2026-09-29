// 跑批进程内置的模型网关（决策 155、234）：只听回环地址，说 Anthropic Messages 协议，全部条件的模型请求都经它转发；
// 上游为 DeepSeek 的 Anthropic 兼容端点（错误正文为 OpenAI 形状，分类口径见 model-limits.ts）。
//   接入：每个作业用独立路径前缀 /j/<作业>/，网关据此把用量归到作业上；agent 进程与容器只拿到网关地址，真 key 只在网关里注入；
//   账号：一个 key 一个账号，各有并发上限（缺省按官方单账号上限 2500）；请求挑在途占比最低的可用账号，全满则排队
//        （排队时间记到作业上，计入该步墙钟；客户端中止即出队）；同一账号内不轮换 key；每次派发记下当时的退避轮次与该账号的上限；
//   429 与 503：该账号按退避轮次逐级退避（5、15、45 秒）：只有本轮派出的请求（冷却结束之后派出）再撞才升级，同时在途的
//        几路一起撞只算一次；退避期间请求可换到别的账号；45 秒退避之后仍撞即该账号暂时不可用、请求换号；
//   500：不动账号，这次请求按 2、8、30 秒退避重试，仍是 500 即原样交回、记为本作业的上游故障（这一步作废重做）；
//   402 余额不足：该账号不再使用（不探测），请求换号；全部账号都不可用即停批；正文去密钥后记一次日志；
//   403 并发（按文案）：降该账号的并发上限、稍候重试，只有在上限已是 1 时派出的请求仍受限才判该账号暂时不可用；
//        降下的上限每 30 分钟回升 1，直到配置值；
//   401 与认证类 403：该账号停用（不探测恢复，需人工处理），这次请求原样交回并记为本作业的上游故障（这一步作废重做）；
//        开跑前逐账号探测一次，任一账号认证失败或余额不足即拒绝开跑；
//   暂时不可用的账号按 5 至 30 分钟的间隔单独探测（探测占该账号一个在途位子，同一账号只有这一路探测者），通过即恢复；
//        暂停中有账号恢复即通知限额控制器立即恢复整批；余额不足或认证失败的账号不再探测；
//   全部账号都不可用：交给限额控制器整批暂停（都不会自行恢复则停下），控制器的探测只探没在单独探测的账号；
//   暂停或停止期间：直接以 529 拒绝，不打上游——在途 agent 的下一次模型调用即失败，这一步作废、恢复后重做；
//   流式响应：错误在响应头阶段分类；200 之后原样透传，中途断流也原样透传（由 agent 一侧按失败处理），同时从事件流里
//   读出用量按作业计量（请求数即轮数、输入与输出 token、花费、各账号的请求数、排队时间、在途峰值、单次请求输入 token 峰值）。交回客户端与告警的
//   任何文本里都不出现 key（含上游回显的打码末四位），账号只以编号出现。
//   花费（决策 235）：每条成功的请求（含网关自己的探测）按请求开始与结束时刻逐条计价（state/model-pricing.ts），记到作业上并
//   计入全局累计；全局累计落盘，进程重启或续跑时接着累计；累计到上限即交给限额控制器停批。
//   计时（退避、探测间隔、重试等待、上限回升、计价时刻）都经可注入的时钟；close() 取消全部未到的定时。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { requestCostCny } from "../state/model-pricing.ts";
import {
  BACKOFF_DELAYS_MS,
  classifyUpstreamFailure,
  type LimitController,
  type LimitKind,
  PROBE_SCHEDULE_MS,
  parseUpstreamError,
  scrubKeys,
} from "./model-limits.ts";

export interface GatewayMeter {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // 这个作业成功请求的花费（人民币元，按官方价目与高峰时段逐请求计）
  costCny: number;
  // 这个作业的请求遇到的上游故障次数：上游 5xx、转发时连不上上游、200 之后中途断流、账号认证失败。跑批器一步前后
  // 比较它，有变化即这一步作废重做（与限额信号同一口径，不看 agent 自己怎么处理这次故障）
  upstreamFailures: number;
  // 这个作业的请求等空闲账号的累计毫秒（含此刻仍在排队的请求已等的时间）
  queueMs: number;
  // 这个作业同时在途的模型请求数的峰值（自上次 resetPeak 起）
  peakInFlight: number;
  // 这个作业单次请求送进模型的输入 token 最大值（未命中 + 缓存命中 + 缓存写入，自上次 resetPeak 起）：每步的上下文峰值
  peakInputTokens: number;
  // 这个作业成功转发的请求落在各账号上的次数（按账号编号，下标 0 为账号 1）
  accountRequests: number[];
}

export interface GatewayAccount {
  key: string;
  // 这个账号同时在途的请求上限
  concurrency: number;
}

// 缺省的账号并发上限：DeepSeek 官方 deepseek-flash 单账号并发上限 2500（超限返回 429）
export const DEFAULT_ACCOUNT_CONCURRENCY = 2500;
export const MAX_ACCOUNTS = 9;
// 403 并发受限降上限之后、重试之前的等待
export const CONCURRENCY_RETRY_DELAY_MS = 3_000;
// 因 403 并发降下的上限每隔这么久回升 1，直到配置值
export const CAP_REGROW_MS = 30 * 60_000;
// 500 服务器故障：这次请求依次等这么久重试，用满仍是 500 即交回
export const SERVER_ERROR_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 30_000];

// 账号的环境变量前缀
export const ACCOUNT_KEY_ENV = "DEEPSEEK_API_KEY";

// 从环境变量取账号：DEEPSEEK_API_KEY 为账号 1，DEEPSEEK_API_KEY_2、_3… 依次为后续账号（编号须连续，至多 MAX_ACCOUNTS 个；
// 一个账号即可）；各账号并发上限取 DEEPSEEK_API_KEY_<编号>_CONCURRENCY，缺省 2500。跳号、超出上限、并发变量指向不存在的
// 账号、DEEPSEEK_API_KEY_ 前缀下认不出的变量名都响亮报错，不静默忽略；报错只写变量名，不写取值
export function gatewayAccountsFromEnv(env: Record<string, string | undefined>): GatewayAccount[] {
  const base = ACCOUNT_KEY_ENV;
  const keyVar = (n: number) => (n === 1 ? base : `${base}_${n}`);
  const present = (name: string) => (env[name] ?? "") !== "";
  if (!present(base)) throw new Error(`缺少 ${base} 环境变量：网关的真 key 从这里取`);
  const numbered = new Set<number>([1]);
  const concurrencyFor: number[] = [];
  const pattern = new RegExp(`^${base}_(\\d+)(_CONCURRENCY)?$`);
  for (const name of Object.keys(env)) {
    const match = pattern.exec(name);
    if (match === null) {
      if (name.startsWith(`${base}_`)) {
        throw new Error(
          `${name}：认不出的变量名（应为 ${base}_<编号> 或 ${base}_<编号>_CONCURRENCY）`
        );
      }
      continue;
    }
    if (!present(name)) continue;
    const n = Number(match[1]);
    if (String(n) !== match[1] || n < 1)
      throw new Error(`${name}：账号编号写法不对（应为 1、2、3…）`);
    if (match[2] !== undefined) concurrencyFor.push(n);
    else if (n === 1) throw new Error(`设了 ${base}_1：账号 1 的 key 取 ${base}`);
    else numbered.add(n);
  }
  const count = Math.max(...numbered);
  if (count > MAX_ACCOUNTS) {
    throw new Error(`设了 ${keyVar(count)}：账号至多 ${MAX_ACCOUNTS} 个`);
  }
  for (let n = 2; n < count; n++) {
    if (!numbered.has(n))
      throw new Error(`设了 ${keyVar(count)} 却缺 ${keyVar(n)}：账号编号须连续`);
  }
  for (const n of concurrencyFor) {
    if (n > count) {
      throw new Error(`设了 ${base}_${n}_CONCURRENCY 却没有账号 ${n}（共 ${count} 个账号）`);
    }
  }
  const accounts: GatewayAccount[] = [];
  for (let n = 1; n <= count; n++) {
    const name = `${base}_${n}_CONCURRENCY`;
    const raw = env[name];
    const concurrency = raw === undefined || raw === "" ? DEFAULT_ACCOUNT_CONCURRENCY : Number(raw);
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`${name} 需要正整数`);
    accounts.push({ key: env[keyVar(n)] as string, concurrency });
  }
  return accounts;
}

// 开跑前校验（决策 163）：配置路数大于各账号配置并发之和即拒绝开跑，报出两个数
export function assertConcurrencyFits(concurrency: number, accounts: readonly GatewayAccount[]) {
  const total = accounts.reduce((sum, a) => sum + Math.max(1, a.concurrency), 0);
  if (concurrency > total) {
    throw new Error(
      `路数 ${concurrency} 大于各账号配置并发之和 ${total}：拒绝开跑（减路数，或加账号、调高账号并发）`
    );
  }
}

// 网关的计时：现在几点、ms 毫秒之后调用 fn（返回取消函数）
export interface GatewayClock {
  now(): number;
  setTimer(ms: number, fn: () => void): () => void;
}

const REAL_CLOCK: GatewayClock = {
  now: Date.now,
  setTimer: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface ModelGatewayOptions {
  // 上游的 Anthropic Messages 基址（不带末尾斜杠），如 https://host/anthropic
  upstreamBaseUrl: string;
  accounts: readonly GatewayAccount[];
  limits: LimitController;
  // 探测用的极小请求（非流式）
  probeRequest: { path: string; body: unknown };
  backoffDelaysMs?: readonly number[];
  concurrencyRetryDelayMs?: number;
  capRegrowMs?: number;
  serverErrorRetryDelaysMs?: readonly number[];
  // 花费的全局累计与上限：file 为累计落盘的文件（有则启动时接着累计）；limitCny 为上限（人民币元），缺省不设上限
  spend?: { file?: string; limitCny?: number };
  // 缺省为真实时钟（退避按 5、15、45 秒，探测按 5 至 30 分钟真实等待）
  clock?: GatewayClock;
  warn?: (line: string) => void;
}

// 落盘的花费累计
export interface GatewaySpendRecord {
  totalCny: number;
  requests: number;
  // 按高峰价计的请求数
  peakRequests: number;
  updatedAt: string;
}

export interface AccountStatus {
  // 账号编号，从 1 起
  account: number;
  cap: number;
  inFlight: number;
  // 正在 429 退避
  cooling: boolean;
  // 不可用的原因；可用为 null
  down: LimitKind | null;
}

export interface ModelGateway {
  baseUrl: string;
  jobBaseUrl(job: string): string;
  meter(job: string): GatewayMeter;
  // 这个作业此刻在途（含排队）的模型请求数
  jobInFlight(job: string): number;
  // 在途峰值从这个作业当前的在途数重新记、单次请求输入 token 峰值清零（跑批器在每一步开始时调用）
  resetPeak(job: string): void;
  accountStatus(): AccountStatus[];
  // 可用容量（决策 163）：未停用账号当前并发上限之和；429 退避在三级之内属秒级波动，不计入下降
  capacity(): number;
  // 订阅可用容量的变化；返回退订函数
  subscribeCapacity(listener: () => void): () => void;
  // 这个作业自调用起累计等空闲账号超过 thresholdMs 即调用 listener 一次（跑批器据此立即中止在途的一步）；
  // 返回停止看守的函数
  watchQueue(job: string, thresholdMs: number, listener: () => void): () => void;
  // 开跑前：花费累计已到上限即抛错；再逐账号探测一次：凡不是成功、也不是并发、限流、繁忙的（认证失败、余额不足、
  // 认不出的回应、连不上），即抛错并报出账号编号
  preflight(): Promise<void>;
  // 控制器的探测：探没在单独探测的账号（余额不足与认证失败的除外），通过的恢复；有账号探测通过即 true
  probe(): Promise<boolean>;
  // 全局花费累计（含探测，含续跑前落盘的部分）与上限
  spend(): GatewaySpendRecord & { limitCny: number | null };
  close(): Promise<void>;
}

const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "x-api-key",
  "authorization",
  "keep-alive",
  "transfer-encoding",
]);
const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

function emptyMeter(accounts: number): GatewayMeter {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costCny: 0,
    upstreamFailures: 0,
    queueMs: 0,
    peakInFlight: 0,
    peakInputTokens: 0,
    accountRequests: Array.from({ length: accounts }, () => 0),
  };
}

interface AccountState {
  key: string;
  // 配置的并发上限；cap 为当前上限（403 并发会降、隔一段时间回升）
  configCap: number;
  cap: number;
  // 在途请求数，含探测
  inFlight: number;
  // 429 与 503 退避级数：本轮派出的请求成功一次即归零
  level: number;
  // 退避轮次：每开始一次冷却、每恢复一次可用都加一，兼作冷却定时器的代次号——只有本轮的定时器能结束冷却
  round: number;
  // 正在退避：退避期间不派新请求
  cooling: boolean;
  down: LimitKind | null;
  // 正在单独探测恢复（这时它是该账号唯一的探测者）
  recovering: boolean;
  // 正在进行的探测：同一账号同一时刻至多一路，其余复用它的结果
  probing: Promise<ProbeOutcome> | undefined;
  // 上限回升的定时
  regrow: (() => void) | undefined;
  // 最近一次探测非 200 时上游的错误正文（开跑前与探测中转为余额不足或认证失败时，据此写日志）
  probeBody: string | undefined;
}

// 一次派发：账号、派发时的退避轮次与该账号的并发上限
interface Slot {
  index: number;
  round: number;
  cap: number;
}

type ProbeOutcome = "ok" | "fail" | LimitKind;

// 余额不足与认证失败的账号不会自行恢复，不探测
const permanent = (down: LimitKind | null) => down === "balance" || down === "auth";

// 写进日志的错误正文：先去掉配置的 key、上游回显的打码密钥片段与任何形似密钥的内容（sk- 之类前缀的串、Bearer 凭据、
// key/token/secret 字段的值、20 字以上字母数字相混的串），再把空白压成一个空格，取前 200 字
export function redactBody(body: string, keys: readonly (string | undefined)[]): string {
  return scrubKeys(body, keys)
    .replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [已去除]")
    .replace(
      /((?:api[\s_-]?key|access[\s_-]?key|token|secret|authorization|password)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1[已去除]"
    )
    .replace(/\b(?:sk|ak|pk|rk)[-_][A-Za-z0-9_-]{6,}/gi, "[已去除]")
    .replace(/[A-Za-z0-9_\-+/=.]{20,}/g, (t) =>
      /[A-Za-z]/.test(t) && /\d/.test(t) ? "[已去除]" : t
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// 写进日志的上游错误：OpenAI 形状的正文取 type、code 与 message，认不出即整段正文；一律经 redactBody
function describeUpstreamError(body: string, keys: readonly (string | undefined)[]): string {
  const error = parseUpstreamError(body);
  const text =
    error === null
      ? body
      : [error.type, error.code, error.message].filter((x) => x !== null).join("：");
  return redactBody(text, keys);
}

async function readAll(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// 工具定义里的 "type": "custom"（litellm 的 anthropic 线路给每个自定义工具都加）：Anthropic 官方接口视同不写，
// DeepSeek 的兼容接口只认它支持的内置工具类型、见到 custom 即 400。只去掉这些项的 type 后重新序列化；
// 没有这类项、不是合法 JSON、不是对象或 tools 不是数组时原样返回同一份字节（Pigeon 自己的请求不带该字段，
// 前缀缓存不受影响）。其他 type 取值不碰
function stripCustomToolType(body: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
  const tools = (parsed as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return body;
  let changed = false;
  for (const tool of tools) {
    if (typeof tool === "object" && tool !== null && tool.type === "custom") {
      delete tool.type;
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(parsed), "utf8") : body;
}

// 从响应正文里读用量：SSE 取 message_start 的输入与缓存、message_delta 的输出（累计值，取最后一次）；message_delta
// 也带输入与缓存字段时以它为准（DeepSeek 实测两处相同；与 pi-ai 的读法一致）。非流式取正文的 usage。
// input 为缓存未命中的输入（DeepSeek 的 Anthropic 兼容端点实测如此），命中在 cacheRead
function usageOf(
  text: string
): Pick<GatewayMeter, "input" | "output" | "cacheRead" | "cacheWrite"> {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const take = (usage: Record<string, unknown> | undefined) => {
    if (usage === undefined) return;
    const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : undefined);
    out.input = n("input_tokens") ?? out.input;
    out.cacheRead = n("cache_read_input_tokens") ?? out.cacheRead;
    out.cacheWrite = n("cache_creation_input_tokens") ?? out.cacheWrite;
    out.output = n("output_tokens") ?? out.output;
  };
  const events = text.split("\n").filter((l) => l.startsWith("data:"));
  if (events.length === 0) {
    try {
      const body = JSON.parse(text) as { usage?: Record<string, unknown> };
      take(body.usage);
    } catch {
      // 不是 JSON：没有用量可读
    }
    return out;
  }
  for (const line of events) {
    try {
      const event = JSON.parse(line.slice(5).trim()) as {
        type?: string;
        message?: { usage?: Record<string, unknown> };
        usage?: Record<string, unknown>;
      };
      if (event.type === "message_start") take(event.message?.usage);
      if (event.type === "message_delta") take(event.usage);
    } catch {
      // 非 JSON 的 data 行（如 [DONE]）
    }
  }
  return out;
}

export async function startModelGateway(options: ModelGatewayOptions): Promise<ModelGateway> {
  const accounts: AccountState[] = options.accounts
    .filter((a) => a.key !== "")
    .map((a) => ({
      key: a.key,
      configCap: Math.max(1, a.concurrency),
      cap: Math.max(1, a.concurrency),
      inFlight: 0,
      level: 0,
      round: 0,
      cooling: false,
      down: null,
      recovering: false,
      probing: undefined,
      regrow: undefined,
      probeBody: undefined,
    }));
  if (accounts.length === 0) throw new Error("网关至少需要一个账号");
  const keys = accounts.map((a) => a.key);
  const delays = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;
  const concurrencyRetryDelayMs = options.concurrencyRetryDelayMs ?? CONCURRENCY_RETRY_DELAY_MS;
  const capRegrowMs = options.capRegrowMs ?? CAP_REGROW_MS;
  const serverErrorDelays = options.serverErrorRetryDelaysMs ?? SERVER_ERROR_RETRY_DELAYS_MS;
  const clock = options.clock ?? REAL_CLOCK;
  const now = () => clock.now();
  const warn = options.warn ?? ((line: string) => process.stderr.write(`[网关] ${line}\n`));
  const warned = new Set<string>();
  const warnOnce = (id: string, line: string) => {
    if (warned.has(id)) return;
    warned.add(id);
    warn(line);
  };
  const meters = new Map<string, GatewayMeter>();
  const jobInFlight = new Map<string, number>();
  const meterOf = (job: string) => {
    let m = meters.get(job);
    if (m === undefined) {
      m = emptyMeter(accounts.length);
      meters.set(job, m);
    }
    return m;
  };
  // 花费的全局累计（含探测）：有落盘文件即接着累计；每记一笔即整份落盘（先写临时文件再改名，不留半截）
  const spendFile = options.spend?.file;
  const spendLimit = options.spend?.limitCny ?? null;
  const spent: GatewaySpendRecord = {
    totalCny: 0,
    requests: 0,
    peakRequests: 0,
    updatedAt: new Date(now()).toISOString(),
  };
  if (spendFile !== undefined && existsSync(spendFile)) {
    const saved = JSON.parse(readFileSync(spendFile, "utf8")) as Partial<GatewaySpendRecord>;
    if (typeof saved.totalCny !== "number" || !Number.isFinite(saved.totalCny)) {
      throw new Error(`花费累计文件 ${spendFile} 认不出（缺 totalCny）：拒绝接着累计，请人工检查`);
    }
    spent.totalCny = saved.totalCny;
    spent.requests = saved.requests ?? 0;
    spent.peakRequests = saved.peakRequests ?? 0;
  }
  const overSpend = () => spendLimit !== null && spent.totalCny >= spendLimit;
  // 记一条成功请求的花费：按开始与结束时刻计价，记到作业（探测没有作业）与全局累计；到上限即交给控制器停批
  const chargeRequest = (
    job: string | undefined,
    usage: ReturnType<typeof usageOf>,
    startMs: number,
    endMs: number
  ) => {
    const { cny, peak } = requestCostCny(usage, startMs, endMs);
    if (job !== undefined) meterOf(job).costCny += cny;
    spent.totalCny += cny;
    spent.requests += 1;
    if (peak) spent.peakRequests += 1;
    spent.updatedAt = new Date(endMs).toISOString();
    if (spendFile !== undefined) {
      const tmp = `${spendFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(spent)}\n`);
      renameSync(tmp, spendFile);
    }
    if (overSpend()) options.limits.spendLimitReached(spent.totalCny, spendLimit as number);
  };
  const label = (i: number) => `账号 ${i + 1}`;
  let closed = false;
  // 关闭时中止探测请求
  const closing = new AbortController();

  // 定时：全部登记在案，close() 一并取消；等待中的 delay 在关闭时提前返回
  const timers = new Set<() => void>();
  const wakeOnClose = new Set<() => void>();
  const later = (ms: number, fn: () => void): (() => void) => {
    // 已关闭：不再新设定时
    if (closed) return () => {};
    let cancel = () => {};
    const stop = () => {
      timers.delete(stop);
      cancel();
    };
    cancel = clock.setTimer(ms, () => {
      timers.delete(stop);
      if (!closed) fn();
    });
    timers.add(stop);
    return stop;
  };
  const delay = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (closed || signal?.aborted === true) {
        resolve();
        return;
      }
      const finish = () => {
        stop();
        wakeOnClose.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const stop = later(ms, finish);
      wakeOnClose.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });

  // 等空闲账号的请求（先来先派）：每次有位子空出即全部唤醒重挑；客户端中止的即刻出队
  const queue: (() => void)[] = [];
  const pump = () => {
    for (const wake of queue.splice(0)) wake();
  };
  const nextPump = (signal?: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      if (signal?.aborted === true) {
        resolve(false);
        return;
      }
      const onAbort = () => {
        const i = queue.indexOf(wake);
        if (i !== -1) queue.splice(i, 1);
        resolve(false);
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      };
      queue.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  // 此刻仍在排队的请求：计量读出时把已等的时间算进去
  const waits = new Set<{ job: string; since: number }>();
  // 作业累计等空闲账号的毫秒（已结算的加上仍在排队的已等时间）
  const queueTotal = (job: string) => {
    let total = meterOf(job).queueMs;
    for (const w of waits) if (w.job === job) total += now() - w.since;
    return total;
  };
  // 排队看守：作业自登记起累计排队超过阈值即通知一次。有请求在排队时按"剩余额度 ÷ 在排队的请求数"定时复查，
  // 排队开始与结束时也复查
  interface QueueWatch {
    job: string;
    base: number;
    thresholdMs: number;
    listener: () => void;
    fired: boolean;
    stop: (() => void) | undefined;
  }
  const queueWatches = new Set<QueueWatch>();
  const recheckQueue = (job: string) => {
    for (const w of queueWatches) {
      if (w.job !== job || w.fired) continue;
      w.stop?.();
      w.stop = undefined;
      const used = queueTotal(job) - w.base;
      if (used > w.thresholdMs) {
        w.fired = true;
        w.listener();
        continue;
      }
      let live = 0;
      for (const q of waits) if (q.job === job) live += 1;
      if (live > 0) {
        w.stop = later(Math.floor((w.thresholdMs - used) / live) + 1, () => recheckQueue(job));
      }
    }
  };

  const usable = () => accounts.some((a) => a.down === null);
  // 可用容量：未停用账号当前并发上限之和（退避中的账号照算：三级之内属秒级波动）
  const capacity = () => accounts.reduce((sum, a) => (a.down === null ? sum + a.cap : sum), 0);
  const capacityListeners = new Set<() => void>();
  const capacityChanged = () => {
    for (const listener of [...capacityListeners]) listener();
  };
  // 挑在途占比最低的空闲账号（同占比取编号小的）；没有则 -1
  const pick = (): number => {
    let best = -1;
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i] as AccountState;
      if (a.down !== null || a.cooling || a.inFlight >= a.cap) continue;
      const b = best === -1 ? undefined : (accounts[best] as AccountState);
      if (b === undefined || a.inFlight / a.cap < b.inFlight / b.cap) best = i;
    }
    return best;
  };
  // 占一个账号的位子；没有可用账号（全部不可用或整批已暂停）为 none，客户端中止为 aborted。排队的时间记到作业上
  const acquire = async (job: string, signal: AbortSignal): Promise<Slot | "none" | "aborted"> => {
    let wait: { job: string; since: number } | undefined;
    try {
      for (;;) {
        if (signal.aborted) return "aborted";
        if (closed || options.limits.state !== "running" || !usable()) return "none";
        const index = pick();
        if (index !== -1) {
          const account = accounts[index] as AccountState;
          account.inFlight += 1;
          return { index, round: account.round, cap: account.cap };
        }
        if (wait === undefined) {
          wait = { job, since: now() };
          waits.add(wait);
          recheckQueue(job);
        }
        if (!(await nextPump(signal))) return "aborted";
      }
    } finally {
      if (wait !== undefined) {
        waits.delete(wait);
        meterOf(job).queueMs += now() - wait.since;
        recheckQueue(job);
      }
    }
  };
  const release = (index: number) => {
    (accounts[index] as AccountState).inFlight -= 1;
    pump();
  };

  // 429 与 503：只有本轮派出的请求才推进退避（派出之后该账号已开始新一轮冷却或已恢复，这次属于处理过的那一轮）；
  // 45 秒退避之后仍撞即该账号暂时不可用。两种原因共用同一退避级数
  const backoff = (slot: Slot, kind: "rate-limit" | "busy") => {
    const account = accounts[slot.index] as AccountState;
    if (account.down !== null || slot.round !== account.round) return;
    if (account.level >= delays.length) {
      takeDown(slot.index, kind);
      return;
    }
    const ms = delays[account.level] ?? 0;
    warnOnce(
      `backoff-${slot.index}-${account.level}`,
      `${label(slot.index)}${kind === "busy" ? "报服务器繁忙（503）" : "撞频率限制（429）"}，第 ${account.level + 1} 次退避 ${Math.round(ms / 1000)} 秒（上限 ${delays.length} 次）；退避期间请求派给其他账号`
    );
    account.level += 1;
    account.round += 1;
    account.cooling = true;
    const round = account.round;
    later(ms, () => {
      if (account.round !== round) return;
      account.cooling = false;
      pump();
    });
  };

  // 403 并发：降该账号的上限（派出之后没降过才降），隔一段时间回升 1，直到配置值
  const lowerCap = (slot: Slot) => {
    const account = accounts[slot.index] as AccountState;
    if (account.cap !== slot.cap || account.cap <= 1) return;
    account.cap -= 1;
    warn(
      `${label(slot.index)}报并发受限：该账号并发上限降为 ${account.cap}，稍候重试；每 ${Math.round(capRegrowMs / 60_000)} 分钟回升 1，直到 ${account.configCap}`
    );
    account.regrow?.();
    account.regrow = later(capRegrowMs, () => regrow(slot.index));
    capacityChanged();
  };
  const regrow = (index: number) => {
    const account = accounts[index] as AccountState;
    account.regrow = undefined;
    if (account.cap >= account.configCap) return;
    if (account.down === null) {
      account.cap += 1;
      warn(`${label(index)}并发上限回升为 ${account.cap}`);
      pump();
      capacityChanged();
    }
    if (account.cap < account.configCap) account.regrow = later(capRegrowMs, () => regrow(index));
  };

  // 探测一个账号：占该账号一个在途位子（满了等空出），同一账号同一时刻至多一路探测，其余复用它的结果
  const probeAccount = (index: number): Promise<ProbeOutcome> => {
    const account = accounts[index] as AccountState;
    account.probing ??= (async (): Promise<ProbeOutcome> => {
      while (!closed && account.inFlight >= account.cap) await nextPump();
      if (closed) return "fail";
      account.inFlight += 1;
      try {
        const startMs = now();
        const r = await fetch(`${options.upstreamBaseUrl}${options.probeRequest.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": account.key,
          },
          body: JSON.stringify(options.probeRequest.body),
          signal: closing.signal,
        });
        const text = await r.text();
        if (r.status === 200) {
          // 探测同样计入花费（决策 235）
          chargeRequest(undefined, usageOf(text), startMs, now());
          return "ok";
        }
        account.probeBody = text;
        const failure = classifyUpstreamFailure(r.status, text);
        return failure.kind === "other" || failure.kind === "server" ? "fail" : failure.kind;
      } catch {
        return "fail";
      } finally {
        account.probing = undefined;
        release(index);
      }
    })();
    return account.probing;
  };
  // 恢复；恢复了或本来就可用返回 true
  const restore = (index: number): boolean => {
    const account = accounts[index] as AccountState;
    // 本来就可用：探测通过即算通过
    if (account.down === null) return true;
    if (permanent(account.down)) return false;
    account.down = null;
    account.level = 0;
    account.round += 1;
    account.cooling = false;
    warn(`${label(index)}探测通过，恢复可用`);
    // 整批暂停中有账号恢复：立即恢复整批，不等控制器的下一轮探测
    options.limits.recovered();
    pump();
    capacityChanged();
    return true;
  };
  // 按探测结果处理：通过即恢复；认证失败或余额不足即转为不再恢复。恢复了为 true
  const settleProbe = (index: number, outcome: ProbeOutcome): boolean => {
    if (outcome === "ok") return restore(index);
    if (permanent(outcome as LimitKind)) {
      takeDown(index, outcome as LimitKind, (accounts[index] as AccountState).probeBody);
    }
    return false;
  };
  // 暂时不可用的账号单独探测，通过即恢复；余额不足与认证失败的不探测（探测中转为这两种即停止）
  const recover = async (index: number) => {
    const account = accounts[index] as AccountState;
    if (account.recovering) return;
    account.recovering = true;
    try {
      for (let i = 0; !closed && account.down !== null && !permanent(account.down); i++) {
        await delay(PROBE_SCHEDULE_MS[Math.min(i, PROBE_SCHEDULE_MS.length - 1)] ?? 0);
        if (closed || account.down === null || permanent(account.down)) return;
        settleProbe(index, await probeAccount(index));
      }
    } finally {
      account.recovering = false;
    }
  };
  const downLine = (index: number, kind: LimitKind) => {
    const who = label(index);
    if (kind === "balance") return `${who}余额不足：不再使用，充值后续跑`;
    if (kind === "auth") return `${who}认证失败：停用，不探测恢复，需人工检查它的 key`;
    const why =
      kind === "rate-limit"
        ? "退避用满仍撞频率限制"
        : kind === "busy"
          ? "退避用满仍报服务器繁忙"
          : "并发上限已是 1 仍受限";
    return `${who}${why}，暂时不可用；按 5 至 30 分钟的间隔探测恢复`;
  };
  // 账号不可用：还有可用账号即只停它、请求换号；全部不可用即交给控制器整批暂停，都不会自行恢复则停下
  const takeDown = (index: number, kind: LimitKind, body?: string) => {
    const account = accounts[index] as AccountState;
    // 已经不可用的，只有转为不会自行恢复的原因才改记
    if (account.down === kind || (account.down !== null && !permanent(kind))) return;
    account.down = kind;
    account.cooling = false;
    if (permanent(kind) && body !== undefined) {
      warn(`${label(index)}上游错误（已去密钥）：${describeUpstreamError(body, keys)}`);
    }
    capacityChanged();
    warn(`${downLine(index, kind)}${usable() ? "，请求换到其他账号" : ""}`);
    if (!permanent(kind)) void recover(index);
    if (!usable()) {
      const recoverable = accounts.find((a) => !permanent(a.down));
      if (recoverable === undefined) {
        options.limits.onLimit(accounts.some((a) => a.down === "auth") ? "auth" : "balance");
      } else if (options.limits.state === "running") {
        // 整批暂停的原因：最后倒下的账号不会自行恢复时，取一个能恢复的账号的原因
        options.limits.onLimit(permanent(kind) ? (recoverable.down ?? kind) : kind);
      }
    }
    pump();
  };

  const send = (res: http.ServerResponse, status: number, body: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };
  const paused = (res: http.ServerResponse) =>
    send(
      res,
      529,
      anthropicError(
        "overloaded_error",
        `网关暂停：模型服务额度受限（${options.limits.state === "stopped" ? "已停止" : "等待恢复"}），这一步作废、恢复后重做`
      )
    );

  const upstreamHeaders = (incoming: http.IncomingHttpHeaders, key: string): Headers => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming)) {
      if (DROP_REQUEST_HEADERS.has(name) || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("x-api-key", key);
    if (incoming.authorization !== undefined) headers.set("authorization", `Bearer ${key}`);
    return headers;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const match = /^\/j\/([^/]+)(\/.*)$/.exec(req.url ?? "");
    if (match === null) {
      send(res, 404, anthropicError("not_found_error", "网关路径应为 /j/<作业>/…"));
      return;
    }
    const job = decodeURIComponent(match[1] ?? "");
    const rest = match[2] ?? "/";
    if (options.limits.state !== "running") {
      paused(res);
      return;
    }
    // 先注册客户端断开的监听，再读请求体：读请求体期间断开也能认出
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const body = stripCustomToolType(await readAll(req));
    if (abort.signal.aborted) return;
    const inFlight = (jobInFlight.get(job) ?? 0) + 1;
    jobInFlight.set(job, inFlight);
    const meter = meterOf(job);
    meter.peakInFlight = Math.max(meter.peakInFlight, inFlight);
    // 连不上上游或中途断流记为这个作业的上游故障；客户端自己断开（agent 撞上限被中止等）不算
    try {
      await forward();
    } catch (error) {
      if (!abort.signal.aborted) meterOf(job).upstreamFailures += 1;
      throw error;
    } finally {
      jobInFlight.set(job, (jobInFlight.get(job) ?? 1) - 1);
    }

    async function forward(): Promise<void> {
      // 最近一次上游的非 200 回应：全部账号都不可用时原样交回它
      let last: { status: number; contentType: string; text: string } | undefined;
      // 这次请求因 500 已重试的次数
      let serverRetries = 0;
      for (;;) {
        const slot = await acquire(job, abort.signal);
        if (slot === "aborted") return;
        if (slot === "none") {
          if (last === undefined || options.limits.state === "running") paused(res);
          else {
            res.writeHead(last.status, { "content-type": last.contentType });
            res.end(scrubKeys(last.text, keys));
          }
          return;
        }
        const index = slot.index;
        const account = accounts[index] as AccountState;
        // 位子在这次尝试结束时一定释放：读错误正文时客户端中止或上游断开也不漏
        let released = false;
        const free = () => {
          if (released) return;
          released = true;
          release(index);
        };
        try {
          const startMs = now();
          const upstream = await fetch(`${options.upstreamBaseUrl}${rest}`, {
            method: req.method ?? "POST",
            headers: upstreamHeaders(req.headers, account.key),
            ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
            signal: abort.signal,
          });
          if (upstream.status !== 200) {
            const contentType = upstream.headers.get("content-type") ?? "application/json";
            const text = await upstream.text();
            free();
            const failure = classifyUpstreamFailure(upstream.status, text);
            if (failure.kind === "rate-limit" || failure.kind === "busy") {
              last = { status: upstream.status, contentType, text };
              backoff(slot, failure.kind);
              continue;
            }
            if (failure.kind === "server" && serverRetries < serverErrorDelays.length) {
              // 500：不动账号，这次请求等一会儿重试（位子已释放，重试时重新挑账号）
              const ms = serverErrorDelays[serverRetries] ?? 0;
              serverRetries += 1;
              warnOnce(
                `server-${serverRetries}`,
                `上游服务器故障（500），第 ${serverRetries} 次重试前等 ${Math.round(ms / 1000)} 秒（上限 ${serverErrorDelays.length} 次，用满仍失败即这一步作废重做）`
              );
              await delay(ms, abort.signal);
              if (abort.signal.aborted) return;
              continue;
            }
            if (failure.kind === "concurrency") {
              last = { status: upstream.status, contentType, text };
              if (slot.cap <= 1) takeDown(index, "concurrency");
              else {
                lowerCap(slot);
                await delay(concurrencyRetryDelayMs, abort.signal);
                if (abort.signal.aborted) return;
              }
              continue;
            }
            if (failure.kind === "auth") {
              // 认证失败：停用该账号，这次请求交回、记为上游故障——这一步作废重做，不以认证错误判题
              takeDown(index, "auth", text);
              meterOf(job).upstreamFailures += 1;
            } else if (failure.kind === "balance") {
              // 余额不足：该账号不再使用、请求换号；全部账号都不可用即停批（限额信号使这一步作废，续跑时重做），
              // 不交回当作真失败
              last = { status: upstream.status, contentType, text };
              takeDown(index, "balance", text);
              continue;
            } else if (upstream.status >= 500 || upstream.status === 403) {
              // 5xx（含重试用满的 500）与认不出的 403：原样交回、记上游故障（这一步作废），不停用账号
              meterOf(job).upstreamFailures += 1;
            }
            res.writeHead(upstream.status, { "content-type": contentType });
            res.end(scrubKeys(text, keys));
            return;
          }
          if (slot.round === account.round) account.level = 0;
          const headers: Record<string, string> = {};
          upstream.headers.forEach((value, name) => {
            if (!DROP_RESPONSE_HEADERS.has(name)) headers[name] = value;
          });
          res.writeHead(200, headers);
          const meter = meterOf(job);
          meter.requests += 1;
          meter.accountRequests[index] = (meter.accountRequests[index] ?? 0) + 1;
          const decoder = new TextDecoder();
          let text = "";
          if (upstream.body !== null) {
            for await (const chunk of upstream.body) {
              res.write(chunk);
              text += decoder.decode(chunk as Uint8Array, { stream: true });
            }
          }
          res.end();
          const usage = usageOf(text);
          meter.input += usage.input;
          meter.output += usage.output;
          meter.cacheRead += usage.cacheRead;
          meter.cacheWrite += usage.cacheWrite;
          meter.peakInputTokens = Math.max(
            meter.peakInputTokens,
            usage.input + usage.cacheRead + usage.cacheWrite
          );
          chargeRequest(job, usage, startMs, now());
          return;
        } finally {
          free();
        }
      }
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const reason = scrubKeys(error instanceof Error ? error.message : String(error), keys);
      if (!res.headersSent) send(res, 502, anthropicError("api_error", `网关转发失败：${reason}`));
      else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    jobBaseUrl: (job) => `${baseUrl}/j/${encodeURIComponent(job)}`,
    meter: (job) => {
      const m = meterOf(job);
      let queueMs = m.queueMs;
      for (const w of waits) if (w.job === job) queueMs += now() - w.since;
      return { ...m, queueMs, accountRequests: [...m.accountRequests] };
    },
    jobInFlight: (job) => jobInFlight.get(job) ?? 0,
    resetPeak: (job) => {
      meterOf(job).peakInFlight = jobInFlight.get(job) ?? 0;
      meterOf(job).peakInputTokens = 0;
    },
    accountStatus: () =>
      accounts.map((a, i) => ({
        account: i + 1,
        cap: a.cap,
        inFlight: a.inFlight,
        cooling: a.cooling,
        down: a.down,
      })),
    capacity,
    subscribeCapacity: (listener) => {
      capacityListeners.add(listener);
      return () => {
        capacityListeners.delete(listener);
      };
    },
    watchQueue: (job, thresholdMs, listener) => {
      const w: QueueWatch = {
        job,
        base: queueTotal(job),
        thresholdMs,
        listener,
        fired: false,
        stop: undefined,
      };
      queueWatches.add(w);
      recheckQueue(job);
      return () => {
        w.stop?.();
        queueWatches.delete(w);
      };
    },
    async preflight() {
      if (overSpend()) {
        throw new Error(
          `模型花费累计 ¥${spent.totalCny.toFixed(2)} 已到上限 ¥${spendLimit}：拒绝开跑（调高上限后续跑）`
        );
      }
      const outcomes = await Promise.all(accounts.map((_, i) => probeAccount(i)));
      // 并发、限流、繁忙开跑后按常规处理；其余（认证失败、余额不足、认不出的回应、连不上）交给人查
      const bad = outcomes.flatMap((o, i) =>
        o === "auth"
          ? [`${label(i)}（认证失败）`]
          : o === "balance"
            ? [`${label(i)}（余额不足）`]
            : o === "fail"
              ? [`${label(i)}（认不出的回应或连不上）`]
              : []
      );
      if (bad.length > 0) {
        throw new Error(
          `开跑前逐账号探测未通过：${bad.join("、")}，拒绝开跑，请检查对应的 key、余额与上游`
        );
      }
      for (const [i, o] of outcomes.entries()) {
        if (o !== "ok") warn(`${label(i)}开跑前探测撞上限额（${o}），开跑后按常规处理`);
      }
    },
    async probe() {
      // 正在单独探测的账号由它自己的探测负责（同一账号只有一路探测者），恢复时即通知控制器；这里只探其余的
      const candidates = accounts
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => !permanent(a.down) && !a.recovering);
      const outcomes = await Promise.all(
        candidates.map(async ({ i }) => settleProbe(i, await probeAccount(i)))
      );
      return outcomes.some(Boolean);
    },
    spend: () => ({ ...spent, limitCny: spendLimit }),
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
        closing.abort();
        for (const stop of [...timers]) stop();
        for (const finish of [...wakeOnClose]) finish();
        pump();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function meterDelta(after: GatewayMeter, before: GatewayMeter): GatewayMeter {
  return {
    requests: after.requests - before.requests,
    input: after.input - before.input,
    output: after.output - before.output,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
    costCny: after.costCny - before.costCny,
    upstreamFailures: after.upstreamFailures - before.upstreamFailures,
    queueMs: after.queueMs - before.queueMs,
    // 峰值不做差：跑批器在一步开始时 resetPeak，结束时读到的即这一步的峰值
    peakInFlight: after.peakInFlight,
    peakInputTokens: after.peakInputTokens,
    accountRequests: after.accountRequests.map((n, i) => n - (before.accountRequests[i] ?? 0)),
  };
}
