// 缓存规则表的出处复核（决策 362，手动运行，不进 CI）：逐行抓取出处页面，确认原文引句还在；不在的行标为"需复核"并列出清单。
// 用法：node scripts/check-cache-rule-sources.ts
// 需要经代理上网时，Node 的 fetch 不读 HTTPS_PROXY，须另设 NODE_USE_ENV_PROXY=1（Node 24 起支持）。
// 比对方式：去掉 script、style 与注释，标签换成空格（另试换成空串），解码 HTML 实体，连续空白折成一个空格后找引句子串。
// 退出码：全部找到为 0；有需复核的行为 1。
import { CACHE_RULES } from "../src/state/cache-rules.ts";

const TIMEOUT_MS = 30_000;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  times: "×",
  yen: "¥",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

// 页面去标签后的两种文字（标签换空格、换空串）
export function pageTexts(html: string): string[] {
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  return [" ", ""].map((glue) => collapse(decodeEntities(body.replace(/<[^>]+>/g, glue))));
}

async function fetchPage(url: string): Promise<string[] | Error> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8", "user-agent": "Mozilla/5.0" },
    });
    if (!response.ok) return new Error(`HTTP ${response.status}`);
    return pageTexts(await response.text());
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const urls = [...new Set(CACHE_RULES.flatMap((row) => row.rule.sources.map((s) => s.url)))];
const pages = new Map<string, string[] | Error>();
for (const url of urls) {
  pages.set(url, await fetchPage(url));
}

const review: string[] = [];
for (const row of CACHE_RULES) {
  const problems: string[] = [];
  for (const source of row.rule.sources) {
    const page = pages.get(source.url);
    if (page instanceof Error || page === undefined) {
      problems.push(`抓取失败 ${source.url}：${page?.message ?? "未抓取"}`);
      continue;
    }
    const quote = collapse(source.quote);
    if (!page.some((text) => text.includes(quote))) {
      problems.push(`引句不在 ${source.url}：${source.quote}`);
    }
  }
  if (problems.length === 0) {
    console.log(`通过  ${row.id}`);
  } else {
    console.log(`需复核 ${row.id}`);
    review.push(row.id);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}
console.log(review.length === 0 ? "全部通过" : `需复核：${review.join("、")}`);
process.exitCode = review.length === 0 ? 0 : 1;
