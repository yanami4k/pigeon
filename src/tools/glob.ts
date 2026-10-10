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
      const start = await searchStart(host, args.path ?? ".");
      if (start.isFile) {
        throw new SearchToolError(`path 须是目录：${args.path}`);
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
          incomplete: listing.incomplete,
          ...omittedDetails(listing.omitted),
        },
      };
    },
  };
}
