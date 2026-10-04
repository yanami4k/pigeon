// grep 与 glob 的登记点（决策 368）：两者都是只读工具——审批属读档（自动放行），可与其他读并行（353 的并行登记
// 以此处的 READ_ONLY_SEARCH_TOOLS 为准）。两件共用一次后端探测。
import { createGlobTool, GLOB_TOOL, GlobParamsSchema } from "./glob.ts";
import {
  backendCache,
  createGrepTool,
  GREP_TOOL,
  GrepParamsSchema,
  type SearchToolOptions,
} from "./grep.ts";
import type { ToolRegistration } from "./registry.ts";
import type { WorkspaceHost } from "./workspace-host.ts";

export const READ_ONLY_SEARCH_TOOLS: readonly string[] = [GREP_TOOL, GLOB_TOOL];

export function searchToolRegistrations(): ToolRegistration[] {
  return [
    {
      name: GREP_TOOL,
      description: "按正则搜索工作区内的文件内容",
      parameters: GrepParamsSchema,
      tier: "read",
      pathConfinement: { kind: "workspace" },
      executionMode: "parallel",
    },
    {
      name: GLOB_TOOL,
      description: "按文件名模式找工作区内的文件",
      parameters: GlobParamsSchema,
      tier: "read",
      pathConfinement: { kind: "workspace" },
      executionMode: "parallel",
    },
  ];
}

export function createSearchTools(
  host: WorkspaceHost,
  options: { grep: SearchToolOptions; glob: SearchToolOptions }
) {
  const backendOf = backendCache(host, options.grep);
  return [
    createGrepTool(host, options.grep, backendOf),
    createGlobTool(host, options.glob, backendOf),
  ];
}
