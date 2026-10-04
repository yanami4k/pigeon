// 工具的执行模式登记（决策 353，按上游的逐工具模式落地）：读类工具标为可并行，其余一律串行，没登记的也按串行。
// Agent 一律设为并行模式，上游的规则是一批里只要有一件串行即整批串行：纯读的一批同时执行；读写混排的一批按顺序逐个
// 准备（含审批与预览）、执行，审批预览的时机与串行时一样（连发几个 edit_file 改同一文件时，后一个的预览基于前一个改完的内容）。
// 代价：混排批里的读也不并行。grep、glob 合并后加进来
import {
  LIST_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
} from "../memory/search-tools.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../tools/host-scope.ts";

export const PARALLEL_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  SEARCH_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  LIST_SESSIONS_TOOL,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
]);

export function toolExecutionModeOf(name: string): "parallel" | "sequential" {
  return PARALLEL_TOOLS.has(name) ? "parallel" : "sequential";
}
