// glob（tier: read）：在工作区内按文件名模式找文件，按修改时间从新到旧排列（决策 368）。只读工具：审批属读档
//（自动放行），可与其他读并行。文件清单经执行端由 rg --files、git ls-files 或 find 给出（遵守 .gitignore、跳过 .git，
// 口径同 grep），按文件名模式过滤后逐个文件按真实路径筛（见 search-backend.ts）；排序与上限在这里做。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { basenamePrefilter, globToRegExp } from "./glob-match.ts";
import { backendCache, omittedDetails, type SearchToolOptions } from "./grep.ts";
import {
  relativeToStart,
  resultNotes,
  runListing,
  type SearchBackend,
  type SearchBackendKind,
  SearchEnvironmentError,
  SearchToolError,
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
  // 略去的文件数（同 grep）
  outsideOmitted: number;
  unsafeOmitted: number;
  uncheckedOmitted: number;
}

export function globDescription(maxResults: number): string {
  return (
    "Finds files in the workspace by file name pattern, newest first by modification time. " +
    "By default it respects .gitignore, skips .git, and includes hidden files. " +
    "pattern is like **/*.ts or src/*.json (* does not cross directories, ** crosses any number of directories, " +
    "? matches one character, {a,b} matches either); path is the directory to start from (default: the workspace root), " +
    "and pattern is matched relative to it. " +
    `At most ${maxResults} files are listed; beyond that, the total is given, so narrow the search and try again.`
  );
}

export function createGlobTool(
  host: WorkspaceHost,
  options: SearchToolOptions,
  backendOf: () => Promise<SearchBackend> = backendCache(host, options)
): PigeonAgentTool<typeof GlobParamsSchema, GlobDetails> {
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
          "Neither ripgrep nor git is available on this machine, so files cannot be listed; use run_command instead"
        );
      }
      const start = await searchStart(host, args.path ?? ".");
      if (start.isFile) {
        throw new SearchToolError(`path must be a directory: ${args.path}`);
      }
      const listing = await runListing(host, backend, start, {
        prefilter: backend.kind === "rg" ? basenamePrefilter(args.pattern) : undefined,
        keep: (file) => matches.test(relativeToStart(file, start)),
        signal,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      // 按修改时间从新到旧，同一时间按路径；执行端给不出修改时间时按路径
      const times = await host.fileMtimes?.(listing.files);
      const listed =
        times !== undefined ? listing.files.filter((file) => times.has(file)) : listing.files;
      listed.sort(
        (a, b) => (times?.get(b) ?? 0) - (times?.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
      );
      const shown = listed.slice(0, options.maxResults);
      const notes = resultNotes({
        total: listed.length,
        shown: shown.length,
        incomplete: listing.incomplete,
        omitted: listing.omitted,
        unit: "files",
        none: "No matching files",
        narrow: "a more specific pattern or path",
      });
      return {
        content: [{ type: "text", text: [...shown, ...notes].join("\n") }],
        details: {
          backend: backend.kind,
          total: listed.length,
          shown: shown.length,
          incomplete: listing.incomplete,
          ...omittedDetails(listing.omitted),
        },
      };
    },
  };
}
