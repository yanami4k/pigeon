// 会话检索的切分（决策 384）：查询与正文同一套，检索两侧共用这一个模块。纯函数、无 IO。
// - 英文一律小写；
// - 代码名（夹下划线、连字符、点、斜杠或大小写/数字转换的一串）整体保留为一个词，
//   按大小写转换、下划线、连字符、点、斜杠与数字拆开的各段同时入索引
//   （依据见决策 384 的详情笔记：保留整体加拆开各段配 BM25 有公开评测支撑）；
// - 中文（CJK 统一表意文字）按重叠二元组切；单字查询在检索侧退回子串匹配（见 memory/session-search.ts），
//   这里不为孤立单字造词（造了也配不上二元组）。
// 产出是词与词频（同一串重复出现累计），BM25 的 tf 直接取之。

// CJK 统一表意文字（含扩展 A 与兼容表意）；日文假名等按非词字符处理（本项目的会话里未见成段出现）
const CJK_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
// 词元：一段 CJK，或一串字母数字夹标识符分隔符（下划线、连字符、点、两种斜杠）
const TOKEN_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+|[A-Za-z0-9_\-./\\]+/g;
// 代码名整体两端的悬挂分隔符（如 "/usr/bin/" 两端的斜杠）不进整体，下划线保留（_private 是名字的一部分）
const EDGE_SEPARATORS = /^[-./\\]+|[-./\\]+$/g;
const IDENTIFIER_SPLIT = /[_\-./\\]+/;
const ASCII_UPPER = /^[A-Z]$/;
const ASCII_DIGIT = /^[0-9]$/;

// 代码名拆段：先按下划线、连字符、点、斜杠断开，段内再按大小写转换（含 HTTPServer → HTTP/Server 的
//  acronym 边界）与字母↔数字转换断开。返回原形的各段（调用方负责小写化），空段已滤掉
export function splitIdentifier(run: string): string[] {
  const segments: string[] = [];
  for (const part of run.split(IDENTIFIER_SPLIT)) {
    if (part === "") {
      continue;
    }
    let start = 0;
    for (let index = 1; index < part.length; index++) {
      const prev = part[index - 1] as string;
      const current = part[index] as string;
      const next = part[index + 1] as string | undefined;
      const boundary =
        (prev >= "a" && prev <= "z" && ASCII_UPPER.test(current)) ||
        (ASCII_UPPER.test(prev) &&
          ASCII_UPPER.test(current) &&
          next !== undefined &&
          next >= "a" &&
          next <= "z") ||
        (!ASCII_DIGIT.test(prev) && ASCII_DIGIT.test(current)) ||
        (ASCII_DIGIT.test(prev) && !ASCII_DIGIT.test(current));
      if (boundary) {
        segments.push(part.slice(start, index));
        start = index;
      }
    }
    segments.push(part.slice(start));
  }
  return segments;
}

export function isCjkText(text: string): boolean {
  return CJK_CHAR.test(text);
}

// 一段文本 → 词频表。词形一律小写
export function tokenizeSearchText(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (term: string) => {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  };
  for (const match of text.matchAll(TOKEN_RUN)) {
    const run = match[0];
    if (CJK_CHAR.test(run[0] as string)) {
      // 中文：重叠二元组；孤立单字不造词（检索侧单字查询走子串匹配）
      for (let index = 0; index + 1 < run.length; index++) {
        add(run.slice(index, index + 2));
      }
      continue;
    }
    // 代码名：整体加拆开的各段；整体与各段是同一串时只计一次（普通英文词即如此）
    const whole = run.replace(EDGE_SEPARATORS, "");
    if (!/[A-Za-z0-9]/.test(whole)) {
      continue;
    }
    const segments = splitIdentifier(whole).map((segment) => segment.toLowerCase());
    const wholeLower = whole.toLowerCase();
    add(wholeLower);
    for (const segment of segments) {
      if (segment !== wholeLower) {
        add(segment);
      }
    }
  }
  return counts;
}

// 词频表的文档长度（BM25 的 dl）
export function tokenCountOf(tokens: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const count of Object.values(tokens)) {
    total += count;
  }
  return total;
}
