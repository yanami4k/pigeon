// pigeon migrate-config（决策 325）：把旧布局迁到三层设置与 .pigeon/state/。由人发起，启动时只报错不自动迁移。
// 写成可扩展的步骤清单：每步先只读地给出要做的事与拦住的问题（plan），全部步骤都没有拦住的问题才逐步执行（apply）；
// 钩子一段加"verify.json → 打印改写为收尾钩子的示例并改名备份"。
// 五步：
//   ① 旧配置：7 个旧文件各成一节写入设置（permissions 写项目个人 .pigeon/settings.local.json，其余写项目共享
//      .pigeon/settings.json），去掉各文件自己的 version；web.json 里的 key 不写入，打印应设的环境变量名；旧文件挪出
//      仓库，进用户级本项目的备份目录（决策 341，迁移结束打印位置；仓库里不留备份）。目标文件已存在时合并进去：
//      同一节两边都有且内容不同即报错停下、不覆盖；
//   ② 程序状态：会话、输入历史、终端界面日志挪进 .pigeon/state/ 对应位置；
//   ③ 已删除功能的遗留（记忆一段，决策 330、331）：旧学到的记忆两处与其锁、补做复盘记录两处、复盘配置
//      memory-review.json、旧人写说明 .pigeon/memory/ 一律挪出仓库进用户级备份目录（仓库里不留备份）；
//      .pigeon/memory/ 另打印提示"把其中内容并入项目的 AGENTS.md"；
//   ④ 用户级旧偏好（决策 330）：~/.pigeon/preferences.md 改名为 ~/.pigeon/AGENTS.md，目标已存在即拦阻、不覆盖；
//   ⑤ worker 工作树：git worktree move 到 .pigeon/state/worktrees/。
// 有锁被存活进程占用（会话正开着、worker 正在运行）或工作树被锁定时拒绝并说明。可重复执行：没有要做的事即如实说明。
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../persistence/atomic-write.ts";
import { lockHeldByLiveProcess } from "../persistence/exclusive-lock.ts";
import {
  migrationBackupConflict,
  migrationBackupLocation,
  moveToMigrationBackup,
} from "../persistence/migration-backup.ts";
import { ensurePigeonGitignore } from "../persistence/settings.ts";
import { canonicalJson } from "../state/hashing.ts";
import {
  LEGACY_CONFIG_FILES,
  LEGACY_STATE_ENTRIES,
  LOCAL_SETTINGS_FILE,
  legacyConfigPath,
  legacyStatePath,
  pigeonRel,
  projectLocalSettingsPath,
  projectPigeonDir,
  projectSettingsPath,
  SETTINGS_FILE,
  STATE_DIR,
  sessionsDirOf,
  userAgentsMdPath,
  userPreferencesPath,
  worktreesDirOf,
} from "../state/paths.ts";
import { type SettingsLayer, validateSettingsLayer } from "../state/settings.ts";
import { WEB_KEY_FIELDS } from "../state/web-config.ts";

export const MIGRATE_CONFIG_USAGE = "用法：pigeon migrate-config [--root <项目根>]";

export interface MigrationContext {
  root: string;
  // 用户主目录（迁移备份在其下；测试注入临时目录）
  homeDir: string;
  // 本次挪进备份目录的位置（迁移结束据此打印备份目录）
  backups: string[];
}

export interface MigrationPlan {
  // 要做的事（给人看的一行一件）
  todo: string[];
  // 拦住整个迁移的问题
  blockers: string[];
}

export interface MigrationStep {
  id: string;
  title: string;
  plan(ctx: MigrationContext): MigrationPlan;
  // 执行；返回给人看的结果行
  apply(ctx: MigrationContext): string[];
}

export class MigrationError extends Error {}

// ---- ① 旧配置 ----

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 节写进哪一层：放权写项目个人（/grants save 的落点），其余写项目共享
function targetLayerOf(section: string): Exclude<SettingsLayer, "user"> {
  return section === "permissions" ? "local" : "project";
}

function targetPathOf(root: string, layer: Exclude<SettingsLayer, "user">): string {
  return layer === "local" ? projectLocalSettingsPath(root) : projectSettingsPath(root);
}

