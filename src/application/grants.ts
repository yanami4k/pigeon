// grant 斜杠命令层（M4 S6 决策 3 + D6；M2 S3 决策 030 从 cli/ 归位 application/）：
// /grants 列表、/revoke <id> 撤销、/grants save <id> 升格。cli REPL 与 tui 消息区两个
// Actor 共用这同一份命令逻辑（025 的方向：共用逻辑住 Controller 层，Actor 互依别扭）；
// 输出经注入的 write 回调投影到各自界面（REPL 终端 / TUI 消息区），命令层不关心落点。
// /grants 是 grant 的唯一展示入口（决策 3b：崩溃恢复不加特殊展示行，生效 grant 统一
// 由本命令呈现）；升格与配置的正规写入方都是人的显式命令（约束 3：agent / 模型 /
// 后台流程无写 grants.json 的代码路径）。
// 升格与移除只操作放权配置文件（决策 128：原先的固化升格与固化移除两种留痕已退役）；
// 固化规则的稳定身份是 promotedFrom.grantId，审批决定的配置规则命中按它回指。
// M5.5 S5（决策 048）：exec 档的精确命令放权同一套流程——升格与移除都携带 command。
// IO 全依赖注入：write 是内联结构类型（一行文本回调），命令层不 import 任何 Actor。

import { GrantNotFoundError, type SessionGrantStore } from "../approvals/grant-store.ts";
import {
  appendGrantConfigRule,
  findPromotedRuleIndex,
  GrantAlreadyPromotedError,
  loadGrantConfig,
  removeGrantConfigRule,
} from "../persistence/grants-config.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import { asGrantId, type GrantId, type SessionId } from "../state/ids.ts";
import { shortId, summarizeArgs } from "./format.ts";

export interface GrantsCommandContext {
  // 治理根（.pigeon/grants.json 所在；目录限定解析根）
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
function scopeWording(pathPrefix: string | undefined, command?: string, shell?: boolean): string {
  if (command !== undefined) {
    return `仅限命令 ${command}${shell === true ? "（经 shell）" : ""}`;
  }
  return pathPrefix === undefined ? "工具级（不限目录）" : `仅限目录 ${pathPrefix}`;
}

// 放权作用域字段的原样携带（升格写配置用）
function scopeFields(scope: { pathPrefix?: string; command?: string; shell?: boolean }): {
  pathPrefix?: string;
  command?: string;
  shell?: boolean;
} {
  return {
    ...(scope.pathPrefix !== undefined ? { pathPrefix: scope.pathPrefix } : {}),
    ...(scope.command !== undefined ? { command: scope.command } : {}),
    ...(scope.shell === true ? { shell: true } : {}),
  };
}

// 解析并执行一条斜杠命令（tokens = 去掉 "/" 后的空白分词）。
// 返回 false = 非 grant 命令（Actor 交其他分发）；语法/语义错误响亮抛错由 Actor 呈现
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
//（promotedAt / 出处会话与首调）。无任何生效项时如实说明。
// config#N 是展示与 /revoke 输入用的位置序号；账本回指用的身份是出处 grant（决策 ①）
function listGrants(ctx: GrantsCommandContext): void {
  const lines: string[] = [];
  const sessionGrants = ctx.store.list();
  lines.push(`会话放权（${sessionGrants.length}）：`);
  for (const grant of sessionGrants) {
    lines.push(
      `  ${grant.grantId} ｜ ${grant.tool} ｜ ${scopeWording(grant.pathPrefix, grant.command, grant.shell)} ｜ ` +
        `创建 ${formatTime(grant.createdAt)} ｜ 命中 ${grant.hitCount} 次 ｜ ` +
        `首调 ${grant.firstCall.toolCallId}（${summarizeArgs(grant.firstCall.args)}）`
    );
  }
  lines.push(`固化规则（${ctx.configRules.length}，来自 .pigeon/grants.json）：`);
  for (const [index, rule] of ctx.configRules.entries()) {
    lines.push(
      `  config#${index} ｜ ${rule.tool} ｜ ${scopeWording(rule.pathPrefix, rule.command, rule.shell)} ｜ ` +
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
// 顺序：查重（同 grantId 已固化则响亮拒绝）→ 写配置。固化规则在下次会话启动时
// 进求值面（本会话求值冻结），输出如实标注
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
  // 查重读磁盘现状而非会话冻结的 configRules：本会话内已升格的也算
  const existingIndex = findPromotedRuleIndex(loadGrantConfig(ctx.root), grantId);
  if (existingIndex !== -1) {
    throw new GrantAlreadyPromotedError(
      `grant ${grantId} 已升格为 config#${existingIndex}，不重复固化（用 /grants 查看）`
    );
  }
  const promotedAt = Date.now();
  appendGrantConfigRule(ctx.root, {
    tool: grant.tool,
    ...scopeFields(grant),
    promotedFrom: {
      grantId: grant.grantId,
      sessionId: ctx.sessionId,
      firstCall: grant.firstCall,
      promotedAt,
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
    const index = Number(match[1]);
    const removed = removeGrantConfigRule(ctx.root, index);
    ctx.write(
      `已移除固化规则 config#${match[1]}（${removed.tool}，出处 grant ${shortId(removed.promotedFrom.grantId)}）：` +
        "求值面会话内冻结，下次会话启动起不再生效\n"
    );
    return;
  }
  throw new Error(`无法撤销：${id}（会话 grant 用 grant_ 前缀完整 id；配置规则用 config#序号）`);
}
