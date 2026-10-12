// 联网的两件工具（决策 287–291）：web_search 与 web_fetch，走 Pigeon 的工具层——注册表登记风险档、审批与会话记录照常。
// - web_search（read 档，免审批）：参数为查询词与条数；返回标题、链接、摘要列表，服务端给出答案时一并返回。
// - web_fetch（network 档，按网站审批）：参数为网址与"要从网页里找什么"；在本机直接抓取（内网防护、跨主机跳转不跟随、
//   限制大小与超时），正文交给提炼，只把提炼结果交回，网页原文不进主对话。提炼与搜索请求的用量写在工具结果 details 的
//   modelUsage 键下，计入本会话花费。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { TurnUsage } from "../state/runtime-events.ts";
import { TOOL_RESULT_USAGE_KEY } from "../state/tool-usage.ts";
import { markExternal } from "../tools/external-content.ts";
import {
  type HostScopedTool,
  hostOfUrlArg,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from "../tools/host-scope.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import { type Distiller, truncatedNote } from "./distill.ts";
import { type FetchLimits, fetchPage } from "./fetch.ts";
import type { DnsLookup, Transport } from "./network.ts";
import { formatSearchResponse, type SearchBackend } from "./search.ts";

// ---- web_search ----

export const WEB_SEARCH_DESCRIPTION =
  "Search the web. Searches online sources for the query and returns a list of results, each with a title, link, and snippet; " +
  "when the search service gives an answer, it is returned as well. Snippets are only leads; when you need details, read the page with web_fetch.";

export const WebSearchParamsSchema = Type.Object({
  query: Type.String({ minLength: 1, description: "Search query" }),
  maxResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: "Number of results to return (1 to 20, default 5)",
    })
  ),
});
export type WebSearchParams = Static<typeof WebSearchParamsSchema>;

export function webSearchRegistration(): ToolRegistration {
  return {
    name: WEB_SEARCH_TOOL,
    description: WEB_SEARCH_DESCRIPTION,
    parameters: WebSearchParamsSchema,
    tier: "read",
    pathConfinement: { kind: "none" },
    executionMode: "parallel",
  };
}

export interface WebSearchSetup {
  // 选定的后端；没有可用的后端时缺省，调用时按 unavailable 的文字报错
  backend?: SearchBackend;
  unavailable?: string;
  defaultMaxResults: number;
}

export interface WebSearchDetails {
  backend: string;
  query: string;
  results: number;
  // 后端给了非空的答案（决策 361：没有结果但带了答案的不算无事发生）
  answered: boolean;
  [TOOL_RESULT_USAGE_KEY]?: TurnUsage;
}

// 搜索后端不可用（没配 key 等）：模型侧改不了，但不是环境异常；报错文字里绝不带 key
export class WebSearchUnavailableError extends Error {}

export function createWebSearchTool(
  setup: WebSearchSetup
): PigeonAgentTool<typeof WebSearchParamsSchema, WebSearchDetails> {
  return {
    name: WEB_SEARCH_TOOL,
    label: WEB_SEARCH_TOOL,
    description: WEB_SEARCH_DESCRIPTION,
    parameters: WebSearchParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<WebSearchDetails>> {
      const args = Value.Parse(WebSearchParamsSchema, params);
      const backend = setup.backend;
      if (backend === undefined) {
        throw new WebSearchUnavailableError(setup.unavailable ?? "No search backend is available");
      }
      const response = await backend.search(
        { query: args.query, maxResults: args.maxResults ?? setup.defaultMaxResults },
        signal
      );
      return {
        // 决策 379：搜索结果是外部内容，开头加固定标记
        content: [{ type: "text", text: markExternal(formatSearchResponse(response)) }],
        details: {
          backend: response.backend,
          query: response.query,
          results: response.results.length,
          answered: (response.answer ?? "").trim() !== "",
          ...(response.usage !== undefined ? { [TOOL_RESULT_USAGE_KEY]: response.usage } : {}),
        },
      };
    },
  };
}

// ---- web_fetch ----

export const WEB_FETCH_DESCRIPTION =
  "Read a public web page and find the information you need in it. Give the URL and what to look for on the page; Pigeon fetches the page, " +
  "distills it according to your question, and returns only the distilled result, not the page text, so make the question specific. " +
  "Only public http(s) URLs are accepted; private-network and local addresses are rejected. " +
  "Redirects to another site are not followed; you are told where the redirect goes.";

