// 内网防护与安全抓取（决策 289）。
// 来源：@amaster.ai/pi-shared 0.1.19 的 dist/network.js（Apache-2.0，见 third_party/pi-web-access/），已修改：
//   - 去掉 trustedHosts 绕过（Pigeon 没有需要信任的代理主机）；
//   - 跨主机的跳转不跟随：交回跳转目标，由模型决定要不要再抓；同一主机内的跳转照旧逐跳重新校验；
//   - 响应正文按字节上限截断而不是报错（超大页面截断交给提炼）；
//   - 传输层可注入（测试用本地假服务，不真的连外网）；错误改为带归类标记的自有错误类；注释改中文。
// 判定：只接受 http(s)；不许带用户名密码；不许 localhost 与 *.localhost；主机名为 IP 字面量时直接判，否则先做 DNS 解析，
// 解析出的每个地址都必须是全球可路由地址（回环、内网、链路本地、云元数据、保留段、IPv4 映射与 NAT64 内嵌地址一律拒绝）；
// 连接时把地址钉死在解析结果的第一个上，防止校验与连接之间被 DNS 重绑定。
import { lookup as nodeLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import type { ToolErrorKind } from "../state/tool-execution.ts";
import { TOOL_ERROR_KIND_MARK } from "../tools/error-kind.ts";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

// DNS 解析注入点：返回主机名解析出的全部地址（测试注入假解析）
export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultLookup: DnsLookup = async (hostname) =>
  (await nodeLookup(hostname, { all: true, verbatim: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));

// 网址不合规或指向非公网地址：模型侧的问题，归域错误（不贴环境异常标签）
export class UnsafeUrlError extends Error {
  readonly [TOOL_ERROR_KIND_MARK]: ToolErrorKind = "domain";
}

// 抓取过程中的其他错误（HTTP 状态、跳转过多、非文本内容）：不贴归类标签
export class WebFetchError extends Error {}

const wellKnownNat64Addresses = new BlockList();
wellKnownNat64Addresses.addSubnet("64:ff9b::", 96, "ipv6");
const globalIpv6Addresses = new BlockList();
globalIpv6Addresses.addSubnet("2000::", 3, "ipv6");
const nonGlobalIpv6Addresses = new BlockList();
nonGlobalIpv6Addresses.addSubnet("2001::", 23, "ipv6");
nonGlobalIpv6Addresses.addSubnet("2001:db8::", 32, "ipv6");
nonGlobalIpv6Addresses.addSubnet("2002::", 16, "ipv6");
nonGlobalIpv6Addresses.addSubnet("3fff::", 20, "ipv6");
// IANA 把 2001::/23 标为非全球，下面这些更细的分配除外
const globalIetfProtocolAddresses = new BlockList();
globalIetfProtocolAddresses.addAddress("2001:1::1", "ipv6");
globalIetfProtocolAddresses.addAddress("2001:1::2", "ipv6");
globalIetfProtocolAddresses.addAddress("2001:1::3", "ipv6");
globalIetfProtocolAddresses.addSubnet("2001:3::", 32, "ipv6");
globalIetfProtocolAddresses.addSubnet("2001:4:112::", 48, "ipv6");
globalIetfProtocolAddresses.addSubnet("2001:20::", 28, "ipv6");
globalIetfProtocolAddresses.addSubnet("2001:30::", 28, "ipv6");

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a = -1, b = -1, c = -1] = octets;
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return false;
  }
  return true;
}

