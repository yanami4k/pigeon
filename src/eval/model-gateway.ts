// 跑批进程内置的模型网关（决策 155）：只听回环地址，说 Anthropic Messages 协议，四个条件的模型请求都经它转发。
//   接入：每个作业用独立路径前缀 /j/<作业>/，网关据此把用量归到作业上；agent 进程与容器只拿到网关地址，真 key 只在网关里注入；
//   账号：一个 key 一个账号，各有并发上限（缺省 2）；请求挑在途占比最低的可用账号，全满则排队（排队时间记到作业上，
//        计入该步墙钟）；同一账号内不轮换 key；
//   429：该账号逐级退避（退避期间请求可换到别的账号），退避用满仍撞即该账号暂时不可用、请求换号；
//   403 额度：只停该账号、请求换号透明重试；403 并发：降该账号的并发上限后重试，已是 1 仍受限即该账号暂时不可用；
//        认证类原样交回；
//   暂时不可用的账号按 5 至 30 分钟的间隔单独探测、通过即恢复；每月额度用完的账号不再恢复；
//   全部账号都不可用：交给限额控制器整批暂停（全是每月额度则停下），控制器的探测经这里逐个探测账号；
//   暂停或停止期间：直接以 529 拒绝，不打上游——在途 agent 的下一次模型调用即失败，这一步作废、恢复后重做；
//   流式响应：错误在响应头阶段分类；200 之后原样透传，中途断流也原样透传（由 agent 一侧按失败处理），同时从事件流里
//   读出用量按作业计量（请求数即轮数、输入与输出 token、各账号的请求数、排队时间、在途峰值）。交回客户端与告警的
//   任何文本里都不出现 key，账号只以编号出现。
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  BACKOFF_DELAYS_MS,
  classifyUpstreamFailure,
  type LimitController,
  type LimitKind,
  PROBE_SCHEDULE_MS,
  scrubKeys,
} from "./model-limits.ts";

export interface GatewayMeter {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // 这个作业的请求遇到的上游故障次数：上游 5xx、转发时连不上上游、200 之后中途断流。跑批器一步前后比较它，
  // 有变化即这一步作废重做（与限额信号同一口径，不看 agent 自己怎么处理这次故障）
  upstreamFailures: number;
  // 这个作业的请求等空闲账号的累计毫秒
  queueMs: number;
  // 这个作业同时在途的模型请求数的峰值（自上次 resetPeak 起）
  peakInFlight: number;
  // 这个作业成功转发的请求落在各账号上的次数（按账号编号，下标 0 为账号 1）
  accountRequests: number[];
}

export interface GatewayAccount {
  key: string;
  // 这个账号同时在途的请求上限
  concurrency: number;
}

export const DEFAULT_ACCOUNT_CONCURRENCY = 2;
const MAX_ACCOUNTS = 9;

// 从环境变量取账号：KIMI_API_KEY 为账号 1，KIMI_API_KEY_2、_3… 依次为后续账号（编号须连续）；
// 各账号并发上限取 KIMI_API_KEY_<编号>_CONCURRENCY，缺省 2
export function gatewayAccountsFromEnv(env: Record<string, string | undefined>): GatewayAccount[] {
  const keyVar = (n: number) => (n === 1 ? "KIMI_API_KEY" : `KIMI_API_KEY_${n}`);
  const present = (n: number) => (env[keyVar(n)] ?? "") !== "";
  if (!present(1)) throw new Error("缺少 KIMI_API_KEY 环境变量：网关的真 key 从这里取");
  let count = 1;
  while (count < MAX_ACCOUNTS && present(count + 1)) count += 1;
  for (let n = count + 2; n <= MAX_ACCOUNTS; n++) {
    if (present(n)) throw new Error(`设了 ${keyVar(n)} 却缺 ${keyVar(count + 1)}：账号编号须连续`);
  }
  const accounts: GatewayAccount[] = [];
  for (let n = 1; n <= count; n++) {
    const name = `KIMI_API_KEY_${n}_CONCURRENCY`;
    const raw = env[name];
    const concurrency = raw === undefined || raw === "" ? DEFAULT_ACCOUNT_CONCURRENCY : Number(raw);
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`${name} 需要正整数`);
    accounts.push({ key: env[keyVar(n)] as string, concurrency });
  }
  return accounts;
}

export interface ModelGatewayOptions {
  // 上游的 Anthropic Messages 基址（不带末尾斜杠），如 https://host/coding
  upstreamBaseUrl: string;
  accounts: readonly GatewayAccount[];
  limits: LimitController;
  // 探测用的极小请求
  probeRequest: { path: string; body: unknown };
  backoffDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  // 暂时不可用的账号单独探测的间隔等待（缺省按 5 至 30 分钟的探测间隔真实等待）
  recoverySleep?: (ms: number) => Promise<void>;
  now?: () => number;
  warn?: (line: string) => void;
}

