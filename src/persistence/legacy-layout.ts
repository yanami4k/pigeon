// 旧布局检查（决策 325）：并入 settings.json 的旧配置文件、.pigeon 根下旧位置的程序状态，以及已删除功能的遗留
//（决策 330、331：复盘配置与补做复盘记录、旧学到的记忆新旧两处、旧人写说明 .pigeon/memory/、用户级旧偏好
// ~/.pigeon/preferences.md）。启动时（终端界面、pigeon run、--line、pigeon resume；worker 与沙箱会话随派出它的
// 会话）发现任一项即报错，提示运行 pigeon migrate-config，不自动迁移。.pigeon/verify.json 本段不算旧文件。
import { existsSync } from "node:fs";
import path from "node:path";
import {
  LEGACY_CONFIG_FILES,
  LEGACY_STATE_ENTRIES,
  legacyConfigPath,
  legacyStatePath,
  pigeonRel,
  userPreferencesPath,
} from "../state/paths.ts";

export const MIGRATE_CONFIG_COMMAND = "pigeon migrate-config";

export interface LegacyItem {
  kind: "config" | "state" | "removed";
  // 相对 .pigeon 的名字；用户级的项为完整路径说明（~ 开头）
  name: string;
  path: string;
}

// 已删除功能的遗留（相对 .pigeon）：迁移命令把它们挪出仓库进用户级备份（决策 341）
const REMOVED_LEGACY = [
  "memory-review.json",
  "review-backfill",
  path.join("state", "review-backfill"),
  "learned",
  "learned.lock",
  path.join("state", "learned"),
  path.join("state", "learned.lock"),
  "memory",
] as const;

// 用户级旧偏好（决策 330：迁移命令改名为 ~/.pigeon/AGENTS.md）；homeDir 缺省时不查用户级
const USER_PREFERENCES_NAME = "~/.pigeon/preferences.md";

export function findLegacyLayout(root: string, options: { homeDir?: string } = {}): LegacyItem[] {
  const items: LegacyItem[] = [];
  for (const legacy of LEGACY_CONFIG_FILES) {
    const path = legacyConfigPath(root, legacy.file);
    if (existsSync(path)) {
      items.push({ kind: "config", name: legacy.file, path });
    }
  }
  for (const entry of LEGACY_STATE_ENTRIES) {
    const path = legacyStatePath(root, entry.name);
    if (existsSync(path)) {
      items.push({ kind: "state", name: entry.name, path });
    }
  }
  for (const name of REMOVED_LEGACY) {
    const item = legacyStatePath(root, name);
    if (existsSync(item)) {
      items.push({ kind: "removed", name, path: item });
    }
  }
  if (options.homeDir !== undefined) {
    const preferences = userPreferencesPath(options.homeDir);
    if (existsSync(preferences)) {
      items.push({ kind: "removed", name: USER_PREFERENCES_NAME, path: preferences });
    }
  }
  return items;
}

export class LegacyLayoutError extends Error {}

export function legacyLayoutMessage(items: readonly LegacyItem[]): string {
  const configs = items
    .filter((item) => item.kind === "config")
    .map((item) => pigeonRel(item.name));
  const states = items.filter((item) => item.kind === "state").map((item) => pigeonRel(item.name));
  const removed = items
    .filter((item) => item.kind === "removed")
    .map((item) => (item.name.startsWith("~") ? item.name : pigeonRel(item.name)));
  return [
    "发现旧的配置布局，Pigeon 不会自动迁移：",
    ...(configs.length > 0
      ? [`  旧配置文件：${configs.join("、")}（已并入三层 settings.json）`]
      : []),
    ...(states.length > 0
      ? [`  旧位置的程序状态：${states.join("、")}（已移到 ${pigeonRel("state")}/ 下）`]
      : []),
    ...(removed.length > 0
      ? [`  已删除功能的遗留：${removed.join("、")}（迁移命令挪到备份目录或改名）`]
      : []),
    `请在项目根运行 ${MIGRATE_CONFIG_COMMAND} 完成迁移后再启动。`,
  ].join("\n");
}

export function assertNoLegacyLayout(root: string, options: { homeDir?: string } = {}): void {
  const items = findLegacyLayout(root, options);
  if (items.length > 0) {
    throw new LegacyLayoutError(legacyLayoutMessage(items));
  }
}
