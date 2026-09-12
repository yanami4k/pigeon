// Grant 确定性匹配（M4 S6，决策 3 约束 5）：工具名精确相等 + 可选 pathPrefix 目录包含
// （paths.ts realpath 机制），无自由文本模式；非路径参数或解析失败 → 不匹配，回落人工
// 审批（授权不猜）。排律由 adapter 求值顺序承载（deny 清单 → 会话 grant → 配置 grant →
// yolo → read 自动 → prompt），本模块只负责匹配语义。
import type { ConfigGrantRule } from "../state/grants.ts";
import { isPathInsideDir } from "./paths.ts";

// grant 命中出处：adapter 据此记 approvedBy = human:grant / policy:config，
// intent 的 grantRef 逐字回指（决策 3：每次自动放行账本回指具体 grant/配置条目）
export interface GrantMatchOutcome {
  readonly source: "session-grant" | "config-rule";
  // session-grant：grant_<ulid>（grant.created 的 grantId）；
  // config-rule：规则的 promotedFrom.grantId（M4 收口决策 ①：稳定身份——位置序号随
  // /revoke config#N 前移，历史回指会漂移；grantId 是 ULID，删别的规则不改它）
  readonly refId: string;
}

// ---- 匹配 ----

// 取调用的路径参数：grant 匹配只认 args.path 字符串（M3 工具一律对象参数）；
// 无路径参数 = 非路径调用
function extractPathArg(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("path" in args)) {
    return undefined;
  }
  const path = (args as { path: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

// 作用域匹配（决策 3a）：工具名精确相等 + 可选 pathPrefix 目录包含。
// pathPrefix 规则必须有工作区根可做 realpath 解析，否则不匹配（fail-closed 到人工）
export function scopeMatches(
  workspaceRoot: string | undefined,
  tool: string,
  pathPrefix: string | undefined,
  toolName: string,
  args: unknown
): boolean {
  if (tool !== toolName) {
    return false;
  }
  if (pathPrefix === undefined) {
    return true;
  }
  if (workspaceRoot === undefined) {
    return false;
  }
  const pathArg = extractPathArg(args);
  if (pathArg === undefined) {
    return false;
  }
  return isPathInsideDir(workspaceRoot, pathPrefix, pathArg);
}

// 固化规则求值：按文件序首个命中者回指其稳定身份（promotedFrom.grantId）；
// 无命中返回 null（继续排律下行）。序号只在 /grants 展示与 /revoke 输入面使用
export function matchConfigGrants(
  rules: readonly ConfigGrantRule[],
  workspaceRoot: string | undefined,
  toolName: string,
  args: unknown
): GrantMatchOutcome | null {
  for (const rule of rules) {
    if (scopeMatches(workspaceRoot, rule.tool, rule.pathPrefix, toolName, args)) {
      return { source: "config-rule", refId: rule.promotedFrom.grantId };
    }
  }
  return null;
}
