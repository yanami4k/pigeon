// 旧布局检查（决策 325）：并入 settings.json 的旧配置文件与 .pigeon 根下旧位置的程序状态；另有已退役的
// .pigeon/verify.json（验证门随决策 322 删除，迁移命令把它挪进备份目录并打印改写为收尾钩子的示例）。
// 启动时（终端界面、pigeon run、--line、pigeon resume；worker 与沙箱会话随派出它的会话）发现任一项即报错，
// 提示运行 pigeon migrate-config，不自动迁移。
import { existsSync } from "node:fs";
import {
  LEGACY_CONFIG_FILES,
  LEGACY_STATE_ENTRIES,
  legacyConfigPath,
  legacyStatePath,
  pigeonRel,
  verifyConfigPathOf,
} from "../state/paths.ts";

export const MIGRATE_CONFIG_COMMAND = "pigeon migrate-config";

export interface LegacyItem {
  kind: "config" | "state";
  // 相对 .pigeon 的名字
  name: string;
  path: string;
  // 该配置已随功能删除（不并入 settings.json，迁移时挪进备份目录）；缺省 = 已并入三层设置
  retired?: boolean;
}

export function findLegacyLayout(root: string): LegacyItem[] {
  const items: LegacyItem[] = [];
  for (const legacy of LEGACY_CONFIG_FILES) {
    const path = legacyConfigPath(root, legacy.file);
    if (existsSync(path)) {
      items.push({ kind: "config", name: legacy.file, path });
    }
  }
  const verifyPath = verifyConfigPathOf(root);
  if (existsSync(verifyPath)) {
    items.push({ kind: "config", name: "verify.json", path: verifyPath, retired: true });
  }
  for (const entry of LEGACY_STATE_ENTRIES) {
    const path = legacyStatePath(root, entry.name);
    if (existsSync(path)) {
      items.push({ kind: "state", name: entry.name, path });
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
  return [
    "发现旧的配置布局，Pigeon 不会自动迁移：",
    ...(configs.length > 0
      ? [`  旧配置文件：${configs.join("、")}（已并入三层 settings.json）`]
      : []),
    ...(items.some((item) => item.retired === true)
      ? [`  已退役的配置文件：${pigeonRel("verify.json")}（验证门已删除；迁移时打印改写为收尾钩子的示例）`]
      : []),
    ...(states.length > 0
      ? [`  旧位置的程序状态：${states.join("、")}（已移到 ${pigeonRel("state")}/ 下）`]
      : []),
    `请在项目根运行 ${MIGRATE_CONFIG_COMMAND} 完成迁移后再启动。`,
  ].join("\n");
}

export function assertNoLegacyLayout(root: string): void {
  const items = findLegacyLayout(root);
  if (items.length > 0) {
    throw new LegacyLayoutError(legacyLayoutMessage(items));
  }
}
