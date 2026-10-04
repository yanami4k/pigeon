// glob（tier: read）：在工作区内按文件名模式找文件，按修改时间从新到旧排列（决策 368）。只读工具：审批属读档
//（自动放行），可与其他读并行。文件清单经执行端由 rg --files、git ls-files 或 find 给出（遵守 .gitignore、跳过 .git，
// 口径同 grep）；模式判定、禁读名单（决策 355）、排序与上限在这里统一做。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { basenamePrefilter, globToRegExp } from "./glob-match.ts";
import { backendCache, backendFailure, type SearchToolOptions } from "./grep.ts";
import { readDenyList } from "./read-deny.ts";
import {
  inGitDir,
  listFilesArgs,
  parseFileList,
  relativeToStart,
  resultNotes,
  runSearch,
  SEARCH_OUTPUT_CAP,
  type SearchBackend,
  type SearchBackendKind,
  SearchEnvironmentError,
  SearchToolError,
  screenByRealPath,
  searchStart,
} from "./search-backend.ts";
import type { WorkspaceHost } from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult } from "./wrap.ts";

export const GLOB_TOOL = "glob";

export const GlobParamsSchema = Type.Object({
  pattern: Type.String({ minLength: 1 }),
  path: Type.Optional(Type.String({ minLength: 1 })),
});
export type GlobParams = Static<typeof GlobParamsSchema>;

export interface GlobDetails {
  backend: SearchBackendKind;
  total: number;
  shown: number;
  incomplete: boolean;
  deniedOmitted: number;
  outsideOmitted: number;
}

export function globDescription(maxResults: number): string {
  return (
    "在工作区内按文件名模式找文件，按修改时间从新到旧排列。缺省遵守 .gitignore、跳过 .git，含隐藏文件。" +
    "pattern 如 **/*.ts、src/*.json（* 不跨目录，** 跨任意层目录，? 一个字符，{a,b} 任选其一）；" +
    "path 为起点目录（缺省工作区根），pattern 相对它匹配。" +
    `最多列 ${maxResults} 个，超出时给出总数，请缩小范围再找。`
  );
}

export function createGlobTool(
  host: WorkspaceHost,
  options: SearchToolOptions,
  backendOf: () => Promise<SearchBackend> = backendCache(host, options)
): PigeonAgentTool<typeof GlobParamsSchema, GlobDetails> {
  const deny = readDenyList(options.readDeny);
  return {
    name: GLOB_TOOL,
    label: GLOB_TOOL,
    description: globDescription(options.maxResults),
    parameters: GlobParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<GlobDetails>> {
      const args = Value.Parse(GlobParamsSchema, params);
      // 文件名模式先编译：写错即报给模型，不跑后端
      const matches = globToRegExp(args.pattern);
      const backend = await backendOf();
      // Windows 本机的 find 是另一个程序：没有 rg 与 git 时不降级
      if (backend.kind === "grep" && host.platform === "win32") {
        throw new SearchEnvironmentError(
          "本机没有 ripgrep 与 git，无法列出文件；可改用 run_command"
        );
      }
      const start = await searchStart(host, args.path ?? ".", deny);
      if (start.isFile) {
        throw new SearchToolError(`path 须是目录：${args.path}`);
      }
      const listing = listFilesArgs(
        backend,
        start.rel,
        backend.kind === "rg" ? basenamePrefilter(args.pattern) : undefined
      );
      const result = await runSearch(host, listing.program, listing.args, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        signal,
      });
      if (result.timedOut) {
        throw new SearchEnvironmentError("列出文件超时；请缩小范围（更具体的 path）");
      }
      const incomplete = result.outputBytes > SEARCH_OUTPUT_CAP;
      const candidates = [...new Set(parseFileList(result.stdout, listing.nul))].filter(
        (file) => !inGitDir(file) && matches.test(relativeToStart(file, start))
      );
      const omitted = { denied: 0, outside: 0 };
      const readable = await screenByRealPath(host, candidates, deny, omitted, () => 1);
      const files = candidates.filter(readable);
      if (result.exitCode !== 0 && result.exitCode !== 1 && files.length === 0) {
        throw backendFailure(result.stderr, result.exitCode);
      }
      // 按修改时间从新到旧，同一时间按路径；执行端给不出修改时间时按路径
      const times = await host.fileMtimes?.(files);
      const listed = times !== undefined ? files.filter((file) => times.has(file)) : files;
      listed.sort(
        (a, b) => (times?.get(b) ?? 0) - (times?.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
      );
      const shown = listed.slice(0, options.maxResults);
      const notes = resultNotes({
        total: listed.length,
        shown: shown.length,
        incomplete,
        deniedOmitted: omitted.denied,
        outsideOmitted: omitted.outside,
        unit: "个文件",
        measure: "个",
        none: "没有匹配的文件",
        narrow: "更具体的 pattern 或 path",
      });
      return {
        content: [{ type: "text", text: [...shown, ...notes].join("\n") }],
        details: {
          backend: backend.kind,
          total: listed.length,
          shown: shown.length,
          incomplete,
          deniedOmitted: omitted.denied,
          outsideOmitted: omitted.outside,
        },
      };
    },
  };
}
