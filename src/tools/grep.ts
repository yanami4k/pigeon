// grep（tier: read）：在工作区内按正则搜索文件内容（决策 368）。只读工具：审批属读档（自动放行），可与其他读并行。
// 后端（rg → git grep → grep -r）经执行端在本机或容器里运行，见 search-backend.ts；文件名模式、禁读名单（决策 355）、
// 排序与上限在这里统一做。搜索范围限工作区（path 经路径围栏）。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { basenamePrefilter, fileFilter } from "./glob-match.ts";
import { readDenyList } from "./read-deny.ts";
import {
  detectSearchBackend,
  type GrepRecord,
  grepArgs,
  inGitDir,
  MAX_LINE_CHARS,
  parseFileList,
  parseGrepOutput,
  relativeToStart,
  resultNotes,
  runSearch,
  SEARCH_OUTPUT_CAP,
  type SearchBackend,
  type SearchBackendKind,
  type SearchBackendOptions,
  SearchEnvironmentError,
  SearchToolError,
  screenByRealPath,
  searchStart,
} from "./search-backend.ts";
import type { WorkspaceHost } from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult } from "./wrap.ts";

export const GREP_TOOL = "grep";

export const GrepParamsSchema = Type.Object({
  pattern: Type.String({ minLength: 1 }),
  path: Type.Optional(Type.String({ minLength: 1 })),
  glob: Type.Optional(Type.String({ minLength: 1 })),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
  files_only: Type.Optional(Type.Boolean()),
  ignore_case: Type.Optional(Type.Boolean()),
});
export type GrepParams = Static<typeof GrepParamsSchema>;

export interface GrepDetails {
  backend: SearchBackendKind;
  // 匹配行数（files_only 时为文件数）；incomplete 时为"至少"
  total: number;
  shown: number;
  // 输出超过上限，没有统计完
  incomplete: boolean;
  // 按禁读名单略去的条数
  deniedOmitted: number;
  // 经符号链接落在工作区以外、因而略去的条数
  outsideOmitted: number;
}

export interface SearchToolOptions extends SearchBackendOptions {
  maxResults: number;
  // 设置追加的禁读项（permissions.readDeny）；内置名单总在
  readDeny?: readonly string[];
}

