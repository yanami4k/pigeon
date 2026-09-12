// CLI grant 命令（M4 S6，决策 3 + D6）：/grants 列表、/revoke <id> 撤销、
// /grants save <id> 升格。/grants 是 grant 的唯一展示入口（决策 3b：崩溃恢复不加
// 特殊展示行，生效 grant 统一由本命令呈现）；升格与配置的正规写入方都是人的显式
// 命令（约束 3：agent / 模型 / 后台流程无写 grants.json 的代码路径）。
// IO 全依赖注入（write 形状同 repl.ts 的 WriteFn；此处内联结构类型以避免
// grants ↔ repl 类型环——repl 依赖 grants 的命令上下文，方向不可逆）
import {
  appendGrantConfigRule,
  type ConfigGrantRule,
  GrantNotFoundError,
  removeGrantConfigRule,
  type SessionGrantStore,
} from "../persistence/grants.ts";
import { asGrantId, type GrantId, type SessionId } from "../state/ids.ts";
import { shortId, summarizeArgs } from "./format.ts";

export interface GrantsCommandContext {
  // 工作区根（.pigeon/grants.json 所在；目录限定解析根）
  root: string;
  // 会话 grant 运行态（含命中计数）
  store: SessionGrantStore;
  // 会话启动时装载的固化规则（求值面会话内冻结）
  configRules: readonly ConfigGrantRule[];
  // 本会话 sessionId（升格出处 promotedFrom.sessionId）
  sessionId: SessionId;
  write: (text: string) => void;
}

// 时间渲染：UTC（ISO 切片），与 session list 同约定——测试文本比对与 grep 友好
function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

// 作用域措辞（唯一约定：/grants 与 trace 共用口径）
function scopeWording(pathPrefix: string | undefined): string {
  return pathPrefix === undefined ? "工具级（不限目录）" : `仅限目录 ${pathPrefix}`;
}

// 解析并执行一条斜杠命令（tokens = 去掉 "/" 后的空白分词）。
// 返回 false = 非 grant 命令（REPL 交其他分发）；语法/语义错误响亮抛错由 REPL 呈现
export function runGrantCommand(tokens: string[], ctx: GrantsCommandContext): boolean {
  const [head, ...rest] = tokens;
  if (head === "grants") {
    if (rest.length === 0) {
      listGrants(ctx);
      return true;
    }
    if (rest[0] === "save" && rest.length === 2 && rest[1] !== undefined) {
      promoteGrant(ctx, rest[1]);
      return true;
    }
    throw new Error("用法：/grants ｜ /grants save <grantId>");
  }
  if (head === "revoke") {
    if (rest.length !== 1 || rest[0] === undefined) {
      throw new Error("用法：/revoke <grantId 或 config#序号>");
    }
    revokeGrant(ctx, rest[0]);
    return true;
  }
  return false;
}

// /grants：会话 grant（createdAt / 命中次数 / 作用域 / 首调摘要）+ 固化规则
//（promotedAt / 出处会话与首调）。无任何生效项时如实说明
function listGrants(ctx: GrantsCommandContext): void {
  const lines: string[] = [];
  const sessionGrants = ctx.store.list();
  lines.push(`会话放权（${sessionGrants.length}）：`);
  for (const grant of sessionGrants) {
    lines.push(
      `  ${grant.grantId} ｜ ${grant.tool} ｜ ${scopeWording(grant.pathPrefix)} ｜ ` +
        `创建 ${formatTime(grant.createdAt)} ｜ 命中 ${grant.hitCount} 次 ｜ ` +
        `首调 ${grant.firstCall.toolCallId}（${summarizeArgs(grant.firstCall.args)}）`
    );
  }
  lines.push(`固化规则（${ctx.configRules.length}，来自 .pigeon/grants.json）：`);
  for (const [index, rule] of ctx.configRules.entries()) {
    lines.push(
      `  config#${index} ｜ ${rule.tool} ｜ ${scopeWording(rule.pathPrefix)} ｜ ` +
        `升格 ${formatTime(rule.promotedFrom.promotedAt)} ｜ ` +
        `出处 会话 ${shortId(rule.promotedFrom.sessionId)} / grant ${shortId(rule.promotedFrom.grantId)} ｜ ` +
        `首调 ${rule.promotedFrom.firstCall.toolCallId}`
    );
  }
  if (sessionGrants.length === 0 && ctx.configRules.length === 0) {
    lines.push("  （无——审批提示可用 [a]/[d] 创建会话放权，/grants save <id> 升格固化）");
  }
  ctx.write(`${lines.join("\n")}\n`);
}

// /grants save <id>：升格——会话 grant → 项目配置（D6：promotedFrom 出处结构化留证）。
// 固化规则在下次会话启动时进求值面（本会话求值冻结），输出如实标注
function promoteGrant(ctx: GrantsCommandContext, id: string): void {
  let grantId: GrantId;
  try {
    grantId = asGrantId(id);
  } catch {
    throw new Error(`升格对象必须是会话 grant（grant_ 前缀）：${id}`);
  }
  const grant = ctx.store.get(grantId);
  if (grant === undefined) {
    throw new GrantNotFoundError(`grant 不存在或已撤销：${id}（用 /grants 查看生效列表）`);
  }
  appendGrantConfigRule(ctx.root, {
    tool: grant.tool,
    ...(grant.pathPrefix !== undefined ? { pathPrefix: grant.pathPrefix } : {}),
    promotedFrom: {
      grantId: grant.grantId,
      sessionId: ctx.sessionId,
      firstCall: grant.firstCall,
      promotedAt: Date.now(),
    },
  });
  ctx.write(
    `已升格 ${grant.grantId} → .pigeon/grants.json（固化规则下次会话启动时生效；本会话求值冻结）\n`
  );
}

// /revoke <id>：会话 grant 立即停免审（grant.revoked 事件留证）；配置规则从
// grants.json 移除——求值面会话内冻结，本次会话仍按原规则求值，如实标注
function revokeGrant(ctx: GrantsCommandContext, id: string): void {
  if (id.startsWith("grant_")) {
    ctx.store.revoke(asGrantId(id));
    ctx.write(`已撤销会话放权 ${id}：立即生效，后续调用重新弹人工审批\n`);
    return;
  }
  const match = /^config#(\d+)$/.exec(id);
  if (match !== null) {
    const removed = removeGrantConfigRule(ctx.root, Number(match[1]));
    ctx.write(
      `已移除固化规则 config#${match[1]}（${removed.tool}）：求值面会话内冻结，下次会话启动起不再生效\n`
    );
    return;
  }
  throw new Error(`无法撤销：${id}（会话 grant 用 grant_ 前缀完整 id；配置规则用 config#序号）`);
}
