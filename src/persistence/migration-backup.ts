// 迁移备份（决策 325）：迁移命令把挪走的旧文件统一放进 .pigeon/state/migration-backup/<原名>.bak。备份在程序状态目录下，
// 不进工作目录快照、checkpoint 与 worker 叠加，也被 .pigeon/.gitignore 挡在提交之外（旧 web.json 里可能有 key）。
// 迁移的各步共用这一个函数（钩子一段的 verify.json、记忆一段的 memory-review.json 与旧记忆同样经它备份）。
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { migrationBackupPathOf, pigeonRel } from "../state/paths.ts";
import { ensurePigeonGitignore } from "./settings.ts";

export class MigrationBackupError extends Error {}

// 备份位置的展示写法
export function migrationBackupLabel(name: string): string {
  return pigeonRel("state", "migration-backup", `${name}.bak`);
}

// 备份位置已被占用时返回说明（迁移的检查阶段据此拦住，不覆盖已有备份）
export function migrationBackupConflict(root: string, name: string): string | undefined {
  return existsSync(migrationBackupPathOf(root, name))
    ? `${migrationBackupLabel(name)} 已存在，不覆盖备份；请先处理它`
    : undefined;
}

// 把旧文件（相对 .pigeon 的名字）挪进备份目录；返回备份位置的展示写法
export function moveToMigrationBackup(
  root: string,
  source: string,
  name: string,
  notice?: (line: string) => void
): string {
  const target = migrationBackupPathOf(root, name);
  if (existsSync(target)) {
    throw new MigrationBackupError(`${migrationBackupLabel(name)} 已存在，不覆盖备份`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  ensurePigeonGitignore(root, notice);
  renameSync(source, target);
  return migrationBackupLabel(name);
}
