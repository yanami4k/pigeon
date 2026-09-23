// 报错指纹（决策 131 / 133）：验证各步输出按工具取指纹，各工具的解析集中在本模块。
// - 类型检查（tsc、mypy）：错误码、涉及的名字与文件；
// - 测试（node:test、pytest）：失败的测试名与测试文件；
// - 分层规则（依赖巡航）：规则名与两端模块；
// - 格式与代码检查（biome、ruff）：规则名与文件。
// 按固定顺序逐个解析器试，第一个取到指纹的即该步的工具；都取不到即"未识别"——记一条未识别指纹，不猜。
// 步骤类型先按识别出的工具定，识别不了再看步名与命令里的关键字（配置里不设类型字段）。
// 名字只取报错里自带的文字（标识符、测试函数名），不解析代码；规则名不算名字。纯函数，无 IO。

export type FingerprintTool =
  | "tsc"
  | "mypy"
  | "dependency-cruiser"
  | "biome"
  | "ruff"
  | "node-test"
  | "pytest"
  | "unrecognized";

// 步骤类型：决定红转绿的门槛（测试步只算题面以外的用例，其余类型一律算）
export type VerifyStepKind = "type" | "test" | "format" | "lint" | "layer" | "unknown";

export interface Fingerprint {
  tool: FingerprintTool;
  // 类型检查的错误码（TS2322、mypy 的 [assignment]）
  code?: string;
  // 格式、代码检查与分层的规则名（biome 的整文件格式差异记为 format）
  rule?: string;
  // 失败的测试名（pytest 为去掉文件部分的节点名）
  test?: string;
  // 报错所在文件（工作区相对、正斜杠）；分层违规为依赖的发起端
  file?: string;
  // 分层违规的被依赖端
  to?: string;
  // 报错里自带、可在文件里按文本找到的名字（标识符、测试函数名）
  names: string[];
}

export interface StepFingerprints {
  // 识别出的工具；未识别时缺省
  tool?: Exclude<FingerprintTool, "unrecognized">;
  kind: VerifyStepKind;
  recognized: boolean;
  fingerprints: Fingerprint[];
}

// 同一步最多保留的指纹数：一处断链可能带出成百上千条同类报错
export const MAX_FINGERPRINTS_PER_STEP = 20;

const TOOL_KIND: Readonly<Record<Exclude<FingerprintTool, "unrecognized">, VerifyStepKind>> = {
  tsc: "type",
  mypy: "type",
  "dependency-cruiser": "layer",
  biome: "format",
  ruff: "lint",
  "node-test": "test",
  pytest: "test",
};

// 去掉终端颜色与控制序列
function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配的正是 ESC 控制序列
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

// 路径统一：反斜杠改正斜杠、去掉开头的 ./
export function normalizeReportedPath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

const TS_PRIMITIVES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "any",
  "unknown",
  "never",
  "void",
  "undefined",
  "null",
  "true",
  "false",
  "this",
]);