function targetLabelOf(layer: Exclude<SettingsLayer, "user">): string {
  return pigeonRel(layer === "local" ? LOCAL_SETTINGS_FILE : SETTINGS_FILE);
}

interface ConvertedConfig {
  file: string;
  section: string;
  layer: Exclude<SettingsLayer, "user">;
  content: Record<string, unknown>;
  // web.json 里去掉的 key 应设的环境变量
  keyEnvs: string[];
}

// 读一个旧文件并转成一节：去掉 version；web 去掉 key
function convertLegacyConfig(root: string, file: string, section: string): ConvertedConfig {
  const source = legacyConfigPath(root, file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new MigrationError(
      `${pigeonRel(file)} 不是合法 JSON，无法迁移：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isPlainObject(raw)) {
    throw new MigrationError(`${pigeonRel(file)} 顶层须为对象，无法迁移`);
  }
  const { version, ...content } = raw;
  if (version !== undefined && version !== 1) {
    throw new MigrationError(
      `${pigeonRel(file)} 的 version 不是 1（${String(version)}），无法迁移`
    );
  }
  const keyEnvs: string[] = [];
  if (section === "web" && isPlainObject(content.search)) {
    const search = { ...content.search };
    for (const { backend, env } of WEB_KEY_FIELDS) {
      const backendSection = search[backend];
      if (isPlainObject(backendSection) && Object.hasOwn(backendSection, "apiKey")) {
        const { apiKey: _dropped, ...rest } = backendSection;
        search[backend] = rest;
        keyEnvs.push(env);
      }
    }
    content.search = search;
  }
  return { file, section, layer: targetLayerOf(section), content, keyEnvs };
}

function readTarget(file: string, label: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new MigrationError(
      `${label} 不是合法 JSON，无法合并：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isPlainObject(raw)) {
    throw new MigrationError(`${label} 顶层须为对象，无法合并`);
  }
  return raw;
}

// 算出两层目标文件迁移后的内容；冲突与校验问题进 blockers
function plannedConfigs(
  root: string,
  homeDir: string
): {
  converted: ConvertedConfig[];
  targets: Map<Exclude<SettingsLayer, "user">, Record<string, unknown>>;
  blockers: string[];
} {
  const converted: ConvertedConfig[] = [];
  const blockers: string[] = [];
  for (const legacy of LEGACY_CONFIG_FILES) {
    if (!existsSync(legacyConfigPath(root, legacy.file))) continue;
    const occupied = migrationBackupConflict(root, legacy.file, homeDir);
    if (occupied !== undefined) {
      blockers.push(occupied);
      continue;
    }
    try {
      converted.push(convertLegacyConfig(root, legacy.file, legacy.section));
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  const targets = new Map<Exclude<SettingsLayer, "user">, Record<string, unknown>>();
  for (const item of converted) {
    const label = targetLabelOf(item.layer);
    let target = targets.get(item.layer);
    if (target === undefined) {
      try {
        target = { ...readTarget(targetPathOf(root, item.layer), label) };
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      targets.set(item.layer, target);
    }
    const existing = target[item.section];
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(item.content)) {
      blockers.push(
        `${label} 已有 ${item.section} 一节且与 ${pigeonRel(item.file)} 的内容不同：不覆盖，请手工合并后再运行`
      );
      continue;
    }
    target[item.section] = item.content;
  }
  for (const [layer, target] of targets) {
    const checked = validateSettingsLayer(target, { layer, file: targetLabelOf(layer) });
    if ("problems" in checked) {
      blockers.push(...checked.problems.map((problem) => `迁移后的内容校验不过：${problem}`));
    }
  }
  return { converted, targets, blockers };
}

export const legacyConfigStep: MigrationStep = {
  id: "legacy-config",
  title: "旧配置文件并入设置",
  plan(ctx) {
    const { converted, blockers } = plannedConfigs(ctx.root, ctx.homeDir);
    return {
      todo: converted.map(
        (item) =>
          `${pigeonRel(item.file)} → ${targetLabelOf(item.layer)} 的 ${item.section} 一节（原文件挪进备份目录）`
      ),
      blockers,
    };
  },
  apply(ctx) {
    const { converted, targets, blockers } = plannedConfigs(ctx.root, ctx.homeDir);
    if (blockers.length > 0) {
      throw new MigrationError(blockers.join("\n"));
    }
    const lines: string[] = [];
    for (const [layer, target] of targets) {
      const file = targetPathOf(ctx.root, layer);
      mkdirSync(path.dirname(file), { recursive: true });
      if (layer === "local") ensurePigeonGitignore(ctx.root, (line) => lines.push(line));
      writeFileAtomic(file, `${JSON.stringify(target, null, 2)}\n`);
    }
    for (const item of converted) {
      const source = legacyConfigPath(ctx.root, item.file);
      ctx.backups.push(moveToMigrationBackup(ctx.root, source, item.file, ctx.homeDir));
      lines.push(
        `已迁移 ${pigeonRel(item.file)} → ${targetLabelOf(item.layer)} 的 ${item.section} 一节；原文件已挪进备份目录`
      );
      for (const env of item.keyEnvs) {
        lines.push(`  ${pigeonRel(item.file)} 里的 key 没有写入设置：请改设环境变量 ${env}`);
      }
    }
    return lines;
  },
};

// ---- ② 程序状态（worker 工作树除外）----

// 旧位置下被存活进程占用的锁（会话锁、学到的记忆的锁、补做复盘的锁等）
function liveLocksUnder(target: string): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(current);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) {
        visit(path.join(current, name));
      }
      return;
    }
    if (current.endsWith(".lock")) {
      const holder = lockHeldByLiveProcess(current);
      if (holder !== undefined) {
        found.push(`${current}（pid ${holder.pid}）`);
      }
    }
  };
  visit(target);
  return found;
}

