// 抓取网页（决策 289）：在本机直接抓，不经 Jina 等第三方中转；访问前做内网防护；跨主机跳转不跟随；限制超时、字节数
// 与正文字符数；HTML 转成 Markdown 正文，其余文本类型原样；非文本内容拒绝。抓到的正文只交给提炼，不直接交回模型。
// 来源：@amaster.ai/pi-web-access 0.1.19 的 dist/fetch.js（Apache-2.0，见 third_party/pi-web-access/），已修改：
// 去掉 Jina Reader 中转与按服务商抓取的分支；加上限与截断；跳转与非文本的处理按上述规则。
import { extractTitle, htmlToMarkdown } from "./html.ts";
import {
  type DnsLookup,
  readBodyCapped,
  safeFetch,
  type Transport,
  timeoutSignal,
  WebFetchError,
} from "./network.ts";

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxChars: number;
}

export interface FetchPageOptions {
  limits: FetchLimits;
  lookup?: DnsLookup;
  transport?: Transport;
  signal?: AbortSignal;
}

export type FetchPageOutcome =
  | {
      kind: "page";
      url: string;
      // 同一网站内跳转后最终抓到的网址
      finalUrl: string;
      title: string;
      content: string;
      contentType: string;
      bytes: number;
      // 正文被截断（字节上限或字符上限任一命中）
      truncated: boolean;
    }
  | { kind: "cross-host-redirect"; from: string; to: string; toHost: string };

const USER_AGENT = "Mozilla/5.0 (compatible; Pigeon/1.0; +https://github.com/pigeon-harness)";
const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";

// 文本类内容：text/*、JSON、XML、JavaScript 及其变体
function isTextContentType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/xhtml+xml" ||
    type === "application/javascript" ||
    type === "application/x-www-form-urlencoded" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

function isHtml(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "text/html" || type === "application/xhtml+xml";
}

function charsetOf(contentType: string): string {
  const match = /charset=["']?([\w-]+)/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? "utf-8";
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// 按字符上限截断（按码点数）
function capChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  let cut = maxChars;
  const before = text.charCodeAt(cut - 1);
  if (before >= 0xd800 && before <= 0xdbff) {
    cut -= 1;
  }
  return { text: text.slice(0, cut), truncated: true };
}

export async function fetchPage(url: string, options: FetchPageOptions): Promise<FetchPageOutcome> {
  const { limits } = options;
  const signal = timeoutSignal(limits.timeoutMs, options.signal);
  const outcome = await safeFetch(
    url,
    { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: ACCEPT }, signal },
    {
      ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
      ...(options.transport !== undefined ? { transport: options.transport } : {}),
    }
  );
  if (outcome.kind === "cross-host-redirect") {
    return {
      kind: "cross-host-redirect",
      from: outcome.from.href,
      to: outcome.to.href,
      toHost: outcome.to.hostname,
    };
  }
  const { response } = outcome;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebFetchError(
      `抓取失败：HTTP ${response.status}${response.statusText !== "" ? ` ${response.statusText}` : ""}`
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType !== "" && !isTextContentType(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebFetchError(
      `不是文本内容，无法读取：${contentType.split(";")[0]?.trim() ?? contentType}`
    );
  }
  const body = await readBodyCapped(response, limits.maxBytes);
  const raw = decode(body.bytes, charsetOf(contentType));
  const html = contentType === "" ? /^\s*(<!doctype html|<html)/i.test(raw) : isHtml(contentType);
  const title = (html ? extractTitle(raw) : undefined) ?? outcome.url.href;
  const converted = html ? htmlToMarkdown(raw) : raw;
  const capped = capChars(converted, limits.maxChars);
  return {
    kind: "page",
    url,
    finalUrl: outcome.url.href,
    title,
    content: capped.text,
    contentType,
    bytes: body.bytes.byteLength,
    truncated: body.truncated || capped.truncated,
  };
}
