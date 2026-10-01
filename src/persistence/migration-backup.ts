// 迁移备份（决策 341）：迁移命令处理过的旧文件一律挪出仓库，放进用户级 ~/.pigeon/state/migration-backup/ 下本项目的目录
// （项目按规范化路径分目录，见路径模块），原名原文不变；仓库里不留备份，含 key 的旧文件不进快照、沙箱容器、worker 工作树与提交。
// 迁移的各步共用这一组函数（钩子一段的 verify.json、记忆一段的 memory-review.json 与旧记忆同样经它备份）。
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { migrationBackupDirOf } from "../state/paths.ts";
import { normalizeProjectPath } from "./config-trust-store.ts";

export class MigrationBackupError extends Error {}

// 本项目的备份目录（迁移结束打印给人看）
export function migrationBackupLocation(root: string, homeDir: string = homedir()): string {
  return migrationBackupDirOf(normalizeProjectPath(root), homeDir);
}

// 某个旧文件（相对 .pigeon 的名字）的备份位置
function backupPathOf(root: string, name: string, homeDir: string): string {
  return path.join(migrationBackupLocation(root, homeDir), name);
}

// 备份位置已被占用时返回说明（迁移的检查阶段据此拦住，不覆盖已有备份）
export function migrationBackupConflict(
  root: string,
  name: string,
  homeDir: string = homedir()
): string | undefined {
  const target = backupPathOf(root, name, homeDir);
  return existsSync(target) ? `备份 ${target} 已存在，不覆盖；请先处理它` : undefined;
}

// 把旧文件或目录（相对 .pigeon 的名字）挪进备份目录；返回备份位置。用户主目录与项目不在同一文件系统时改为复制后删除
export function moveToMigrationBackup(
  root: string,
  source: string,
  name: string,
  homeDir: string = homedir()
): string {
  const target = backupPathOf(root, name, homeDir);
  if (existsSync(target)) {
    throw new MigrationBackupError(`备份 ${target} 已存在，不覆盖`);
  }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(source, target, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    rmSync(source, { recursive: true });
  }
  return target;
}
