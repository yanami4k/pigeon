// grep（tier: read）：在工作区内按正则搜索文件内容（决策 368）。只读工具：审批属读档（自动放行），可与其他读并行。
// 后端（rg → git grep → grep -r）经执行端在本机或容器里运行，取结果与按真实路径筛选见 search-backend.ts；
// 文件名模式、排序与上限在这里做。搜索范围限工作区（path 照读档规则解析，落在工作区外即拒）。
// 决策 408：内容结果按文件分组（每个文件只写一次路径），整次列出的部分设字数预算，超出的全文存进会话落盘目录
//（与 run_command 截断时同一处，pigeon://outputs/…）；只列文件的输出不变。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { VIRTUAL_PATH_HINT } from "../state/paths.ts";
import type { CommandOutputStore } from "./command-output.ts";
import { basenamePrefilter, fileFilter } from "./glob-match.ts";
import {
  detectSearchBackend,
  type GrepRecord,
  inGitDir,
  MAX_LINE_CHARS,
  type Omitted,
  omittedNotes,
  relativeToStart,
  resultNotes,
  runGrep,
  type SearchBackend,
  type SearchBackendKind,
  type SearchBackendOptions,
  SearchEnvironmentError,
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
  // 匹配行数（files_only 时为文件数）；incomplete 时为"超过"
  total: number;
  // 结果里列出的匹配条数（files_only 时为文件数）
  shown: number;
  // 有匹配的文件数（files_only 时同 total）
  files: number;
  // 输出超过上限，没有统计完
  incomplete: boolean;
  // 决策 408：列出的部分超过字数预算，结果里只放了预算内的部分
  overBudget: boolean;
  // 超过预算时全文（条数上限以内）的落盘位置；没有落盘目录或没存成时缺省
  savedOutput?: { uri: string; bytes: number };
  // 略去的文件数：经链接指向工作区以外的、文件名含换行或控制字符的、未及检查的
  outsideOmitted: number;
  unsafeOmitted: number;
  uncheckedOmitted: number;
}

export interface SearchToolOptions extends SearchBackendOptions {
  maxResults: number;
}

export interface GrepToolOptions extends SearchToolOptions {
  // 决策 408：本会话的落盘目录（与 run_command 共用）；不给即超过预算时不存全文
  outputs?: CommandOutputStore;
}

// 决策 408：内容结果列出部分的字数预算（按字符计，不含末尾的说明）。取 16,000：grep.maxResults 缺省 200 条、每条约 80 字
// （常见代码行宽加行号前缀），不带上下文、行宽正常的搜索只受条数上限约束；带上下文或行很长的宽泛搜索（对比运行里单次
// 4–13 万字，超过 1.2 万字的输出占 grep 总字数的 39%）在这里截住。约为 run_command 结果保留量（开头 8 KiB 加末尾
// 24 KiB）的一半
export const GREP_OUTPUT_BUDGET = 16_000;

