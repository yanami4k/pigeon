// 跑批进程内置的模型网关（决策 155）：只听回环地址，说 Anthropic Messages 协议，四个条件的模型请求都经它转发。
//   接入：每个作业用独立路径前缀 /j/<作业>/，网关据此把用量归到作业上；agent 进程与容器只拿到网关地址，真 key 只在网关里注入；
//   429：双 key 轮换加共享退避（本请求撞过的 key 都换过一遍才退避；切换后保持使用新 key；并行请求共用一段退避），
//        退避用满仍撞即交给限额控制器按频率限制整批暂停；
//   403：按文案分类后交给限额控制器（额度、并发）；认证类原样交回；
//   暂停或停止期间：直接以 529 拒绝，不打上游——在途 agent 的下一次模型调用即失败，这一步作废、恢复后重做；
//   流式响应：错误在响应头阶段分类；200 之后原样透传，中途断流也原样透传（由 agent 一侧按失败处理），同时从事件流里
//   读出用量按作业计量（请求数即轮数、输入与输出 token）。交回客户端的任何文本里都不出现 key。
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  BACKOFF_DELAYS_MS,
  classifyUpstreamFailure,
  type LimitController,
  scrubKeys,
} from "./model-limits.ts";

export interface GatewayMeter {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelGatewayOptions {
  // 上游的 Anthropic Messages 基址（不带末尾斜杠），如 https://host/coding
  upstreamBaseUrl: string;
  keys: readonly string[];
  limits: LimitController;
  // 探测用的极小请求
  probeRequest: { path: string; body: unknown };
  backoffDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  warn?: (line: string) => void;
}

export interface ModelGateway {
  baseUrl: string;
  jobBaseUrl(job: string): string;
  meter(job: string): GatewayMeter;
  // 极小的探测请求：上游 200 即 true
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

function emptyMeter(): GatewayMeter {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

async function readAll(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// 从响应正文里读用量：SSE 取 message_start 的输入与缓存、message_delta 的输出（累计值，取最后一次）；
// 非流式取正文的 usage
function usageOf(text: string): Omit<GatewayMeter, "requests"> {
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
  const keys = options.keys.filter((k) => k !== "");
  if (keys.length === 0) throw new Error("网关至少需要一个 key");
  const delays = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warn = options.warn ?? ((line: string) => process.stderr.write(`[网关] ${line}\n`));
  const meters = new Map<string, GatewayMeter>();
  const meterOf = (job: string) => {
    let m = meters.get(job);
    if (m === undefined) {
      m = emptyMeter();
      meters.set(job, m);
    }
    return m;
  };
  let active = 0;
  let sharedBackoff: Promise<void> | null = null;
  const label = (i: number) => `第 ${i + 1} 个 key`;
  const backoff = (level: number): Promise<void> => {
    if (sharedBackoff === null) {
      const ms = delays[level] ?? delays.at(-1) ?? 0;
      warn(
        `${keys.length > 1 ? "所有 key 都撞频率限制" : "key 撞频率限制"}，第 ${level + 1} 次退避 ${Math.round(ms / 1000)} 秒（上限 ${delays.length} 次）；并行的请求一起等待`
      );
      const pending = sleep(ms).finally(() => {
        if (sharedBackoff === pending) sharedBackoff = null;
      });
      sharedBackoff = pending;
    }
    return sharedBackoff;
  };

  const send = (res: http.ServerResponse, status: number, body: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };

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
      send(
        res,
        529,
        anthropicError(
          "overloaded_error",
          `网关暂停：模型服务额度受限（${options.limits.state === "stopped" ? "已停止" : "等待恢复"}），这一步作废、恢复后重做`
        )
      );
      return;
    }
    const body = await readAll(req);
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    let limited = new Set<number>();
    let backoffs = 0;
    for (;;) {
      const index = active;
      const key = keys[index] as string;
      const upstream = await fetch(`${options.upstreamBaseUrl}${rest}`, {
        method: req.method ?? "POST",
        headers: upstreamHeaders(req.headers, key),
        ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
        signal: abort.signal,
      });
      if (upstream.status === 429) {
        await upstream.body?.cancel();
        limited.add(index);
        const other = keys.findIndex((_, i) => !limited.has(i));
        if (other !== -1) {
          if (active === index) {
            active = other;
            warn(
              `${label(index)}撞频率限制，切换到${label(other)}，后续请求保持使用${label(other)}`
            );
          }
          continue;
        }
        if (backoffs >= delays.length) {
          options.limits.onLimit("rate-limit");
          send(
            res,
            429,
            anthropicError("rate_limit_error", `退避 ${delays.length} 次后仍撞频率限制：整批暂停`)
          );
          return;
        }
        await backoff(backoffs);
        backoffs += 1;
        limited = new Set();
        continue;
      }
      if (upstream.status !== 200) {
        const text = await upstream.text();
        const failure = classifyUpstreamFailure(upstream.status, text);
        if (failure.kind !== "auth" && failure.kind !== "other")
          options.limits.onLimit(failure.kind);
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(scrubKeys(text, keys));
        return;
      }
      const headers: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!DROP_RESPONSE_HEADERS.has(name)) headers[name] = value;
      });
      res.writeHead(200, headers);
      const meter = meterOf(job);
      meter.requests += 1;
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
      return;
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
    meter: (job) => ({ ...meterOf(job) }),
    async probe() {
      try {
        const r = await fetch(`${options.upstreamBaseUrl}${options.probeRequest.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": keys[active] as string,
          },
          body: JSON.stringify(options.probeRequest.body),
        });
        await r.body?.cancel();
        return r.status === 200;
      } catch {
        return false;
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
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
  };
}
