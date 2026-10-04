// 文件名模式（决策 368，grep 的 glob 参数与 glob 工具共用）：* 不跨目录，** 跨任意层目录，? 一个字符，[...] 字符类
//（[!...] 或 [^...] 取反），{a,b} 任选其一，\ 转义下一个字符。匹配对象一律是正斜杠分隔的相对路径。
// 各搜索后端只负责列出候选，模式在这里统一判定——三种后端的结果因此一致。

const REGEX_SPECIAL = /[.+^$()|{}[\]\\/*?]/;

// 文件名模式写错（如字符类 [z-a] 的范围颠倒）：给模型的错误
export class GlobPatternError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

function compile(source: string, pattern: string): RegExp {
  try {
    return new RegExp(source);
  } catch {
    throw new GlobPatternError(`文件名模式有误：${pattern}`);
  }
}

function escapeChar(char: string): string {
  return REGEX_SPECIAL.test(char) ? `\\${char}` : char;
}

export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let braces = 0;
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] as string;
    const atSegmentStart = index === 0 || pattern[index - 1] === "/";
    if (char === "*" && pattern[index + 1] === "*" && atSegmentStart) {
      if (pattern[index + 2] === "/") {
        // **/：零层或多层目录
        source += "(?:[^/]*/)*";
        index += 3;
        continue;
      }
      if (index + 2 === pattern.length) {
        source += ".*";
        index += 2;
        continue;
      }
    }
    if (char === "*") {
      source += "[^/]*";
      while (pattern[index] === "*") index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
      } else {
        let body = pattern.slice(index + 1, close);
        const negated = body.startsWith("!") || body.startsWith("^");
        if (negated) body = body.slice(1);
        source += `[${negated ? "^/" : ""}${body.replace(/\\/g, "\\\\").replace(/^\]/, "\\]")}]`;
        index = close + 1;
        continue;
      }
    } else if (char === "{") {
      braces += 1;
      source += "(?:";
    } else if (char === "," && braces > 0) {
      source += "|";
    } else if (char === "}" && braces > 0) {
      braces -= 1;
      source += ")";
    } else if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += escapeChar(pattern[index] as string);
    } else {
      source += escapeChar(char);
    }
    index += 1;
  }
  // 不成对的 {：按字面处理整段模式
  if (braces > 0) {
    return compile(`^${[...pattern].map(escapeChar).join("")}$`, pattern);
  }
  return compile(`^${source}$`, pattern);
}

// grep 的文件过滤（同 ripgrep -g 的习惯）：模式里没有 / 时只比文件名，有 / 时比相对搜索起点的路径
export function fileFilter(pattern: string): (relPath: string) => boolean {
  const regex = globToRegExp(pattern);
  if (!pattern.includes("/")) {
    return (relPath) => regex.test(relPath.slice(relPath.lastIndexOf("/") + 1));
  }
  return (relPath) => regex.test(relPath);
}

// 模式最后一段若是简单的文件名模式（不含 / { [ : 等），给出它——ripgrep 据此先按文件名预筛（--type-add，不覆盖忽略规则），
// 只为提速；结果仍以上面的判定为准
export function basenamePrefilter(pattern: string): string | undefined {
  const last = pattern.slice(pattern.lastIndexOf("/") + 1);
  return /^[A-Za-z0-9_.*?-]+$/.test(last) && last !== "*" && !last.includes("**")
    ? last
    : undefined;
}