const MOVED_STATE = LEGACY_STATE_ENTRIES.filter((entry) => entry.name !== "worktrees");

export const legacyStateStep: MigrationStep = {
  id: "legacy-state",
  title: `旧位置的程序状态移入 ${pigeonRel(STATE_DIR)}`,
  plan(ctx) {
    const todo: string[] = [];
    const blockers: string[] = [];
    for (const entry of MOVED_STATE) {
      const source = legacyStatePath(ctx.root, entry.name);
      if (!existsSync(source)) continue;
      const target = entry.target(ctx.root);
      if (existsSync(target)) {
        blockers.push(
          `${pigeonRel(entry.name)} 与新位置 ${path.relative(ctx.root, target)} 都存在：不覆盖，请手工合并后再运行`
        );
        continue;
      }
      for (const lock of liveLocksUnder(source)) {
        blockers.push(
          `锁正被占用（有 Pigeon 会话或 worker 正在运行）：${lock}；请先结束它们再迁移`
        );
      }
      todo.push(`${pigeonRel(entry.name)} → ${path.relative(ctx.root, target)}`);
    }
    return { todo, blockers };
  },
  apply(ctx) {
    const lines: string[] = [];
    for (const entry of MOVED_STATE) {
      const source = legacyStatePath(ctx.root, entry.name);
      if (!existsSync(source)) continue;
      const target = entry.target(ctx.root);
      mkdirSync(path.dirname(target), { recursive: true });
      ensurePigeonGitignore(ctx.root, (line) => lines.push(line));
      renameSync(source, target);
      lines.push(`已移动 ${pigeonRel(entry.name)} → ${path.relative(ctx.root, target)}`);
    }
    return lines;
  },
};

// ---- ④ 已删除功能的遗留（记忆一段，决策 330、331、341）----

// 挪出仓库进用户级备份的遗留（相对 .pigeon 的源 → 备份目录里的名字；同名两处各自分开）
const OBSOLETE_MEMORY_ITEMS: readonly { source: string; backup: string }[] = [
  { source: "learned", backup: "learned" },
  { source: "learned.lock", backup: "learned.lock" },
  { source: path.join("state", "learned"), backup: path.join("state", "learned") },
  { source: path.join("state", "learned.lock"), backup: path.join("state", "learned.lock") },
  { source: "review-backfill", backup: "review-backfill" },
  { source: path.join("state", "review-backfill"), backup: path.join("state", "review-backfill") },
  { source: "memory-review.json", backup: "memory-review.json" },
  { source: "memory", backup: "memory" },
];

