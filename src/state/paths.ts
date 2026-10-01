// Pigeon 自己的目录与文件位置（决策 325）：项目的 .pigeon 目录、三层 settings 文件、程序状态目录 .pigeon/state/ 及其下各子目录、
// 用户级 ~/.pigeon 下的对应位置，全部在这里给出；其余源码一律经本模块取路径，不自拼 ".pigeon"（边界用例守住）。
// 纯路径计算，无 IO；用户主目录可注入（测试指到临时目录，不碰真实的 ~/.pigeon）。
// - 人写的内容留在原处：.pigeon/settings.json（可提交）、.pigeon/skills、.pigeon/memory、~/.pigeon/settings.json、
//   ~/.pigeon/skills、~/.pigeon/preferences.md，以及本段不并入的 .pigeon/verify.json 与 .pigeon/memory-review.json。
// - 程序写的状态在 .pigeon/state/（不提交）：会话、学到的记忆、worker 工作树、补做复盘记录、输入历史、终端界面日志；
//   用户级的程序状态（配置内容指纹）在 ~/.pigeon/state/。
// - 旧布局（迁移命令与启动检查用）：7 个旧配置文件与旧位置的程序状态。
import { homedir } from "node:os";
import path from "node:path";

// 目录名本身（只此一处字面量）
export const PIGEON_DIR = ".pigeon";
// 程序状态目录名（相对 .pigeon）
export const STATE_DIR = "state";
// 设置文件名
export const SETTINGS_FILE = "settings.json";
export const LOCAL_SETTINGS_FILE = "settings.local.json";

// 展示用的相对写法（报错、提示与系统提示里的路径说法；一律正斜杠）
export function pigeonRel(...segments: string[]): string {
  return [PIGEON_DIR, ...segments].join("/");
}

// 用户级目录的展示写法
export function userPigeonRel(...segments: string[]): string {
  return ["~", PIGEON_DIR, ...segments].join("/");
}

// ---- 项目级 ----

export function projectPigeonDir(root: string): string {
  return path.join(root, PIGEON_DIR);
}

export function projectSettingsPath(root: string): string {
  return path.join(root, PIGEON_DIR, SETTINGS_FILE);
}

export function projectLocalSettingsPath(root: string): string {
  return path.join(root, PIGEON_DIR, LOCAL_SETTINGS_FILE);
}

// .pigeon/.gitignore（程序第一次建状态目录或个人设置时写入）
export function projectPigeonGitignorePath(root: string): string {
  return path.join(root, PIGEON_DIR, ".gitignore");
}

// .pigeon/.gitignore 应有的两行
export const PIGEON_GITIGNORE_LINES: readonly string[] = [`${STATE_DIR}/`, LOCAL_SETTINGS_FILE];

export function projectStateDir(root: string): string {
  return path.join(root, PIGEON_DIR, STATE_DIR);
}

export function sessionsDirOf(root: string): string {
  return path.join(projectStateDir(root), "sessions");
}

export function learnedDirOf(root: string): string {
  return path.join(projectStateDir(root), "learned");
}

export function learnedLockPathOf(root: string): string {
  return path.join(projectStateDir(root), "learned.lock");
}

export function worktreesDirOf(root: string): string {
  return path.join(projectStateDir(root), "worktrees");
}

export function reviewBackfillDirOf(root: string): string {
  return path.join(projectStateDir(root), "review-backfill");
}

// 迁移备份（决策 325）：迁移命令挪走的旧文件一律放这里（在程序状态目录下，不进快照、不被提交；旧 web.json 里可能有 key）
export function migrationBackupDirOf(root: string): string {
  return path.join(projectStateDir(root), "migration-backup");
}

// 某个旧文件（相对 .pigeon 的名字）的备份位置
export function migrationBackupPathOf(root: string, name: string): string {
  return path.join(migrationBackupDirOf(root), `${name}.bak`);
}

export function promptHistoryPathOf(root: string): string {
  return path.join(projectStateDir(root), "tui-history.json");
}

// 终端界面日志所在目录（日志文件名由终端界面自定）
export function tuiLogDirOf(root: string): string {
  return path.join(projectStateDir(root), "logs");
}

// 人写内容（位置不变）
export function projectSkillsDir(root: string): string {
  return path.join(root, PIGEON_DIR, "skills");
}

export function projectMemoryDir(root: string): string {
  return path.join(root, PIGEON_DIR, "memory");
}

// 本段不并入、原样读取的两份（钩子一段与记忆一段各自删除）
export function verifyConfigPathOf(root: string): string {
  return path.join(root, PIGEON_DIR, "verify.json");
}

