// 固化 grant 配置读写（M4 S6，D6 + 收口决策 ②；决策 325 起写入项目个人设置的 permissions 一节，其余各节原样保留）：整文件重写；
// 畸形文件 fail-closed 响亮失败；同 grantId 重复升格拒绝。正规写入方只有 /grants save 与
// /revoke config#N（约束 3：agent / 模型 / 后台流程无写配置文件的代码路径）。
// M5.5 S1（决策 040）：写入改为临时文件 fsync 后改名原子替换，写到一半崩溃不留半截文件。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConfigGrantRule } from "../state/grants.ts";
import type { GrantId } from "../state/ids.ts";
import {
  LOCAL_SETTINGS_FILE,
  localSettingsLockPathOf,
  pigeonRel,
  projectLocalSettingsPath,
} from "../state/paths.ts";
import { describeSource, type SettingsSource, validateSettingsLayer } from "../state/settings.ts";
import { type AtomicWriteIo, writeFileAtomic } from "./atomic-write.ts";
import { acquireExclusiveLock } from "./exclusive-lock.ts";
import { ensurePigeonGitignore } from "./settings.ts";

export class GrantsConfigError extends Error {}
// 升格去重（M4 收口决策 ②）：同一会话 grant 只允许升格一次——grantId 是固化规则的稳定身份
// （决策 ①），两条同 grantId 的规则会让账本回指失去唯一性
export class GrantAlreadyPromotedError extends GrantsConfigError {}

export interface GrantConfigWriteOptions {
  // 写盘注入点（测试模拟写到一半崩溃）；缺省为同步写
  io?: AtomicWriteIo;
  // .pigeon/.gitignore 缺行时的提示出口（缺省标准错误输出）
  notice?: (line: string) => void;
}

// 查找已由某 grant 升格而来的规则下标；-1 = 尚未升格
export function findPromotedRuleIndex(rules: readonly ConfigGrantRule[], grantId: GrantId): number {
  return rules.findIndex((rule) => rule.promotedFrom.grantId === grantId);
}

// 写入的落点：项目个人设置 .pigeon/settings.local.json 的 permissions 一节（决策 325）
export function grantsConfigPath(governanceRoot: string): string {
  return projectLocalSettingsPath(governanceRoot);
}

const LOCAL_SOURCE: SettingsSource = { layer: "local", file: pigeonRel(LOCAL_SETTINGS_FILE) };

// 放权配置的写入锁（并发缺口修复）：追加与移除都是"读出整份、改数组、原子写回"。
// 原子替换只保证读到的文件不撕裂，挡不住丢更新——两个窗口同时固化时，后写的那份基于旧内容算出，
// 会把先写的那条整份覆盖掉。写侧统一在这把锁里做，撞上即明确拒绝（不排队，与本项目其他锁同口径）。
// 读侧（loadGrantConfig）不取锁：原子替换保证它读到的要么是完整的旧一份、要么是完整的新一份
export function grantsConfigLockPath(governanceRoot: string): string {
  return localSettingsLockPathOf(governanceRoot);
}

const CONTENDED = "放权配置正被另一个窗口写入：等它收尾后重试（两边同时写会丢掉先写的那一条）";