export function grepDescription(maxResults: number): string {
  return (
    "在工作区内按正则搜索文件内容（优先用 ripgrep）。缺省遵守 .gitignore、跳过 .git，含隐藏文件。" +
    "pattern 为正则；path 只搜这个目录或文件（缺省整个工作区）；glob 只搜文件名匹配的文件" +
    "（如 *.ts；含 / 时按相对 path 的路径匹配，如 src/**/*.ts）；context 每处匹配前后各带几行；" +
    "files_only 只列出有匹配的文件；ignore_case 忽略大小写。" +
    `结果按路径排序，每行形如「路径:行号:内容」（上下文行用 - 分隔），最多列 ${maxResults} 条` +
    "（files_only 时为文件数），超出时给出总数，请缩小范围再搜；单行超过 2000 字符截断。" +
    "pattern 用扩展正则（ERE）写法最稳：\\d、\\w 等简写在部分环境不支持，可写成 [0-9]、[A-Za-z0-9_]。"
  );
}

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…（本行截断）` : text;
}

// 后端缓存：一次会话内探测一次
export function backendCache(
  host: WorkspaceHost,
  options: SearchBackendOptions
): () => Promise<SearchBackend> {
  let detected: Promise<SearchBackend | undefined> | undefined;
  return async () => {
    detected ??= detectSearchBackend(host, options);
    const backend = await detected;
    if (backend === undefined) {
      throw new SearchEnvironmentError(
        "本环境没有可用的搜索程序（ripgrep、git、grep 都没有）；可改用 run_command"
      );
    }
    return backend;
  };
}

// 后端出错（退出码不是 0 或 1）且没有任何结果：正则写错等归模型侧，其余归环境
export function backendFailure(stderr: string, exitCode: number | null): Error {
  const message = stderr.trim().slice(0, 1000) || `退出码 ${exitCode}`;
  return /regex|regular expression|parse error|Unmatched|Invalid|unmatched|invalid/.test(message)
    ? new SearchToolError(`模式有误：${message}`)
    : new SearchEnvironmentError(`搜索出错：${message}`);
}

export function createGrepTool(
  host: WorkspaceHost,
  options: SearchToolOptions,
  backendOf: () => Promise<SearchBackend> = backendCache(host, options)
): PigeonAgentTool<typeof GrepParamsSchema, GrepDetails> {
  const deny = readDenyList(options.readDeny);
  return {
    name: GREP_TOOL,
    label: GREP_TOOL,
    description: grepDescription(options.maxResults),
    parameters: GrepParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<GrepDetails>> {
      const args = Value.Parse(GrepParamsSchema, params);
      // 文件名模式先编译：写错即报给模型，不跑搜索
      const matchesGlob = args.glob !== undefined ? fileFilter(args.glob) : () => true;
      const backend = await backendOf();
      const start = await searchStart(host, args.path ?? ".", deny);
      const filesOnly = args.files_only === true;
      const context = args.context ?? 0;
      const prefilter =
        backend.kind === "rg" && args.glob !== undefined ? basenamePrefilter(args.glob) : undefined;
      const result = await runSearch(
        host,
        backend.program,
        grepArgs(backend, {
          pattern: args.pattern,
          searchPath: start.rel,
          ignoreCase: args.ignore_case === true,
          context,
          filesOnly,
          ...(prefilter !== undefined ? { prefilter } : {}),
        }),
        { ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), signal }
      );
      if (result.timedOut) {
        throw new SearchEnvironmentError("搜索超时；请缩小范围（更具体的 path 或 glob）");
      }
      const incomplete = result.outputBytes > SEARCH_OUTPUT_CAP;
      const keep = (relPath: string) =>
        !inGitDir(relPath) && matchesGlob(relativeToStart(relPath, start));
      const failed = result.exitCode !== 0 && result.exitCode !== 1;
      const omitted = { denied: 0, outside: 0 };
      let lines: string[];
      let total: number;
      let shown: number;
      if (filesOnly) {
        const nul = backend.kind !== "grep" || backend.gnu === true;
        const candidates = [...new Set(parseFileList(result.stdout, nul))].filter(keep);
        const readable = await screenByRealPath(host, candidates, deny, omitted, () => 1);
        const files = candidates.filter(readable);
        if (failed && files.length === 0) throw backendFailure(result.stderr, result.exitCode);
        files.sort();
        total = files.length;
        lines = files.slice(0, options.maxResults);
        shown = lines.length;
      } else {
        const records = parseGrepOutput(backend, result.stdout).filter(
          (record): record is Extract<GrepRecord, { kind: "line" }> =>
            record.kind === "line" && keep(record.path)
        );
        const matchCount = new Map<string, number>();
        for (const record of records) {
          if (record.match) matchCount.set(record.path, (matchCount.get(record.path) ?? 0) + 1);
        }
        const readable = await screenByRealPath(
          host,
          [...new Set(records.map((record) => record.path))],
          deny,
          omitted,
          (file) => matchCount.get(file) ?? 0
        );
        // 按文件路径排序，同一文件内按行序；有上下文时不相连的段之间、文件之间用 -- 分隔
        const byFile = new Map<string, Extract<GrepRecord, { kind: "line" }>[]>();
        total = 0;
        for (const record of records) {
          if (!readable(record.path)) continue;
          if (record.match) total += 1;
          const list = byFile.get(record.path);
          if (list === undefined) byFile.set(record.path, [record]);
          else list.push(record);
        }
        if (failed && byFile.size === 0) throw backendFailure(result.stderr, result.exitCode);
        lines = [];
        shown = 0;
        for (const file of [...byFile.keys()].sort()) {
          if (shown >= options.maxResults) break;
          let previous: number | undefined;
          for (const record of (byFile.get(file) ?? []).sort((a, b) => a.line - b.line)) {
            if (record.match && shown >= options.maxResults) break;
            if (context > 0 && lines.length > 0 && previous !== record.line - 1) lines.push("--");
            const sep = record.match ? ":" : "-";
            lines.push(`${record.path}${sep}${record.line}${sep}${clip(record.text)}`);
            previous = record.line;
            if (record.match) shown += 1;
          }
        }
      }
      const notes = resultNotes({
        total,
        shown,
        incomplete,
        deniedOmitted: omitted.denied,
        outsideOmitted: omitted.outside,
        unit: filesOnly ? "个文件" : "条匹配",
        measure: filesOnly ? "个" : "条",
        none: filesOnly ? "没有匹配的文件" : "没有匹配",
        narrow: "更具体的 pattern、path 或 glob",
      });
      // 降级时注明用的是哪个后端：扩展正则下 \d 之类的写法可能没命中
      const lead =
        backend.kind === "rg"
          ? []
          : [`本次用 ${backend.kind === "git" ? "git grep" : "grep -r"} 搜索（扩展正则）`];
      return {
        content: [{ type: "text", text: [...lead, ...lines, ...notes].join("\n") }],
        details: {
          backend: backend.kind,
          total,
          shown,
          incomplete,
          deniedOmitted: omitted.denied,
          outsideOmitted: omitted.outside,
        },
      };
    },
  };
}
