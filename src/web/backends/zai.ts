// 智谱（Z.AI）搜索后端：调 <baseUrl>/api/paas/v4/web_search（search-prime 引擎）。
// 来源：@amaster.ai/pi-web-access 0.1.19 的 dist/providers/zai.js（search 部分）（Apache-2.0，见 third_party/pi-web-access/），
// 已修改：只保留搜索；去掉时间范围与域名过滤；报错文字不带响应外的任何东西。
import { timeoutSignal } from "../network.ts";
import {
  describeHttpFailure,
  normalizeResults,
  type SearchBackend,
  SearchBackendError,
  type SearchParams,
  type SearchResponse,
} from "../search.ts";

export interface ZaiSearchOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export const ZAI_DEFAULT_BASE_URL = "https://api.z.ai";

interface ZaiResponse {
  search_result?: { title?: string; link?: string; content?: string }[];
}

export function createZaiSearchBackend(options: ZaiSearchOptions): SearchBackend {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, "")}/api/paas/v4/web_search`;
  return {
    id: "zai",
    async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          search_engine: "search-prime",
          search_query: params.query,
          count: params.maxResults,
        }),
        signal: timeoutSignal(options.timeoutMs, signal),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new SearchBackendError(describeHttpFailure("zai", response.status, text));
      }
      const data = (await response.json()) as ZaiResponse;
      const results = normalizeResults(
        (data.search_result ?? []).map((item) => ({
          title: item.title ?? "",
          url: item.link ?? "",
          snippet: item.content ?? "",
        })),
        params.maxResults
      );
      return { backend: "zai", query: params.query, results };
    },
  };
}
