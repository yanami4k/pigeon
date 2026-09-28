// Tavily 搜索后端：调 <baseUrl>/search，带服务端生成的答案。
// 来源：@amaster.ai/pi-web-access 0.1.19 的 dist/providers/tavily.js（search 部分）（Apache-2.0，见 third_party/pi-web-access/），
// 已修改：只保留搜索；去掉主题、时间范围与域名过滤。
import { timeoutSignal } from "../network.ts";
import {
  describeHttpFailure,
  normalizeResults,
  type SearchBackend,
  SearchBackendError,
  type SearchParams,
  type SearchResponse,
} from "../search.ts";

export interface TavilySearchOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";

interface TavilyResponse {
  query?: string;
  answer?: string;
  results?: { title?: string; url?: string; content?: string }[];
}

export function createTavilySearchBackend(options: TavilySearchOptions): SearchBackend {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, "")}/search`;
  return {
    id: "tavily",
    async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          query: params.query,
          max_results: params.maxResults,
          include_answer: true,
        }),
        signal: timeoutSignal(options.timeoutMs, signal),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new SearchBackendError(describeHttpFailure("tavily", response.status, text));
      }
      const data = (await response.json()) as TavilyResponse;
      const results = normalizeResults(
        (data.results ?? []).map((item) => ({
          title: item.title ?? "",
          url: item.url ?? "",
          snippet: item.content ?? "",
        })),
        params.maxResults
      );
      return {
        backend: "tavily",
        query: params.query,
        ...(typeof data.answer === "string" && data.answer.trim() !== ""
          ? { answer: data.answer.trim() }
          : {}),
        results,
      };
    },
  };
}
