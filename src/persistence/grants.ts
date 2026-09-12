// Grant 体系（M4 S6，决策 3 + D6）：会话 grant 存储、固化配置（.pigeon/grants.json）
// 与确定性匹配。排律由 adapter 求值顺序承载（deny 清单 → 会话 grant → 配置 grant →
// yolo → read 自动 → prompt）；本模块只负责匹配语义与持久化：
//   - 匹配确定性（约束 5）：工具名 + 可选 pathPrefix 目录包含（paths.ts realpath 机制），
//     无自由文本模式；非路径参数或解析失败 → 不匹配，回落人工审批（授权不猜）
//   - 固化写入方唯一（约束 3）：appendGrantConfigRule 只被 /grants save（人显式触发）调用，
//     agent / 模型 / 后台流程无写配置文件的代码路径
//   - 会话 grant 是治理面运行时状态：不进 InjectionSnapshot（约束 4），运行态以本存储
//     为准，持久态以 grant.created / grant.revoked 事件族为准（决策 2 不双写）
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  asGrantId,
  type GrantId,
  GrantIdSchema,
  newGrantId,
  type RunId,
  SessionIdSchema,
} from "../state/ids.ts";
import { isPathInsideDir } from "../tools/paths.ts";
import type { ActiveGrant, GrantCreatedInput, GrantRevokedInput } from "./event-log.ts";

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
function scopeMatches(
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

// ---- 固化配置（D6：项目级 .pigeon/grants.json，JSON + 版本化 typebox schema） ----

export const GRANTS_CONFIG_VERSION = 1;

// 升格出处（promotedFrom）：哪次会话、哪次动作、首次批准的调用——团队共享工具权限
// 是未来的显式决策，本设计先把每条固化规则的出处结构化留证
export const PromotedFromSchema = Type.Object({
  grantId: GrantIdSchema,
  sessionId: SessionIdSchema,
  firstCall: Type.Object({
    toolCallId: Type.String({ minLength: 1 }),
    args: Type.Unknown(),
  }),
  promotedAt: Type.Integer({ minimum: 0 }),
});
export type PromotedFrom = Static<typeof PromotedFromSchema>;

export const ConfigGrantRuleSchema = Type.Object({
  tool: Type.String({ minLength: 1 }),
  pathPrefix: Type.Optional(Type.String({ minLength: 1 })),
  promotedFrom: PromotedFromSchema,
});
export type ConfigGrantRule = Static<typeof ConfigGrantRuleSchema>;

export const GrantsConfigFileSchema = Type.Object({
  version: Type.Literal(GRANTS_CONFIG_VERSION),
  grants: Type.Array(ConfigGrantRuleSchema),
});

export class GrantsConfigError extends Error {}
// 升格去重（M4 收口决策 ②）：同一会话 grant 只允许升格一次——grantId 是固化规则的稳定身份
// （决策 ①），两条同 grantId 的规则会让账本回指失去唯一性
export class GrantAlreadyPromotedError extends GrantsConfigError {}

// 查找已由某 grant 升格而来的规则下标；-1 = 尚未升格
export function findPromotedRuleIndex(rules: readonly ConfigGrantRule[], grantId: GrantId): number {
  return rules.findIndex((rule) => rule.promotedFrom.grantId === grantId);
}

export function grantsConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".pigeon", "grants.json");
}

// 会话启动时装载（F）：文件缺失 = 无固化规则（合法全新项目）；存在但畸形 → 响亮失败
// 并列出全部问题（治理配置 fail-closed，绝不静默忽略——错误配置意味着授权语义不明）
export function loadGrantConfig(workspaceRoot: string): ConfigGrantRule[] {
  const path = grantsConfigPath(workspaceRoot);
  if (!existsSync(path)) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new GrantsConfigError(
      `grants 配置不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(GrantsConfigFileSchema, raw)) {
    const problems = [...Value.Errors(GrantsConfigFileSchema, raw)]
      .map((failure) => {
        const where = "path" in failure ? failure.path : "/";
        return `${where === "" ? "/" : where}：${failure.message}`;
      })
      .join("；");
    throw new GrantsConfigError(`grants 配置校验失败：${path}：${problems}`);
  }
  return (raw as { grants: ConfigGrantRule[] }).grants;
}

// 升格写入（/grants save 的唯一正规写入方，约束 3）：整文件重写（人可读，D6），
// 写后 fsync——固化是权限扩大动作，断电不得丢。既有文件畸形在此响亮失败（不覆盖人的错误配置）；
// 同 grantId 已存在则拒绝（决策 ②），拒绝时文件不改写
export function appendGrantConfigRule(workspaceRoot: string, rule: ConfigGrantRule): void {
  const path = grantsConfigPath(workspaceRoot);
  const existing = loadGrantConfig(workspaceRoot);
  const duplicate = findPromotedRuleIndex(existing, rule.promotedFrom.grantId);
  if (duplicate !== -1) {
    throw new GrantAlreadyPromotedError(
      `grant ${rule.promotedFrom.grantId} 已升格为 config#${duplicate}，不重复固化（用 /grants 查看）`
    );
  }
  const doc = Value.Parse(GrantsConfigFileSchema, {
    version: GRANTS_CONFIG_VERSION,
    grants: [...existing, rule],
  });
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  // Windows 下只读句柄 fsync 会 EPERM，以读写方式打开刷脏页
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// 配置规则移除（/revoke config#N）：整文件重写。配置规则在会话启动时载入并冻结——
// 移除只影响磁盘，当前会话的求值面不变（/grants 输出如实标注「下次会话生效」）。
// 返回被移除的规则：调用方据其 promotedFrom.grantId 落 grant.config-removed 留痕（决策 ①）
export function removeGrantConfigRule(workspaceRoot: string, index: number): ConfigGrantRule {
  const path = grantsConfigPath(workspaceRoot);
  const existing = loadGrantConfig(workspaceRoot);
  if (index < 0 || index >= existing.length) {
    throw new GrantsConfigError(`固化规则不存在：config#${index}（共 ${existing.length} 条）`);
  }
  const removed = existing[index];
  if (removed === undefined) {
    // noUncheckedIndexedAccess：上界已检，此处仅为收窄
    throw new GrantsConfigError(`固化规则不存在：config#${index + 1}`);
  }
  existing.splice(index, 1);
  const doc = Value.Parse(GrantsConfigFileSchema, {
    version: GRANTS_CONFIG_VERSION,
    grants: existing,
  });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return removed;
}

