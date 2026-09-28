// HTML 转正文（决策 289）：用 turndown（MIT，7.2.0）把网页转成 Markdown 交给提炼。
// 来源：@amaster.ai/pi-web-access 0.1.19 的 dist/fetch.js 里的转换与标题提取（Apache-2.0，见 third_party/pi-web-access/），
// 已修改：单独成文件；去掉脚本、样式、内嵌框架等与正文无关的标签；图片只留说明文字（data: 图片不进正文）；压掉连续空行。
import TurndownService from "turndown";

// 与正文无关、只会塞进提示注入或垃圾的标签
const REMOVED_TAGS = ["script", "style", "noscript", "template", "iframe", "svg", "canvas", "head"];

function createConverter(): TurndownService {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.remove(REMOVED_TAGS);
  turndown.addRule("image-alt-only", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = node.getAttribute("alt")?.trim() ?? "";
      return alt === "" ? "" : `[图：${alt}]`;
    },
  });
  return turndown;
}

export function htmlToMarkdown(html: string): string {
  const markdown = createConverter().turndown(html);
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

// 网页标题：<title> 的文字（去掉多余空白）；没有返回 undefined
export function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title !== undefined && title !== "" ? decodeEntities(title) : undefined;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    return NAMED_ENTITIES[lower] ?? whole;
  });
}