export interface AccountStatus {
  // 账号编号，从 1 起
  account: number;
  cap: number;
  inFlight: number;
  // 不可用的原因；可用为 null
  down: LimitKind | null;
}

export interface ModelGateway {
  baseUrl: string;
  jobBaseUrl(job: string): string;
  meter(job: string): GatewayMeter;
  // 在途峰值从这个作业当前的在途数重新记（跑批器在每一步开始时调用）
  resetPeak(job: string): void;
  accountStatus(): AccountStatus[];
  // 逐个探测不可用（每月额度除外）的账号，通过的恢复；有账号可用即 true
  probe(): Promise<boolean>;
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
    upstreamFailures: 0,
    queueMs: 0,
    peakInFlight: 0,
    accountRequests: Array.from({ length: accounts }, () => 0),
  };
}

interface AccountState {
  key: string;
  cap: number;
  inFlight: number;
  // 429 退避级数：成功一次即归零
  level: number;
  // 正在退避：退避期间不派新请求
  cooling: boolean;
  down: LimitKind | null;
  recovering: boolean;
}

async function readAll(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// 从响应正文里读用量：SSE 取 message_start 的输入与缓存、message_delta 的输出（累计值，取最后一次）；
// 非流式取正文的 usage
function usageOf(
  text: string
): Pick<GatewayMeter, "input" | "output" | "cacheRead" | "cacheWrite"> {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const take = (usage: Record<string, unknown> | undefined, final: boolean) => {
    if (usage === undefined) return;
    const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : undefined);
    if (!final) {
      out.input = n("input_tokens") ?? out.input;
      out.cacheRead = n("cache_read_input_tokens") ?? out.cacheRead;
      out.cacheWrite = n("cache_creation_input_tokens") ?? out.cacheWrite;
    }
    out.output = n("output_tokens") ?? out.output;
  };
  const events = text.split("\n").filter((l) => l.startsWith("data:"));
  if (events.length === 0) {
    try {
      const body = JSON.parse(text) as { usage?: Record<string, unknown> };
      take(body.usage, false);
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
      if (event.type === "message_start") take(event.message?.usage, false);
      if (event.type === "message_delta") take(event.usage, true);
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
      cap: Math.max(1, a.concurrency),
      inFlight: 0,
      level: 0,
      cooling: false,
      down: null,
      recovering: false,
    }));
  if (accounts.length === 0) throw new Error("网关至少需要一个账号");
  const keys = accounts.map((a) => a.key);
  const delays = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;
  const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const sleep = options.sleep ?? realSleep;
  const recoverySleep = options.recoverySleep ?? realSleep;
  const now = options.now ?? Date.now;
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
  const label = (i: number) => `账号 ${i + 1}`;
  let closed = false;
  // 等空闲账号的请求（先来先派）
  const queue: (() => void)[] = [];
  const pump = () => {
    for (const wake of queue.splice(0)) wake();
  };

  const usable = () => accounts.some((a) => a.down === null);
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
  // 占一个账号的位子；没有可用账号（全部不可用或整批已暂停）返回 -1。排队的时间记到作业上
  const acquire = async (job: string): Promise<number> => {
    let waitedFrom: number | undefined;
    for (;;) {
      if (options.limits.state !== "running" || !usable()) {
        if (waitedFrom !== undefined) meterOf(job).queueMs += now() - waitedFrom;
        return -1;
      }
      const index = pick();
      if (index !== -1) {
        if (waitedFrom !== undefined) meterOf(job).queueMs += now() - waitedFrom;
        (accounts[index] as AccountState).inFlight += 1;
        return index;
      }
      waitedFrom ??= now();
      await new Promise<void>((resolve) => queue.push(resolve));
    }
  };
  const release = (index: number) => {
    (accounts[index] as AccountState).inFlight -= 1;
    pump();
  };
  const cool = (index: number, ms: number) => {
    const account = accounts[index] as AccountState;
    account.cooling = true;
    void sleep(ms).then(() => {
      account.cooling = false;
      pump();
    });
  };

  const probeAccount = async (index: number): Promise<boolean> => {
    try {
      const r = await fetch(`${options.upstreamBaseUrl}${options.probeRequest.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": (accounts[index] as AccountState).key,
        },
        body: JSON.stringify(options.probeRequest.body),
      });
      await r.body?.cancel();
      return r.status === 200;
    } catch {
      return false;
    }
  };
  const restore = (index: number) => {
    const account = accounts[index] as AccountState;
    if (account.down === null) return;
    account.down = null;
    account.level = 0;
    account.cooling = false;
    warn(`${label(index)}探测通过，恢复可用`);
    pump();
  };
  // 暂时不可用的账号单独探测，通过即恢复；每月额度用完的不探测
  const recover = async (index: number) => {
    const account = accounts[index] as AccountState;
    if (account.recovering || account.down === "monthly") return;
    account.recovering = true;
    try {
      for (let i = 0; !closed && account.down !== null; i++) {
        await recoverySleep(PROBE_SCHEDULE_MS[Math.min(i, PROBE_SCHEDULE_MS.length - 1)] ?? 0);
        if (closed || account.down === null) return;
        if (await probeAccount(index)) restore(index);
      }
    } finally {
      account.recovering = false;
    }
  };
  // 账号不可用：还有可用账号即只停它、请求换号；全部不可用即交给控制器整批暂停（全是每月额度则停下）
  const takeDown = (index: number, kind: LimitKind) => {
    const account = accounts[index] as AccountState;
    account.down = kind;
    account.cooling = false;
    if (usable()) {
      warn(
        kind === "monthly"
          ? `${label(index)}每月额度用完：不再使用，请求换到其他账号`
          : `${label(index)}${kind === "rate-limit" ? "退避用满仍撞频率限制" : kind === "concurrency" ? "并发上限已是 1 仍受限" : "额度用完"}，暂时不可用，请求换到其他账号；按 5 至 30 分钟的间隔探测恢复`
      );
      void recover(index);
      return;
    }
    // 整批暂停的原因：全部账号都是每月额度用完则停下；最后倒下的账号是每月额度时，取另一个能恢复的账号的原因
    const recoverable = accounts.find((a) => a.down !== "monthly");
    options.limits.onLimit(
      recoverable === undefined ? "monthly" : kind === "monthly" ? (recoverable.down ?? kind) : kind
    );
    for (const [i, a] of accounts.entries()) {
      if (a.down !== "monthly") void recover(i);
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
    const body = await readAll(req);
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
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
      for (;;) {
        const index = await acquire(job);
        if (index === -1) {
          if (last === undefined || options.limits.state === "running") paused(res);
          else {
            res.writeHead(last.status, { "content-type": last.contentType });
            res.end(scrubKeys(last.text, keys));
          }
          return;
        }
        const account = accounts[index] as AccountState;
        let upstream: Response;
        try {
          upstream = await fetch(`${options.upstreamBaseUrl}${rest}`, {
            method: req.method ?? "POST",
            headers: upstreamHeaders(req.headers, account.key),
            ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
            signal: abort.signal,
          });
        } catch (error) {
          release(index);
          throw error;
        }
        if (upstream.status === 429) {
          last = {
            status: 429,
            contentType: upstream.headers.get("content-type") ?? "application/json",
            text: await upstream.text(),
          };
          release(index);
          if (account.level >= delays.length) takeDown(index, "rate-limit");
          else {
            const ms = delays[account.level] ?? 0;
            warnOnce(
              `backoff-${index}-${account.level}`,
              `${label(index)}撞频率限制，第 ${account.level + 1} 次退避 ${Math.round(ms / 1000)} 秒（上限 ${delays.length} 次）；退避期间请求派给其他账号`
            );
            account.level += 1;
            cool(index, ms);
          }
          continue;
        }
        if (upstream.status !== 200) {
          const text = await upstream.text();
          release(index);
          const failure = classifyUpstreamFailure(upstream.status, text);
          if (failure.kind === "concurrency") {
            last = {
              status: upstream.status,
              contentType: upstream.headers.get("content-type") ?? "application/json",
              text,
            };
            if (account.cap > 1) {
              account.cap -= 1;
              warn(`${label(index)}报并发受限：该账号并发上限降为 ${account.cap}，请求重试`);
            } else takeDown(index, "concurrency");
            continue;
          }
          if (failure.kind !== "auth" && failure.kind !== "other") {
            last = {
              status: upstream.status,
              contentType: upstream.headers.get("content-type") ?? "application/json",
              text,
            };
            takeDown(index, failure.kind);
            continue;
          }
          if (upstream.status >= 500) meterOf(job).upstreamFailures += 1;
          res.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          });
          res.end(scrubKeys(text, keys));
          return;
        }
        account.level = 0;
        try {
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
        } finally {
          release(index);
        }
        return;
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
      return { ...m, accountRequests: [...m.accountRequests] };
    },
    resetPeak: (job) => {
      meterOf(job).peakInFlight = jobInFlight.get(job) ?? 0;
    },
    accountStatus: () =>
      accounts.map((a, i) => ({ account: i + 1, cap: a.cap, inFlight: a.inFlight, down: a.down })),
    async probe() {
      const candidates = accounts.map((a, i) => ({ a, i })).filter(({ a }) => a.down !== "monthly");
      if (candidates.every(({ a }) => a.down === null)) {
        return candidates.length > 0 && (await probeAccount(candidates[0]?.i ?? 0));
      }
      for (const { a, i } of candidates) {
        if (a.down !== null && (await probeAccount(i))) restore(i);
      }
      return usable();
    },
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
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
    upstreamFailures: after.upstreamFailures - before.upstreamFailures,
    queueMs: after.queueMs - before.queueMs,
    // 峰值不做差：跑批器在一步开始时 resetPeak，结束时读到的即这一步的峰值
    peakInFlight: after.peakInFlight,
    accountRequests: after.accountRequests.map((n, i) => n - (before.accountRequests[i] ?? 0)),
  };
}
