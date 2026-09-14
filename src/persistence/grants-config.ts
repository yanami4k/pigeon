// 固化 grant 配置文件读写（M4 S6，D6 + 收口决策 ②）：.pigeon/grants.json 整文件重写；
// 畸形文件 fail-closed 响亮失败；同 grantId 重复升格拒绝。正规写入方只有 /grants save 与
// /revoke config#N（约束 3：agent / 模型 / 后台流程无写配置文件的代码路径）。
// M5.5 S1（决策 040）：写入改为临时文件 fsync 后改名原子替换，写到一半崩溃不留半截文件。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import {
  type ConfigGrantRule,
  GRANTS_CONFIG_VERSION,
  GrantsConfigFileSchema,
} from "../state/grants.ts";
import type { GrantId } from "../state/ids.ts";
import { type AtomicWriteIo, writeFileAtomic } from "./atomic-write.ts";

export class GrantsConfigError extends Error {}
// 升格去重（M4 收口决策 ②）：同一会话 grant 只允许升格一次——grantId 是固化规则的稳定身份
// （决策 ①），两条同 grantId 的规则会让账本回指失去唯一性
export class GrantAlreadyPromotedError extends GrantsConfigError {}

export interface GrantConfigWriteOptions {
  // 写盘注入点（测试模拟写到一半崩溃）；缺省为同步写
  io?: AtomicWriteIo;
}

// 查找已由某 grant 升格而来的规则下标；-1 = 尚未升格
export function findPromotedRuleIndex(rules: readonly ConfigGrantRule[], grantId: GrantId): number {
  return rules.findIndex((rule) => rule.promotedFrom.grantId === grantId);
}

export function grantsConfigPath(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "grants.json");
}

// 会话启动时装载（F）：文件缺失 = 无固化规则（合法全新项目）；存在但畸形 → 响亮失败
// 并列出全部问题（治理配置 fail-closed，绝不静默忽略——错误配置意味着授权语义不明）
export function loadGrantConfig(governanceRoot: string): ConfigGrantRule[] {
  const path = grantsConfigPath(governanceRoot);
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
// 原子替换且 fsync——固化是权限扩大动作，断电不得丢。既有文件畸形在此响亮失败（不覆盖人的错误配置）；
// 同 grantId 已存在则拒绝（决策 ②），拒绝时文件不改写
export function appendGrantConfigRule(
  governanceRoot: string,
  rule: ConfigGrantRule,
  options: GrantConfigWriteOptions = {}
): void {
  const path = grantsConfigPath(governanceRoot);
  const existing = loadGrantConfig(governanceRoot);
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
  writeFileAtomic(path, `${JSON.stringify(doc, null, 2)}\n`, options.io);
}

// 配置规则移除（/revoke config#N）：整文件原子替换。配置规则在会话启动时载入并冻结——
// 移除只影响磁盘，当前会话的求值面不变（/grants 输出如实标注「下次会话生效」）。
// 返回被移除的规则：调用方据其 promotedFrom.grantId 落 grant.config-removed 留痕（决策 ①）
export function removeGrantConfigRule(
  governanceRoot: string,
  index: number,
  options: GrantConfigWriteOptions = {}
): ConfigGrantRule {
  const path = grantsConfigPath(governanceRoot);
  const existing = loadGrantConfig(governanceRoot);
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
  writeFileAtomic(path, `${JSON.stringify(doc, null, 2)}\n`, options.io);
  return removed;
}
