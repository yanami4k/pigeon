// 旧布局检查（决策 325）：7 个并入 settings.json 的旧配置文件与 .pigeon 根下旧位置的程序状态。
// 启动时（终端界面、pigeon run、--line、pigeon resume；worker 与沙箱会话随派出它的会话）发现任一项即报错，
// 提示运行 pigeon migrate-config，不自动迁移。.pigeon/verify.json 与 .pigeon/memory-review.json 本段不算旧文件。
import { existsSync } from "node:fs";
import {
  LEGACY_CONFIG_FILES,
  LEGACY_STATE_ENTRIES,
  legacyConfigPath,
  legacyStatePath,
  pigeonRel,
} from "../state/paths.ts";

export const MIGRATE_CONFIG_COMMAND = "pigeon migrate-config";

export interface LegacyItem {
  kind: "config" | "state";
  // 相对 .pigeon 的名字
  name: string;
  path: string;
}

export function findLegacyLayout(root: string): LegacyItem[] {
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
