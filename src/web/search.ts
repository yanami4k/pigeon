// 联网搜索的通用流程与结果整理（决策 287、288）：后端做成可换的接口，工具只认这个接口；结果统一为
// 标题、链接、摘要的列表，服务端给出答案时一并交回。
// 来源：@amaster.ai/pi-web-access 0.1.19 的 dist/types.js、dist/search.js 与 dist/index.js 里的结果整理（Apache-2.0，
// 见 third_party/pi-web-access/），已修改：参数只留查询词与条数；结果整理改为 Pigeon 自己的文本格式；后端由装配方注入，不在这里按
// 配置挑选。
import type { TurnUsage } from "../state/runtime-events.ts";

export interface SearchParams {
  query: string;
  maxResults: number;
}

export interface SearchResult {
  title: string;
  url: string;
  // 摘要或引用的原文片段；没有则为空串
  snippet: string;
}

export interface SearchResponse {
  backend: string;
  query: string;
  // 服务端给出的答案（经模型服务端搜索的后端会有）
  answer?: string;
  results: SearchResult[];
  // 经模型服务端搜索时这次请求的用量（tokens；花费按模型接入的价目，日常使用为 0）
  usage?: TurnUsage;
}

// 搜索后端接口：再加一家只需实现它并在装配处登记
export interface SearchBackend {
  readonly id: string;
  search(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse>;
}

// 后端报错（HTTP 状态、响应形状不对）：报错文字里绝不带 key
export class SearchBackendError extends Error {}

// 各后端共用：响应正文只截前 300 字符进报错文字（不把整页错误页塞给模型）
export function describeHttpFailure(backend: string, status: number, body: string): string {
  const excerpt = body.replace(/\s+/g, " ").trim().slice(0, 300);
  return `${backend} search service returned HTTP ${status}${excerpt !== "" ? `: ${excerpt}` : ""}`;
}

// 结果去重（按链接）并截到条数
export function normalizeResults(results: SearchResult[], maxResults: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const result of results) {
    if (result.url === "" || seen.has(result.url)) {
      continue;
    }
    seen.add(result.url);
    out.push({
      title: result.title.trim() === "" ? result.url : result.title.trim(),
      url: result.url,
      snippet: result.snippet.replace(/\s+/g, " ").trim(),
    });
    if (out.length >= maxResults) {
      break;
    }
  }
  return out;
}

// 交回模型的文本：查询词与后端 → 答案（有则） → 结果列表；没有结果时明说
export function formatSearchResponse(response: SearchResponse): string {
  const lines: string[] = [];
  lines.push(
    `Search: ${response.query} (backend ${response.backend}, ${response.results.length} results)`
  );
  if (response.answer !== undefined && response.answer.trim() !== "") {
    lines.push("Answer:", response.answer.trim());
  }
  if (response.results.length > 0) {
    lines.push("Results:");
    for (const [index, result] of response.results.entries()) {
      lines.push(`${index + 1}. ${result.title}`, `   ${result.url}`);
      if (result.snippet !== "") {
        lines.push(`   ${result.snippet}`);
      }
    }
  }
  if (response.results.length === 0 && (response.answer ?? "").trim() === "") {
    lines.push("No results found; try rephrasing the query.");
  }
  return lines.join("\n");
}