// ---- 会话 grant 存储（决策 3b：运行态权威；持久态 = grant 事件族，决策 2 不双写） ----

// 会话 grant 的运行态视图：命中次数是进程内派生计数（/grants 展示面，不落盘）
export interface SessionGrantView extends ActiveGrant {
  hitCount: number;
}

export class GrantNotFoundError extends Error {}

// grant 事件落盘面（JsonlEventLog 的写入子集；返回值无关——落盘副作用才是契约）
type GrantEventSink = {
  appendGrantCreated(input: GrantCreatedInput): unknown;
  appendGrantRevoked(input: GrantRevokedInput): unknown;
};

export interface SessionGrantStoreOptions {
  // 目录限定匹配的 realpath 解析根
  workspaceRoot: string;
  // grant.created / grant.revoked 落盘点；缺省 = 纯内存（不留持久痕迹）
  eventLog?: GrantEventSink;
  // 冷恢复种子（决策 3b）：materializeSession(...).grants 的还原——崩溃后会话
  // grant 静默继续有效，恢复屏不加确认环节（用户裁决：重复确认是纯摩擦）
  restored?: readonly ActiveGrant[] | undefined;
}

export class SessionGrantStore {
  readonly #workspaceRoot: string;
  readonly #eventLog: GrantEventSink | undefined;
  readonly #grants = new Map<GrantId, SessionGrantView>();

  constructor(options: SessionGrantStoreOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#eventLog = options.eventLog;
    for (const grant of options.restored ?? []) {
      this.#grants.set(grant.grantId, { ...grant, hitCount: 0 });
    }
  }

  // 审批提示 [a]/[d] 键触发：先落 grant.created 事件再入运行态——事件写盘失败
  // 则 grant 不生效（fail-closed：免审授权必须留证后才存在）
  create(input: {
    tool: string;
    pathPrefix?: string;
    firstCall: { toolCallId: string; args: unknown };
    runId?: RunId;
  }): SessionGrantView {
    const grantId = newGrantId();
    const createdAt = Date.now();
    this.#eventLog?.appendGrantCreated({
      grantId,
      tool: input.tool,
      ...(input.pathPrefix !== undefined ? { pathPrefix: input.pathPrefix } : {}),
      createdAt,
      firstCall: input.firstCall,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    });
    const grant: SessionGrantView = {
      grantId,
      tool: input.tool,
      ...(input.pathPrefix !== undefined ? { pathPrefix: input.pathPrefix } : {}),
      createdAt,
      firstCall: input.firstCall,
      hitCount: 0,
    };
    this.#grants.set(grantId, grant);
    return grant;
  }

  // /revoke <id>：先落 grant.revoked 事件再从运行态删除——撤销立即生效（免审停止），
  // 持久痕迹 append-only；未知 id 响亮报错
  revoke(grantId: GrantId, runId?: RunId): void {
    if (!this.#grants.has(grantId)) {
      throw new GrantNotFoundError(`grant 不存在或已撤销：${grantId}`);
    }
    this.#eventLog?.appendGrantRevoked({
      grantId,
      revokedAt: Date.now(),
      ...(runId !== undefined ? { runId } : {}),
    });
    this.#grants.delete(grantId);
  }

  // 纯求值（无副作用）：命中计数由 noteEffectiveHit 在放行实际生效后单独记——
  // deny 压过 grant 时不计命中（审计口径：命中 = 实际免审放行）
  match(toolName: string, args: unknown): GrantMatchOutcome | null {
    for (const grant of this.#grants.values()) {
      if (scopeMatches(this.#workspaceRoot, grant.tool, grant.pathPrefix, toolName, args)) {
        return { source: "session-grant", refId: grant.grantId };
      }
    }
    return null;
  }

  // 放行生效后的命中留痕（adapter 在 decision.grant 成立时调用）
  noteEffectiveHit(outcome: GrantMatchOutcome): void {
    if (outcome.source !== "session-grant") {
      return;
    }
    const grant = this.#grants.get(asGrantId(outcome.refId));
    if (grant !== undefined) {
      grant.hitCount += 1;
    }
  }

  // 生效 grant 快照（/grants 展示）
  list(): SessionGrantView[] {
    return [...this.#grants.values()];
  }

  get(grantId: GrantId): SessionGrantView | undefined {
    return this.#grants.get(grantId);
  }
}