export const WebFetchParamsSchema = Type.Object({
  url: Type.String({ minLength: 1, description: "URL to read (http or https)" }),
  prompt: Type.String({
    minLength: 1,
    description:
      "What to find on this page: a question or the information to extract. Be specific.",
  }),
});
export type WebFetchParams = Static<typeof WebFetchParamsSchema>;

export function webFetchRegistration(): ToolRegistration {
  return {
    name: WEB_FETCH_TOOL,
    description: WEB_FETCH_DESCRIPTION,
    parameters: WebFetchParamsSchema,
    tier: "network",
    pathConfinement: { kind: "none" },
    executionMode: "parallel",
  };
}

export interface WebFetchToolOptions {
  limits: FetchLimits;
  distill: Distiller;
  lookup?: DnsLookup;
  transport?: Transport;
}

export interface WebFetchDetails {
  url: string;
  host?: string;
  finalUrl?: string;
  title?: string;
  bytes?: number;
  truncated?: boolean;
  redirectedTo?: string;
  outputTruncated?: boolean;
  [TOOL_RESULT_USAGE_KEY]?: TurnUsage;
}

// 各情形交回模型的文字
export const WEB_FETCH_TEXTS = {
  redirect: (from: string, to: string, toHost: string) =>
    `The page redirects to another site: ${to} (site ${toHost}, from ${from}). The redirect was not followed; to read it, fetch that URL with web_fetch.`,
  outputTruncatedNote: "(The distilled result hit the output limit; the end may be incomplete.)",
} as const;

export function createWebFetchTool(
  options: WebFetchToolOptions
): PigeonAgentTool<typeof WebFetchParamsSchema, WebFetchDetails> & HostScopedTool {
  return {
    name: WEB_FETCH_TOOL,
    label: WEB_FETCH_TOOL,
    description: WEB_FETCH_DESCRIPTION,
    parameters: WebFetchParamsSchema,
    executionMode: "parallel",
    // 按网站审批（决策 290）：治理层据此显示主机名并建按网站的放权
    inspectHost: (params) => hostOfUrlArg(params),
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<WebFetchDetails>> {
      const args = Value.Parse(WebFetchParamsSchema, params);
      const host = hostOfUrlArg(args);
      const page = await fetchPage(args.url, {
        limits: options.limits,
        ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
        ...(options.transport !== undefined ? { transport: options.transport } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      if (page.kind === "cross-host-redirect") {
        return {
          content: [
            { type: "text", text: WEB_FETCH_TEXTS.redirect(page.from, page.to, page.toHost) },
          ],
          details: {
            url: args.url,
            ...(host !== undefined ? { host } : {}),
            redirectedTo: page.to,
          },
        };
      }
      // 网页原文只到这里为止：交给不带工具的单独请求提炼，主对话只见提炼结果
      const distilled = await options.distill({
        url: page.finalUrl,
        title: page.title,
        content: page.content,
        truncated: page.truncated,
        prompt: args.prompt,
        ...(signal !== undefined ? { signal } : {}),
      });
      const lines = [
        `Page: ${page.title}`,
        `URL: ${page.finalUrl}${page.finalUrl !== args.url ? ` (original URL ${args.url}, redirected within the same site)` : ""}`,
        ...(page.truncated ? [truncatedNote(page.content.length)] : []),
        `Distilled result (for: ${args.prompt}):`,
        distilled.text.trim() === "" ? "(The distilled result is empty.)" : distilled.text.trim(),
        ...(distilled.outputTruncated === true ? [WEB_FETCH_TEXTS.outputTruncatedNote] : []),
      ];
      return {
        // 决策 379：提炼结果来自网页，开头加固定标记（跨站跳转的提示是 Pigeon 自己的文字，不加）
        content: [{ type: "text", text: markExternal(lines.join("\n")) }],
        details: {
          url: args.url,
          ...(host !== undefined ? { host } : {}),
          finalUrl: page.finalUrl,
          title: page.title,
          bytes: page.bytes,
          truncated: page.truncated,
          ...(distilled.outputTruncated === true ? { outputTruncated: true } : {}),
          ...(distilled.usage !== undefined ? { [TOOL_RESULT_USAGE_KEY]: distilled.usage } : {}),
        },
      };
    },
  };
}
