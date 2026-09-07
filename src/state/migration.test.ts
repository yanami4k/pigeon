import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { MigrationError, MigrationRegistry } from "./migration.ts";

// 假文档 v0：{ version: 0, oldName: string }
// 假文档 v1：{ version: 1, name: string }（字段改名）
const DocV1 = Type.Object({ version: Type.Literal(1), name: Type.String() });

// 注册假 v0→v1 迁移的注册表
function makeRegistry(): MigrationRegistry {
  const registry = new MigrationRegistry();
  registry.register("doc", 0, (doc) => {
    const { oldName, ...rest } = doc;
    return { ...rest, version: 1, name: oldName };
  });
  return registry;
}

test("读旧 version → 查表 → 升级 → 校验：完整管线", () => {
  const result = makeRegistry().migrate("doc", { version: 0, oldName: "旧字段" }, 1, DocV1);
  assert.deepStrictEqual(result, { version: 1, name: "旧字段" });
});

test("已是目标版本：不查表，直接校验", () => {
  const result = makeRegistry().migrate("doc", { version: 1, name: "无需迁移" }, 1, DocV1);
  assert.deepStrictEqual(result, { version: 1, name: "无需迁移" });
});

test("缺少对应迁移时报错", () => {
  assert.throws(
    () => new MigrationRegistry().migrate("doc", { version: 0, oldName: "x" }, 1, DocV1),
    MigrationError
  );
});

test("迁移后版本未 +1 时报错", () => {
  const registry = new MigrationRegistry();
  registry.register("doc", 0, (doc) => doc); // 忘记升版本
  assert.throws(() => registry.migrate("doc", { version: 0 }, 1, DocV1), MigrationError);
});

test("升级结果不符合目标 schema 时校验拒绝", () => {
  const registry = new MigrationRegistry();
  registry.register("doc", 0, () => ({ version: 1 })); // 缺 name
  assert.throws(() => registry.migrate("doc", { version: 0 }, 1, DocV1));
});

test("高版本文档拒绝降级", () => {
  assert.throws(() => makeRegistry().migrate("doc", { version: 2 }, 1, DocV1), MigrationError);
});

test("重复注册同一 (名称, 起始版本) 报错", () => {
  const registry = makeRegistry();
  assert.throws(() => registry.register("doc", 0, (doc) => doc), MigrationError);
});
