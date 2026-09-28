// 联网工具的真实接口探针（决策 288 的实测）：只用本分支的搜索与抓取模块，经选定的搜索后端搜 5 个不同类型的查询，
// 抓 3 个网页并用 DeepSeek 提炼；打印每次的结果条数、有无链接、用量与按官方价目折算的花费，绝不打印 key。
// 用法（key 从环境变量取）：
//   DEEPSEEK_API_KEY=… node spikes/web-probe.mts [--backend deepseek|zai|tavily] [--no-fetch] [--no-search]
// 智谱与 Tavily 的 key 分别取 ZAI_API_KEY 与 TAVILY_API_KEY。
import { createModelDistiller, resolveWebTools } from "../src/application/web-tools.ts";
import { requestCostCny } from "../src/eval/model-pricing.ts";
import { deepseekModel } from "../src/pi-runtime/deepseek-model.ts";
import { createDeepSeekStreamFn } from "../src/pi-runtime/deepseek-stream.ts";
import type { TurnUsage } from "../src/state/runtime-events.ts";
import type { SearchBackendId } from "../src/state/web-config.ts";
import { createWebFetchTool, createWebSearchTool } from "../src/web/tools.ts";

const argv = process.argv.slice(2);
const backendArg = argv[argv.indexOf("--backend") + 1];
const backend: SearchBackendId =
  argv.includes("--backend") && (backendArg === "zai" || backendArg === "tavily")
    ? backendArg
    : "deepseek";
const doSearch = !argv.includes("--no-search");
const doFetch = !argv.includes("--no-fetch");

const QUERIES: { kind: string; query: string }[] = [
  { kind: "中文技术问题", query: "Node.js 内置的 fetch 怎么设置请求超时" },
  { kind: "英文库文档", query: "typebox Type.Object optional properties exactOptionalPropertyTypes documentation" },
  { kind: "最新版本号", query: "TypeScript latest stable version number" },
  { kind: "报错信息", query: "TS2379 Argument of type is not assignable to parameter of type with 'exactOptionalPropertyTypes: true'" },
  { kind: "站内搜索", query: "site:nodejs.org test runner --test-concurrency option" },
];

const PAGES: { kind: string; url: string; prompt: string }[] = [
  {
    kind: "文档页",
    url: "https://nodejs.org/api/test.html",
    prompt: "--test-concurrency 选项的含义与缺省值是什么？引用原文。",
  },
  {
    kind: "长博客",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch",
    prompt: "怎样给 fetch 请求设置超时并取消？给出示例代码。",
  },
  {
    kind: "带跳转的链接",
    url: "https://npmjs.org/package/turndown",
    prompt: "turndown 的最新版本号是多少？",
  },
];

// 累计花费的保险阀：超过 ¥1.5 即不再发新请求（总花费控制在 ¥2 以内）
const BUDGET_CNY = 1.5;
let spentCny = 0;

function cny(usage: TurnUsage | undefined, startMs: number, endMs: number): string {
  if (usage === undefined) return "用量未知";
  const cost = requestCostCny(
    {
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.output,
    },
    startMs,
    endMs
  );
  spentCny += cost.cny;
  return `输入 ${usage.input}（缓存命中 ${usage.cacheRead}）输出 ${usage.output} token，约 ¥${cost.cny.toFixed(4)}${cost.peak ? "（高峰价）" : ""}，累计 ¥${spentCny.toFixed(4)}`;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

async function main(): Promise<void> {
  const config = resolveWebTools({
    governanceRoot: process.cwd(),
    config: { version: 1, search: { backend } },
  });
  console.log(`搜索后端：${backend}${config.search.backend === undefined ? `（不可用：${config.search.unavailable}）` : ""}`);
  if (doSearch && config.search.backend !== undefined) {
    const search = createWebSearchTool(config.search);
    for (const { kind, query } of QUERIES) {
      if (spentCny >= BUDGET_CNY) {
        console.log(`累计花费已达 ¥${spentCny.toFixed(4)}，停止`);
        return;
      }
      const started = Date.now();
      try {
        const result = await search.execute(
          `probe-${kind}`,
          { query, maxResults: 5 },
          new AbortController().signal,
          () => {}
        );
        const ended = Date.now();
        const text = textOf(result);
        const links = (text.match(/https?:\/\/\S+/g) ?? []).length;
        console.log(`\n=== 搜索[${kind}] ${query}`);
        console.log(`耗时 ${ended - started} ms；结果 ${result.details.results} 条；链接 ${links} 个；${cny(result.details.modelUsage, started, ended)}`);
        console.log(text.length > 2500 ? `${text.slice(0, 2500)}\n…（共 ${text.length} 字符）` : text);
      } catch (error) {
        console.log(`\n=== 搜索[${kind}] ${query}\n失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (doFetch) {
    const streamFn = createDeepSeekStreamFn(process.env);
    const fetchTool = createWebFetchTool({
      limits: config.fetch,
      distill: createModelDistiller({
        streamFn,
        model: deepseekModel(),
        maxTokens: config.distillMaxTokens,
      }),
    });
    for (const { kind, url, prompt } of PAGES) {
      if (spentCny >= BUDGET_CNY) {
        console.log(`累计花费已达 ¥${spentCny.toFixed(4)}，停止`);
        return;
      }
      const started = Date.now();
      try {
        const result = await fetchTool.execute(
          `probe-${kind}`,
          { url, prompt },
          new AbortController().signal,
          () => {}
        );
        const ended = Date.now();
        const text = textOf(result);
        console.log(`\n=== 抓取[${kind}] ${url}`);
        console.log(
          `耗时 ${ended - started} ms；字节 ${result.details.bytes ?? "-"}；截断 ${result.details.truncated ?? "-"}；` +
            `跳转 ${result.details.redirectedTo ?? "无"}；${cny(result.details.modelUsage, started, ended)}`
        );
        console.log(text.length > 2500 ? `${text.slice(0, 2500)}\n…（共 ${text.length} 字符）` : text);
      } catch (error) {
        console.log(`\n=== 抓取[${kind}] ${url}\n失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

main()
  .then(() => console.log(`
累计花费（按 token 与官方价目折算）：¥${spentCny.toFixed(4)}`))
  .catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