export const obsoleteMemoryStep: MigrationStep = {
  id: "obsolete-memory",
  title: "已删除功能的遗留挪出仓库",
  plan(ctx) {
    const todo: string[] = [];
    const blockers: string[] = [];
    for (const item of OBSOLETE_MEMORY_ITEMS) {
      if (!existsSync(legacyStatePath(ctx.root, item.source))) continue;
      const conflict = migrationBackupConflict(ctx.root, item.backup, ctx.homeDir);
      if (conflict !== undefined) {
        blockers.push(conflict);
        continue;
      }
      todo.push(`${pigeonRel(item.source)} → 备份目录（${item.backup}）`);
    }
    return { todo, blockers };
  },
  apply(ctx) {
    const lines: string[] = [];
    for (const item of OBSOLETE_MEMORY_ITEMS) {
      const source = legacyStatePath(ctx.root, item.source);
      if (!existsSync(source)) continue;
      ctx.backups.push(moveToMigrationBackup(ctx.root, source, item.backup, ctx.homeDir));
      lines.push(`已挪走 ${pigeonRel(item.source)}（进备份目录 ${item.backup}）`);
      if (item.source === "memory") {
        lines.push("  把其中内容并入项目的 AGENTS.md");
      }
    }
    return lines;
  },
};

// ---- ⑤ 用户级旧偏好改名（决策 330）----

export const userPreferencesStep: MigrationStep = {
  id: "user-preferences",
  title: "用户级旧偏好改名为 AGENTS.md",
  plan(ctx) {
    const source = userPreferencesPath(ctx.homeDir);
    if (!existsSync(source)) return { todo: [], blockers: [] };
    const target = userAgentsMdPath(ctx.homeDir);
    if (existsSync(target)) {
      return {
        todo: [],
        blockers: [`${target} 已存在，不覆盖；请手工把 ${source} 的内容并入后再运行`],
      };
    }
    return { todo: [`${source} → ${target}`], blockers: [] };
  },
  apply(ctx) {
    const source = userPreferencesPath(ctx.homeDir);
    if (!existsSync(source)) return [];
    const target = userAgentsMdPath(ctx.homeDir);
    renameSync(source, target);
    return [`已改名 ${source} → ${target}`];
  },
};

interface WorktreeInfo {
  path: string;
  locked: boolean;
}

function gitWorktrees(root: string): WorktreeInfo[] {
  let out: string;
  try {
    out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return [];
  }
  const list: WorktreeInfo[] = [];
  for (const block of out.split(/\n\n/)) {
    const lines = block.split("\n");
    const head = lines.find((line) => line.startsWith("worktree "));
    if (head === undefined) continue;
    list.push({
      path: head.slice("worktree ".length),
      locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
    });
  }
  return list;
}

function realOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function legacyWorktreeDirs(root: string): string[] {
  const dir = legacyStatePath(root, "worktrees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

export const legacyWorktreesStep: MigrationStep = {
  id: "legacy-worktrees",
  title: `worker 工作树移入 ${pigeonRel(STATE_DIR, "worktrees")}`,
  plan(ctx) {
    const legacyDir = legacyStatePath(ctx.root, "worktrees");
    if (!existsSync(legacyDir)) return { todo: [], blockers: [] };
    const todo: string[] = [];
    const blockers: string[] = [];
    const known = new Map(gitWorktrees(ctx.root).map((tree) => [realOrSelf(tree.path), tree]));
    for (const dir of legacyWorktreeDirs(ctx.root)) {
      const target = path.join(worktreesDirOf(ctx.root), path.basename(dir));
      if (existsSync(target)) {
        blockers.push(`工作树新位置已存在：${path.relative(ctx.root, target)}；不覆盖`);
        continue;
      }
      const tree = known.get(realOrSelf(dir));
      if (tree?.locked === true) {
        blockers.push(`工作树被锁定（git worktree lock）：${dir}；请先解锁或结束使用它的 worker`);
        continue;
      }
      todo.push(
        `${path.relative(ctx.root, dir)} → ${path.relative(ctx.root, target)}（${tree !== undefined ? "git worktree move" : "不是登记的工作树，直接挪目录"}）`
      );
    }
    // worker 正在运行：它的会话锁在旧会话目录或新会话目录里
    for (const lock of [
      ...liveLocksUnder(legacyStatePath(ctx.root, "sessions")),
      ...liveLocksUnder(sessionsDirOf(ctx.root)),
    ]) {
      blockers.push(
        `有 Pigeon 会话或 worker 正在运行（锁被占用：${lock}）；请先结束它们再迁移工作树`
      );
    }
    if (todo.length === 0 && blockers.length === 0) {
      todo.push(`删除空目录 ${pigeonRel("worktrees")}`);
    }
    return { todo, blockers };
  },
  apply(ctx) {
    const lines: string[] = [];
    const known = new Map(gitWorktrees(ctx.root).map((tree) => [realOrSelf(tree.path), tree]));
    for (const dir of legacyWorktreeDirs(ctx.root)) {
      const target = path.join(worktreesDirOf(ctx.root), path.basename(dir));
      mkdirSync(path.dirname(target), { recursive: true });
      ensurePigeonGitignore(ctx.root, (line) => lines.push(line));
      if (known.has(realOrSelf(dir))) {
        execFileSync("git", ["worktree", "move", dir, target], {
          cwd: ctx.root,
          stdio: ["ignore", "pipe", "pipe"],
        });
        lines.push(
          `已 git worktree move ${path.relative(ctx.root, dir)} → ${path.relative(ctx.root, target)}`
        );
      } else {
        renameSync(dir, target);
        lines.push(`已移动 ${path.relative(ctx.root, dir)} → ${path.relative(ctx.root, target)}`);
      }
    }
    const legacyDir = legacyStatePath(ctx.root, "worktrees");
    if (existsSync(legacyDir) && readdirSync(legacyDir).length === 0) {
      rmdirSync(legacyDir);
      lines.push(`已删除空目录 ${pigeonRel("worktrees")}`);
    }
    return lines;
  },
};

// 步骤清单：先检查后执行（全部步骤的 plan 都没有拦住的问题才逐步 apply），以后各段在此追加
export const MIGRATION_STEPS: readonly MigrationStep[] = [
  legacyConfigStep,
  legacyStateStep,
  obsoleteMemoryStep,
  userPreferencesStep,
  legacyWorktreesStep,
];

export interface MigrateConfigResult {
  changed: boolean;
  lines: string[];
}

// 先逐步检查，全部没有拦住的问题才逐步执行
export function runMigrateConfig(
  root: string,
  options: { homeDir?: string; steps?: readonly MigrationStep[] } = {}
): MigrateConfigResult {
  const steps = options.steps ?? MIGRATION_STEPS;
  const ctx: MigrationContext = { root, homeDir: options.homeDir ?? homedir(), backups: [] };
  const plans = steps.map((step) => ({ step, plan: step.plan(ctx) }));
  const blockers = plans.flatMap(({ step, plan }) =>
    plan.blockers.map((blocker) => `[${step.title}] ${blocker}`)
  );
  if (blockers.length > 0) {
    throw new MigrationError(`迁移没有进行，以下问题须先处理：\n${blockers.join("\n")}`);
  }
  const pending = plans.filter(({ plan }) => plan.todo.length > 0);
  if (pending.length === 0) {
    return { changed: false, lines: ["没有要迁移的内容：配置与程序状态已是新布局"] };
  }
  const lines: string[] = [];
  // 每次迁移都确保 .pigeon/.gitignore（程序状态与个人设置不被提交；只迁项目共享层的文件时也一样）
  if (existsSync(projectPigeonDir(root))) {
    ensurePigeonGitignore(root, (line) => lines.push(line));
  }
  for (const { step } of pending) {
    lines.push(`${step.title}：`);
    lines.push(...step.apply(ctx).map((line) => `  ${line}`));
  }
  if (ctx.backups.length > 0) {
    lines.push(`迁移挪走的旧文件原文备份在 ${migrationBackupLocation(root, ctx.homeDir)}`);
  }
  return { changed: true, lines };
}
