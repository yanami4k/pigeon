// 版本化迁移管线：读旧 version → 查表逐级升级 → 目标 schema 校验。
// 为 M4 真正出现 v2 文档铺路；迁移按 (名称, 起始版本) 注册，每个迁移函数只升一级，
// 长链由 runner 自动串接。

import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

// 迁移函数：输入某版本的 JSON 文档，输出下一版本的文档，version 字段必须同步 +1
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

// 防御性上限：防止迁移函数忘记升版本导致死循环
const MAX_MIGRATION_STEPS = 64;

export class MigrationError extends Error {}

export class MigrationRegistry {
  // key 形如 "event:0"，表示 event 文档 v0 → v1 的迁移
  private readonly migrations = new Map<string, Migration>();

  register(name: string, fromVersion: number, migrate: Migration): void {
    const key = `${name}:${fromVersion}`;
    if (this.migrations.has(key)) {
      throw new MigrationError(`重复注册迁移：${key}`);
    }
    this.migrations.set(key, migrate);
  }

  // 将 doc 逐级升级到 targetVersion，并用目标 schema 校验；校验失败抛 ParseError
  migrate<Schema extends TSchema>(
    name: string,
    doc: unknown,
    targetVersion: number,
    schema: Schema
  ): Static<Schema> {
    let current = doc;
    for (let step = 0; ; step++) {
      const version = readVersion(current);
      if (version === targetVersion) {
        return Value.Parse(schema, current);
      }
      if (version > targetVersion) {
        throw new MigrationError(`${name} 版本 v${version} 高于目标 v${targetVersion}，不支持降级`);
      }
      if (step >= MAX_MIGRATION_STEPS) {
        throw new MigrationError(`${name} 迁移步数超过上限 ${MAX_MIGRATION_STEPS}，疑似迁移链成环`);
      }
      const migrate = this.migrations.get(`${name}:${version}`);
      if (migrate === undefined) {
        throw new MigrationError(`${name} 缺少 v${version} → v${version + 1} 的迁移`);
      }
      const next = migrate(current as Record<string, unknown>);
      const nextVersion = readVersion(next);
      if (nextVersion !== version + 1) {
        throw new MigrationError(
          `${name} 的 v${version} 迁移后版本应为 v${version + 1}，实际为 v${nextVersion}`
        );
      }
      current = next;
    }
  }
}

// 读取文档版本号：必须是非负整数
function readVersion(doc: unknown): number {
  if (typeof doc !== "object" || doc === null || !("version" in doc)) {
    throw new MigrationError("迁移输入缺少 version 字段");
  }
  const { version } = doc as { version: unknown };
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new MigrationError(`非法版本号：${String(version)}`);
  }
  return version;
}
