// 联网的两件工具（决策 287–291）：web_search 与 web_fetch，走 Pigeon 的工具层——注册表登记风险档、审批与会话记录照常。
// - web_search（read 档，免审批）：参数为查询词与条数；返回标题、链接、摘要列表，服务端给出答案时一并返回。
// - web_fetch（network 档，按网站审批）：参数为网址与"要从网页里找什么"；在本机直接抓取（内网防护、跨主机跳转不跟随、
//   限制大小与超时），正文交给提炼，只把提炼结果交回，网页原文不进主对话。提炼与搜索请求的用量写在工具结果 details 的
//   modelUsage 键下，计入本会话花费。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { TurnUsage } from "../state/runtime-events.ts";
import { TOOL_RESULT_USAGE_KEY } from "../state/tool-usage.ts";
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
  "联网搜索。按查询词搜索网上的资料，返回结果列表：每条有标题、链接与摘要；搜索服务给出答案时一并返回。" +
  "摘要只是线索，需要细节时用 web_fetch 读取对应网页。";

export const WebSearchParamsSchema = Type.Object({
  query: Type.String({ minLength: 1, description: "查询词" }),
  maxResults: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 20, description: "返回的结果条数（1 到 20，缺省 5）" })
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
        throw new WebSearchUnavailableError(setup.unavailable ?? "没有可用的搜索后端");
      }
      const response = await backend.search(
        { query: args.query, maxResults: args.maxResults ?? setup.defaultMaxResults },
        signal
      );
      return {
        content: [{ type: "text", text: formatSearchResponse(response) }],
        details: {
          backend: response.backend,
          query: response.query,
          results: response.results.length,
          ...(response.usage !== undefined ? { [TOOL_RESULT_USAGE_KEY]: response.usage } : {}),
        },
      };
    },
  };
}

// ---- web_fetch ----

export const WEB_FETCH_DESCRIPTION =
  "读取一个公开网页并从中找出你要的信息。给出网址与要从网页里找什么；Pigeon 抓取网页后按你的问题提炼，" +
  "只交回提炼结果，不交回网页原文，所以问题要写具体。只接受公开的 http(s) 网址，内网与本机地址会被拒绝；" +
  "跳到别的网站时不跟随，会告诉你跳到了哪里。";

export const WebFetchParamsSchema = Type.Object({
  url: Type.String({ minLength: 1, description: "要读取的网址（http 或 https）" }),
  prompt: Type.String({
    minLength: 1,
    description: "要从这个网页里找什么：问题或要提取的信息，写具体",
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
    `网页跳到了另一个网站：${to}（网站 ${toHost}，来自 ${from}）。没有跟随跳转；如需读取，请用 web_fetch 抓取该网址。`,
  outputTruncatedNote: "（提炼结果撞上输出上限，末尾可能不完整）",
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
        `网页：${page.title}`,
        `网址：${page.finalUrl}${page.finalUrl !== args.url ? `（原网址 ${args.url}，同站跳转）` : ""}`,
        ...(page.truncated ? [truncatedNote(page.content.length)] : []),
        `提炼结果（针对：${args.prompt}）：`,
        distilled.text.trim() === "" ? "（提炼结果为空）" : distilled.text.trim(),
        ...(distilled.outputTruncated === true ? [WEB_FETCH_TEXTS.outputTruncatedNote] : []),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
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