export function grepDescription(maxResults: number): string {
  return (
    "在工作区内按正则搜索文件内容（优先用 ripgrep）。缺省遵守 .gitignore、跳过 .git，含隐藏文件。" +
    "pattern 为正则；path 只搜这个目录或文件（缺省整个工作区）；glob 只搜文件名匹配的文件" +
    "（如 *.ts；含 / 时按相对 path 的路径匹配，如 src/**/*.ts）；context 每处匹配前后各带几行；" +
    "files_only 只列出有匹配的文件；ignore_case 忽略大小写。" +
    "结果按文件分组、按路径排序：每个文件先写一行路径，其下逐行「行号: 内容」（上下文行为「行号- 内容」），" +
    `文件之间空一行。最多列 ${maxResults} 条（files_only 时为文件数），超出时给出总数，请缩小范围再搜；` +
    `单行超过 ${MAX_LINE_CHARS} 字符截断；列出的部分超过 ${GREP_OUTPUT_BUDGET} 字时只给前面一部分，全文另存可读。` +
    "宽泛的搜索先用 files_only 只列文件，再按文件细查。" +
    "pattern 用扩展正则（ERE）写法最稳：\\d、\\w 等简写在部分环境不支持，可写成 [0-9]、[A-Za-z0-9_]。"
  );
}

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…（本行截断）` : text;
}

// 一个文件的结果：路径与其下各行（匹配行、上下文行与不相连的段之间的 --）
interface FileBlock {
  path: string;
  lines: Array<{ text: string; match: boolean }>;
}

// 分组后的全文：文件之间空一行
function renderBlocks(blocks: readonly FileBlock[]): string {
  return blocks
    .map((block) => [block.path, ...block.lines.map((line) => line.text)].join("\n"))
    .join("\n\n");
}

// 预算内的部分：按行取，整行放得下才放（路径行与它的第一行一起放）；截在文件中途时这个文件只列已放下的行，
// 末尾不留段间的 --。返回列出的匹配条数与文件数
function withinBudget(
  blocks: readonly FileBlock[],
  budget: number
): { text: string; matches: number; files: number } {
  const lines: string[] = [];
  // 按 join("\n") 计的长度：每行多算一个换行，首行前没有
  let size = -1;
  let matches = 0;
  let files = 0;
  const take = (texts: readonly string[]): boolean => {
    const added = texts.reduce((sum, text) => sum + text.length + 1, 0);
    if (size + added > budget) return false;
    lines.push(...texts);
    size += added;
    return true;
  };
  fill: for (const block of blocks) {
    let opened = false;
    for (const line of block.lines) {
      const texts = opened
        ? [line.text]
        : [...(lines.length > 0 ? [""] : []), block.path, line.text];
      if (!take(texts)) break fill;
      if (!opened) files += 1;
      opened = true;
      if (line.match) matches += 1;
    }
  }
  while (lines.at(-1) === "--") lines.pop();
  return { text: lines.join("\n"), matches, files };
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

// 略去的文件数写进 details
export function omittedDetails(omitted: Omitted) {
  return {
    outsideOmitted: omitted.outside,
    unsafeOmitted: omitted.unsafe,
    uncheckedOmitted: omitted.unchecked,
  };
}

export function createGrepTool(
  host: WorkspaceHost,
  options: GrepToolOptions,
  backendOf: () => Promise<SearchBackend> = backendCache(host, options)
): PigeonAgentTool<typeof GrepParamsSchema, GrepDetails> {
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
      const start = await searchStart(host, args.path ?? ".");
      const filesOnly = args.files_only === true;
      const context = args.context ?? 0;
      const prefilter =
        backend.kind === "rg" && args.glob !== undefined ? basenamePrefilter(args.glob) : undefined;
      const run = await runGrep(
        host,
        backend,
        {
          pattern: args.pattern,
          start,
          ignoreCase: args.ignore_case === true,
          context,
          filesOnly,
          ...(prefilter !== undefined ? { prefilter } : {}),
          keep: (relPath) => !inGitDir(relPath) && matchesGlob(relativeToStart(relPath, start)),
        },
        {
          signal,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        }
      );
      // 降级时注明用的是哪个后端：扩展正则下 \d 之类的写法可能没命中
      const lead =
        backend.kind === "rg"
          ? []
          : [`本次用 ${backend.kind === "git" ? "git grep" : "grep -r"} 搜索（扩展正则）`];
      const countNotes = (total: number, shown: number) =>
        resultNotes({
          total,
          shown,
          incomplete: run.incomplete,
          omitted: run.omitted,
          unit: filesOnly ? "个文件" : "条匹配",
          measure: filesOnly ? "个" : "条",
          none: filesOnly ? "没有匹配的文件" : "没有匹配",
          narrow: "更具体的 pattern、path 或 glob",
        });
      const common = { backend: backend.kind, incomplete: run.incomplete };
      // 内容结果：分组的正文与末尾的说明之间空一行
      const compose = (body: string, notes: readonly string[]): string => {
        const gap = body !== "" && notes.length > 0 ? [""] : [];
        return [...lead, ...(body !== "" ? [body] : []), ...gap, ...notes].join("\n");
      };
      if (filesOnly) {
        const files = [...run.files].sort();
        const lines = files.slice(0, options.maxResults);
        return {
          content: [
            {
              type: "text",
              text: [...lead, ...lines, ...countNotes(files.length, lines.length)].join("\n"),
            },
          ],
          details: {
            ...common,
            total: files.length,
            shown: lines.length,
            files: files.length,
            overBudget: false,
            ...omittedDetails(run.omitted),
          },
        };
      }
      // 按文件路径排序，同一文件内按行序；每个文件只写一次路径，有上下文时不相连的段之间用 -- 分隔
      const byFile = new Map<string, GrepRecord[]>();
      let total = 0;
      for (const record of run.records) {
        if (record.match) total += 1;
        const list = byFile.get(record.path);
        if (list === undefined) byFile.set(record.path, [record]);
        else list.push(record);
      }
      const blocks: FileBlock[] = [];
      let listed = 0;
      for (const file of [...byFile.keys()].sort()) {
        if (listed >= options.maxResults) break;
        const block: FileBlock = { path: file, lines: [] };
        let previous: number | undefined;
        for (const record of (byFile.get(file) ?? []).sort((a, b) => a.line - b.line)) {
          if (record.match && listed >= options.maxResults) break;
          if (context > 0 && previous !== undefined && previous !== record.line - 1) {
            block.lines.push({ text: "--", match: false });
          }
          block.lines.push({
            text: `${record.line}${record.match ? ":" : "-"} ${clip(record.text)}`,
            match: record.match,
          });
          previous = record.line;
          if (record.match) listed += 1;
        }
        blocks.push(block);
      }
      const full = renderBlocks(blocks);
      if (full.length <= GREP_OUTPUT_BUDGET) {
        return {
          content: [{ type: "text", text: compose(full, countNotes(total, listed)) }],
          details: {
            ...common,
            total,
            shown: listed,
            files: byFile.size,
            overBudget: false,
            ...omittedDetails(run.omitted),
          },
        };
      }
      // 决策 408：超过预算——结果里只放预算内的部分，写明总条数与文件数并提示收窄；全文（条数上限以内）存进落盘目录
      const fitted = withinBudget(blocks, GREP_OUTPUT_BUDGET);
      let savedOutput: { uri: string; bytes: number } | undefined;
      let archive = "";
      if (options.outputs !== undefined) {
        const bytes = Buffer.from(full, "utf8");
        try {
          savedOutput = { uri: options.outputs.save(bytes), bytes: bytes.length };
          archive =
            `${listed < total ? `前 ${listed} 条匹配的` : ""}全文已存为 ${savedOutput.uri}，` +
            `可用 read_file 按 offset 读取需要的一段；${VIRTUAL_PATH_HINT}`;
        } catch (error) {
          archive = `全文未能保存（${error instanceof Error ? error.message : String(error)}）`;
        }
      }
      const totals = run.incomplete
        ? `至少 ${total} 条匹配、${byFile.size} 个文件（输出过大，未统计完）`
        : `共 ${total} 条匹配、${byFile.size} 个文件`;
      const budgetNote =
        `${totals}；列出的部分超过 ${GREP_OUTPUT_BUDGET} 字，上面只列出前 ${fitted.files} 个文件里的 ` +
        `${fitted.matches} 条。宽泛的搜索请先用 files_only 只列文件，或缩小 path，再按文件细查`;
      return {
        content: [
          {
            type: "text",
            text: compose(fitted.text, [
              budgetNote,
              ...(archive !== "" ? [archive] : []),
              ...omittedNotes(run.omitted),
            ]),
          },
        ],
        details: {
          ...common,
          total,
          shown: fitted.matches,
          files: byFile.size,
          overBudget: true,
          ...(savedOutput !== undefined ? { savedOutput } : {}),
          ...omittedDetails(run.omitted),
        },
      };
    },
  };
}