// 读出个人设置文件的原样内容（校验通过才返回；缺失为空对象）
function readLocalSettingsRaw(governanceRoot: string): Record<string, unknown> {
  const path = grantsConfigPath(governanceRoot);
  if (!existsSync(path)) {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new GrantsConfigError(
      `设置文件 ${describeSource(LOCAL_SOURCE)}不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const checked = validateSettingsLayer(raw, LOCAL_SOURCE);
  if ("problems" in checked) {
    throw new GrantsConfigError(`${checked.problems.join("；")}（${path}）`);
  }
  return raw as Record<string, unknown>;
}

// 写侧统一入口：取锁 → 读出当下这一份 → 交给 mutate 算出新的放权规则 → 原子写回（文件里其余各节原样保留）→ 放锁。
// 读与写必须在同一把锁里，否则"基于旧内容算出的新一份"照样会覆盖别人刚写的那条
function withGrantsConfigLock<T>(
  governanceRoot: string,
  mutate: (existing: ConfigGrantRule[]) => { grants: ConfigGrantRule[]; result: T },
  options: GrantConfigWriteOptions
): T {
  const path = grantsConfigPath(governanceRoot);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    ensurePigeonGitignore(governanceRoot, options.notice);
  }
  const release = acquireExclusiveLock(grantsConfigLockPath(governanceRoot), CONTENDED);
  try {
    const raw = readLocalSettingsRaw(governanceRoot);
    const permissions = (raw.permissions ?? {}) as { grants?: ConfigGrantRule[] };
    const { grants, result } = mutate([...(permissions.grants ?? [])]);
    const next = { ...raw, permissions: { ...permissions, grants } };
    const checked = validateSettingsLayer(next, LOCAL_SOURCE);
    if ("problems" in checked) {
      throw new GrantsConfigError(checked.problems.join("；"));
    }
    writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, options.io);
    return result;
  } finally {
    release();
  }
}

// 读项目个人一层的放权规则（/grants save 查重与 /revoke 的序号以它为准）：文件缺失 = 无规则；
// 存在但畸形 → 响亮失败并列出全部问题（治理配置 fail-closed，绝不静默忽略——错误配置意味着授权语义不明）
export function loadGrantConfig(governanceRoot: string): ConfigGrantRule[] {
  const raw = readLocalSettingsRaw(governanceRoot);
  return [...(((raw.permissions ?? {}) as { grants?: ConfigGrantRule[] }).grants ?? [])];
}

// 升格写入（/grants save 的唯一正规写入方，约束 3）：整文件重写（人可读，D6），
// 原子替换且 fsync——固化是权限扩大动作，断电不得丢。既有文件畸形在此响亮失败（不覆盖人的错误配置）；
// 同 grantId 已存在则拒绝（决策 ②），拒绝时文件不改写
export function appendGrantConfigRule(
  governanceRoot: string,
  rule: ConfigGrantRule,
  options: GrantConfigWriteOptions = {}
): void {
  withGrantsConfigLock(
    governanceRoot,
    (existing) => {
      // 去重检查也在锁里做：读出来的这一份就是即将被写回的基准
      const duplicate = findPromotedRuleIndex(existing, rule.promotedFrom.grantId);
      if (duplicate !== -1) {
        throw new GrantAlreadyPromotedError(
          `grant ${rule.promotedFrom.grantId} 已升格为 config#${duplicate}，不重复固化（用 /grants 查看）`
        );
      }
      return { grants: [...existing, rule], result: undefined };
    },
    options
  );
}

// 配置规则移除（/revoke config#N，序号是项目个人一层里的序号）：整文件原子替换。配置规则随设置快照载入（会话开始与
// /reload 重建时）——移除只影响磁盘，当前求值面到下次会话启动或 /reload 才变（/revoke 输出如实标注）。
// 返回被移除的规则：调用方据其工具与出处 grant 向人报告移除了哪一条
export function removeGrantConfigRule(
  governanceRoot: string,
  index: number,
  options: GrantConfigWriteOptions = {}
): ConfigGrantRule {
  return withGrantsConfigLock(
    governanceRoot,
    (existing) => {
      if (index < 0 || index >= existing.length) {
        throw new GrantsConfigError(`固化规则不存在：config#${index}（共 ${existing.length} 条）`);
      }
      const removed = existing[index];
      if (removed === undefined) {
        // noUncheckedIndexedAccess：上界已检，此处仅为收窄
        throw new GrantsConfigError(`固化规则不存在：config#${index + 1}`);
      }
      existing.splice(index, 1);
      return { grants: existing, result: removed };
    },
    options
  );
}