function mappedIpv4(address: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted?.[1] !== undefined) {
    return dotted[1];
  }
  const hex = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hex?.[1] === undefined || hex[2] === undefined) {
    return undefined;
  }
  const value = Number.parseInt(hex[1], 16) * 65_536 + Number.parseInt(hex[2], 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function nat64Ipv4(address: string): string | undefined {
  if (!wellKnownNat64Addresses.check(address, "ipv6")) {
    return undefined;
  }
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const hex = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (hex?.[1] === undefined || hex[2] === undefined) {
    return undefined;
  }
  const value = Number.parseInt(hex[1], 16) * 65_536 + Number.parseInt(hex[2], 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

// 全球可路由地址判定（IPv4 与 IPv6；内嵌 IPv4 的 IPv6 按内嵌的 IPv4 判）
export function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) {
    return isPublicIpv4(normalized);
  }
  if (family !== 6) {
    return false;
  }
  const embeddedIpv4 = mappedIpv4(normalized) ?? nat64Ipv4(normalized);
  if (embeddedIpv4 !== undefined) {
    return isPublicIpv4(embeddedIpv4);
  }
  if (!globalIpv6Addresses.check(normalized, "ipv6")) {
    return false;
  }
  return (
    globalIetfProtocolAddresses.check(normalized, "ipv6") ||
    !nonGlobalIpv6Addresses.check(normalized, "ipv6")
  );
}

export const PUBLIC_DESTINATION = "只能访问公网的 http(s) 网址";

export interface ResolvedPublicUrl {
  url: URL;
  addresses: ResolvedAddress[];
}

// 解析网址并要求每个 DNS 答案都是全球可路由地址；每一跳跳转都要重新调用
export async function resolvePublicHttpUrl(
  value: string | URL,
  options: { lookup?: DnsLookup } = {}
): Promise<ResolvedPublicUrl> {
  const lookup = options.lookup ?? defaultLookup;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeUrlError(`${PUBLIC_DESTINATION}：网址无法解析`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "" ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost")
  ) {
    throw new UnsafeUrlError(`${PUBLIC_DESTINATION}：${describeRejectedUrl(url)}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses: ResolvedAddress[] =
    literalFamily !== 0
      ? [{ address: hostname, family: literalFamily === 6 ? 6 : 4 }]
      : await lookup(hostname).catch(() => []);
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`${PUBLIC_DESTINATION}：主机 ${hostname} 无法解析`);
  }
  const nonPublic = addresses.filter(({ address }) => !isPublicIp(address));
  if (nonPublic.length > 0) {
    const list = nonPublic.map(({ address }) => address).join("、");
    throw new UnsafeUrlError(
      `${PUBLIC_DESTINATION}：主机 ${hostname} 指向非公网地址 ${list}（回环、内网、链路本地等地址一律拒绝）`
    );
  }
  return { url, addresses };
}

function describeRejectedUrl(url: URL): string {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `协议 ${url.protocol} 不支持`;
  }
  if (url.username !== "" || url.password !== "") {
    return "网址不能带用户名或密码";
  }
  if (url.hostname === "") {
    return "网址没有主机名";
  }
  return `主机 ${url.hostname} 是本机地址`;
}

export async function assertPublicHttpUrl(
  value: string | URL,
  options: { lookup?: DnsLookup } = {}
): Promise<URL> {
  return (await resolvePublicHttpUrl(value, options)).url;
}

export interface TransportInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

// 传输层：向钉死的地址发一次请求，取回响应（不跟随跳转）。缺省为 node 的 http/https；测试注入本地假服务
export type Transport = (
  url: URL,
  target: ResolvedAddress,
  init: TransportInit
) => Promise<Response>;

export type SafeFetchOutcome =
  | { kind: "response"; url: URL; response: Response }
  | { kind: "cross-host-redirect"; from: URL; to: URL };

export interface SafeFetchOptions {
  lookup?: DnsLookup;
  transport?: Transport;
  // 同一主机内跟随的跳转上限（缺省 5）
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// 安全抓取：校验 → 钉址请求 → 同主机跳转逐跳重校验后跟随；跨主机跳转不跟随，交回跳转目标
export async function safeFetch(
  value: string | URL,
  init: TransportInit = {},
  options: SafeFetchOptions = {}
): Promise<SafeFetchOutcome> {
  const lookup = options.lookup;
  const transport = options.transport ?? pinnedFetch;
  const maxRedirects = options.maxRedirects ?? 5;
  let resolved = await resolvePublicHttpUrl(value, lookup !== undefined ? { lookup } : {});
  for (let redirects = 0; ; redirects++) {
    const target = resolved.addresses[0];
    if (target === undefined) {
      throw new UnsafeUrlError(`${PUBLIC_DESTINATION}：主机 ${resolved.url.hostname} 无法解析`);
    }
    const response = await transport(resolved.url, target, init);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { kind: "response", url: resolved.url, response };
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (location === null || location === "") {
      throw new WebFetchError(`网页返回跳转（HTTP ${response.status}）但没有给出目标地址`);
    }
    let next: URL;
    try {
      next = new URL(location, resolved.url);
    } catch {
      throw new WebFetchError(`网页返回的跳转目标无法解析：${location}`);
    }
    if (next.hostname.toLowerCase() !== resolved.url.hostname.toLowerCase()) {
      return { kind: "cross-host-redirect", from: resolved.url, to: next };
    }
    if (redirects >= maxRedirects) {
      throw new WebFetchError(`同一网站内的跳转超过 ${maxRedirects} 次，停止抓取`);
    }
    resolved = await resolvePublicHttpUrl(next, lookup !== undefined ? { lookup } : {});
  }
}

// 钉址请求：DNS 已在校验时解析，连接时直接用解析出的地址，不再查一次（防重绑定）
async function pinnedFetch(
  url: URL,
  target: ResolvedAddress,
  init: TransportInit
): Promise<Response> {
  const method = init.method?.toUpperCase() ?? "GET";
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers: init.headers ?? {},
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
        family: target.family,
        lookup(_hostname, _options, callback) {
          // 上游钉址约定：回调给单个地址与族
          (callback as (err: null, address: string, family: number) => void)(
            null,
            target.address,
            target.family
          );
        },
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) {
              responseHeaders.append(name, item);
            }
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        const status = incoming.statusCode ?? 500;
        const body =
          method === "HEAD" || status === 204 || status === 304
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(
          new Response(body, {
            status,
            statusText: incoming.statusMessage ?? "",
            headers: responseHeaders,
          })
        );
      }
    );
    request.once("error", reject);
    request.end();
  });
}

export interface CappedBody {
  bytes: Uint8Array;
  // 超过上限：只保留前 maxBytes 字节，其余丢弃
  truncated: boolean;
}

// 按上限读取响应正文：超过即截断并取消流
export async function readBodyCapped(response: Response, maxBytes: number): Promise<CappedBody> {
  if (response.body === null) {
    return { bytes: new Uint8Array(), truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = value.byteLength > remaining;
        if (!truncated) {
          // 恰好读满：再看一眼还有没有内容
          const probe = await reader.read();
          truncated = !probe.done;
        }
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: result, truncated };
}

// 超时与调用方中止合并成一个信号
export function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout;
}