const PY_BUILTINS = new Set([
  "str",
  "int",
  "float",
  "bool",
  "bytes",
  "None",
  "list",
  "dict",
  "set",
  "tuple",
  "object",
  "type",
  "Any",
  "Optional",
  "Union",
  "List",
  "Dict",
  "Set",
  "Tuple",
  "Callable",
]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function quotedNames(message: string, quote: "'" | '"', exclude: ReadonlySet<string>): string[] {
  const pattern = quote === "'" ? /'([^'\n]+)'/g : /"([^"\n]+)"/g;
  const names: string[] = [];
  for (const match of message.matchAll(pattern)) {
    const name = match[1] ?? "";
    if (IDENTIFIER.test(name) && !exclude.has(name) && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

type Parser = (lines: string[]) => Fingerprint[];

// tsc：纯文本 file(l,c): error TSxxxx: 消息；彩色 file:l:c - error TSxxxx: 消息
const parseTsc: Parser = (lines) => {
  const found: Fingerprint[] = [];
  for (const line of lines) {
    const match =
      /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line) ??
      /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    found.push({
      tool: "tsc",
      code: match[4] ?? "",
      file: normalizeReportedPath(match[1] ?? ""),
      names: quotedNames(match[5] ?? "", "'", TS_PRIMITIVES),
    });
  }
  return found;
};

// mypy：file:line: error: 消息  [错误码]
const parseMypy: Parser = (lines) => {
  const found: Fingerprint[] = [];
  for (const line of lines) {
    const match = /^(.+?):(\d+)(?::\d+)?: error: (.*?)\s+\[([a-z][a-z0-9-]*)\]\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    found.push({
      tool: "mypy",
      code: match[4] ?? "",
      file: normalizeReportedPath(match[1] ?? ""),
      names: quotedNames(match[3] ?? "", '"', PY_BUILTINS),
    });
  }
  return found;
};

// 依赖巡航：error 规则名: 发起端 → 被依赖端（循环依赖跨多行，取首两段）；须有汇总行才认
const parseDependencyCruiser: Parser = (lines) => {
  if (!lines.some((line) => /\d+ dependency violations?/.test(line))) {
    return [];
  }
  const found: Fingerprint[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^\s*(?:error|warn|info)\s+([\w-]+):\s+(\S+)\s+→\s*(\S*)/.exec(line);
    if (match === null) {
      continue;
    }
    const to = match[3] !== "" ? match[3] : /^\s*(\S+)/.exec(lines[index + 1] ?? "")?.[1];
    found.push({
      tool: "dependency-cruiser",
      rule: match[1] ?? "",
      file: normalizeReportedPath(match[2] ?? ""),
      ...(to !== undefined && to !== "" ? { to: normalizeReportedPath(to) } : {}),
      names: [],
    });
  }
  return found;
};

// biome：file:l:c 规则名 … ━━━；整文件格式差异为 file format ━━━
const parseBiome: Parser = (lines) => {
  const found: Fingerprint[] = [];
  for (const line of lines) {
    const diagnostic = /^(\S+?):\d+:\d+\s+((?:lint|assist|syntax|parse)\/\S+|\S+\/\S+)\s.*━/.exec(
      line
    );
    if (diagnostic !== null) {
      found.push({
        tool: "biome",
        rule: diagnostic[2] ?? "",
        file: normalizeReportedPath(diagnostic[1] ?? ""),
        names: [],
      });
      continue;
    }
    const format = /^(\S+)\s+format\s+━/.exec(line);
    if (format !== null) {
      found.push({
        tool: "biome",
        rule: "format",
        file: normalizeReportedPath(format[1] ?? ""),
        names: [],
      });
    }
  }
  return found;
};

// ruff：完整格式为"规则码 [*] 消息"下一行" --> file:l:c"；简洁格式为 file:l:c: 规则码 消息
const parseRuff: Parser = (lines) => {
  const found: Fingerprint[] = [];
  for (const [index, line] of lines.entries()) {
    const concise = /^(\S+?):\d+:\d+: ([A-Z]+\d+) /.exec(line);
    if (concise !== null) {
      found.push({
        tool: "ruff",
        rule: concise[2] ?? "",
        file: normalizeReportedPath(concise[1] ?? ""),
        names: [],
      });
      continue;
    }
    const header = /^([A-Z]+\d+) (?:\[\*\] )?\S/.exec(line);
    const location = /^\s*-->\s+(\S+?):\d+:\d+/.exec(lines[index + 1] ?? "");
    if (header !== null && location !== null) {
      found.push({
        tool: "ruff",
        rule: header[1] ?? "",
        file: normalizeReportedPath(location[1] ?? ""),
        names: [],
      });
    }
  }
  return found;
};

// node:test（spec 输出）：末尾"failing tests:"汇总里的 test at file:l:c 与下一行的 ✖ 测试名 (耗时)
const parseNodeTest: Parser = (lines) => {
  const start = lines.findIndex((line) => /✖ failing tests:/.test(line));
  if (start < 0) {
    return [];
  }
  const found: Fingerprint[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const at = /^test at (.+?):\d+:\d+\s*$/.exec(lines[index] ?? "");
    if (at === null) {
      continue;
    }
    const name = /^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/.exec(lines[index + 1] ?? "")?.[1];
    if (name === undefined) {
      continue;
    }
    found.push({
      tool: "node-test",
      test: name,
      file: normalizeReportedPath(at[1] ?? ""),
      names: [name],
    });
  }
  return found;
};

// pytest：短汇总里的 FAILED / ERROR 节点号（file::名字[参数] - 消息）
const parsePytest: Parser = (lines) => {
  if (!lines.some((line) => /short test summary info|^=+ .*\b(failed|error)/.test(line))) {
    return [];
  }
  const found: Fingerprint[] = [];
  for (const line of lines) {
    const match = /^(?:FAILED|ERROR) (\S+?\.py)(?:::(\S+?))?(?: - .*)?\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    const file = normalizeReportedPath(match[1] ?? "");
    const node = match[2];
    const functionName = node?.split("::").at(-1)?.replace(/\[.*$/, "");
    found.push({
      tool: "pytest",
      ...(node !== undefined ? { test: node } : {}),
      file,
      names: functionName !== undefined && IDENTIFIER.test(functionName) ? [functionName] : [],
    });
  }
  return found;
};

const PARSERS: ReadonlyArray<[Exclude<FingerprintTool, "unrecognized">, Parser]> = [
  ["tsc", parseTsc],
  ["mypy", parseMypy],
  ["dependency-cruiser", parseDependencyCruiser],
  ["biome", parseBiome],
  ["ruff", parseRuff],
  ["node-test", parseNodeTest],
  ["pytest", parsePytest],
];

// 识别不了工具时按步名与命令里的关键字推断步骤类型
function kindByKeywords(name: string, command: string | undefined): VerifyStepKind {
  const text = `${name} ${command ?? ""}`.toLowerCase();
  const rules: ReadonlyArray<[VerifyStepKind, RegExp]> = [
    ["test", /测试|\btest|pytest|jest|vitest|mocha/],
    ["type", /类型|\btypes?\b|\btsc\b|mypy|pyright|typecheck|\bcheck\b/],
    ["layer", /分层|depcruise|dependency-cruiser|\bdeps\b|import-linter/],
    ["format", /格式|format|prettier|biome/],
    ["lint", /\blint|ruff|eslint|flake8/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown";
}

export function parseStepOutput(step: {
  name: string;
  command?: string;
  output: string;
}): StepFingerprints {
  const lines = stripAnsi(step.output).split("\n");
  for (const [tool, parse] of PARSERS) {
    const fingerprints = parse(lines);
    if (fingerprints.length > 0) {
      return {
        tool,
        kind: TOOL_KIND[tool],
        recognized: true,
        fingerprints: fingerprints.slice(0, MAX_FINGERPRINTS_PER_STEP),
      };
    }
  }
  return {
    kind: kindByKeywords(step.name, step.command),
    recognized: false,
    fingerprints: [{ tool: "unrecognized", names: [] }],
  };
}

// 指纹键：步名、工具、错误码或规则名或测试名、报错文件（分层另加被依赖端）；行号与报错措辞不进键
export function fingerprintKey(stepName: string, fingerprint: Fingerprint): string {
  return [
    stepName,
    fingerprint.tool,
    fingerprint.code ?? fingerprint.rule ?? fingerprint.test ?? "",
    fingerprint.file ?? "",
    fingerprint.to ?? "",
  ].join("\u0000");
}

// 给人与模型看的指纹简述：工具 错误码/规则/测试名 @ 文件（→ 被依赖端）
export function describeFingerprint(fingerprint: Fingerprint): string {
  if (fingerprint.tool === "unrecognized") {
    return "未识别的报错";
  }
  const head = fingerprint.code ?? fingerprint.rule ?? fingerprint.test ?? "";
  const where =
    fingerprint.file !== undefined
      ? ` @ ${fingerprint.file}${fingerprint.to !== undefined ? ` → ${fingerprint.to}` : ""}`
      : "";
  return `${fingerprint.tool} ${head}${where}`;
}