export function memoryReviewConfigPathOf(root: string): string {
  return path.join(root, PIGEON_DIR, "memory-review.json");
}

// 项目根的 .mcp.json（不在 .pigeon 下，格式不变）
export function dotMcpJsonPathOf(root: string): string {
  return path.join(root, ".mcp.json");
}

// 设置文件里放权一节的写入锁（/grants save 与 /revoke）
export function localSettingsLockPathOf(root: string): string {
  return `${projectLocalSettingsPath(root)}.lock`;
}

// 快照、checkpoint 与 worker 叠加排除的程序路径（相对仓库根，正斜杠）：只排除程序状态与个人设置；
// 可提交的 .pigeon/settings.json 与 .pigeon/skills 是项目内容，照常进快照
export const PROGRAM_OWNED_PATHS: readonly string[] = [
  pigeonRel(STATE_DIR),
  pigeonRel(LOCAL_SETTINGS_FILE),
];

export function isProgramOwnedPath(relativePosixPath: string): boolean {
  return PROGRAM_OWNED_PATHS.some(
    (owned) => relativePosixPath === owned || relativePosixPath.startsWith(`${owned}/`)
  );
}

// ---- 用户级 ----

export function userPigeonDir(homeDir: string = homedir()): string {
  return path.join(homeDir, PIGEON_DIR);
}

export function userSettingsPath(homeDir: string = homedir()): string {
  return path.join(homeDir, PIGEON_DIR, SETTINGS_FILE);
}

export function userStateDir(homeDir: string = homedir()): string {
  return path.join(homeDir, PIGEON_DIR, STATE_DIR);
}

// 会执行命令的配置的内容指纹记录（决策 326 ③）
export function configTrustPathOf(homeDir: string = homedir()): string {
  return path.join(userStateDir(homeDir), "config-trust.json");
}

export function userSkillsDir(homeDir: string = homedir()): string {
  return path.join(homeDir, PIGEON_DIR, "skills");
}

export function userPreferencesPath(homeDir: string = homedir()): string {
  return path.join(homeDir, PIGEON_DIR, "preferences.md");
}

// ---- 旧布局（决策 325 迁移）----

// 并入 settings.json 的 7 个旧文件：文件名 → 节名
export const LEGACY_CONFIG_FILES = [
  { file: "mcp.json", section: "mcp" },
  { file: "grants.json", section: "permissions" },
  { file: "commands.json", section: "commands" },
  { file: "orchestration.json", section: "orchestration" },
  { file: "web.json", section: "web" },
  { file: "sandbox.json", section: "sandbox" },
  { file: "loop-guard.json", section: "loopGuard" },
] as const;

export type LegacyConfigFile = (typeof LEGACY_CONFIG_FILES)[number];

export function legacyConfigPath(root: string, file: string): string {
  return path.join(root, PIGEON_DIR, file);
}

// 旧位置的程序状态 → 新位置（相对 .pigeon 的名字；worktrees 由 git worktree move 迁移）
export const LEGACY_STATE_ENTRIES = [
  { name: "sessions", target: (root: string) => sessionsDirOf(root) },
  { name: "learned", target: (root: string) => learnedDirOf(root) },
  { name: "learned.lock", target: (root: string) => learnedLockPathOf(root) },
  { name: "worktrees", target: (root: string) => worktreesDirOf(root) },
  { name: "review-backfill", target: (root: string) => reviewBackfillDirOf(root) },
  { name: "tui-history.json", target: (root: string) => promptHistoryPathOf(root) },
  // 终端界面日志（文件名由终端界面库给出）
  { name: "pi-debug.log", target: (root: string) => path.join(tuiLogDirOf(root), "pi-debug.log") },
  { name: "pi-crash.log", target: (root: string) => path.join(tuiLogDirOf(root), "pi-crash.log") },
] as const;

export function legacyStatePath(root: string, name: string): string {
  return path.join(root, PIGEON_DIR, name);
}

// 旧会话里记着的 worker 工作树绝对路径：旧前缀 <根>/.pigeon/worktrees/ 映射到 <根>/.pigeon/state/worktrees/。
// 启动时已拒绝旧布局（须先迁移），故旧前缀下的路径一律按新位置读取；不在旧前缀下的原样返回
export function mapLegacyWorktreePath(governanceRoot: string, recorded: string): string {
  const legacyPrefix = path.join(governanceRoot, PIGEON_DIR, "worktrees") + path.sep;
  if (!recorded.startsWith(legacyPrefix)) {
    return recorded;
  }
  return path.join(worktreesDirOf(governanceRoot), recorded.slice(legacyPrefix.length));
}
