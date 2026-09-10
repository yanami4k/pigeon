import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import {
  type PathConfinement,
  type ToolRegistration,
  ToolRegistry,
  ToolRegistryError,
} from "./registry.ts";

function makeReadFileRegistration(): ToolRegistration {
  return {
    name: "read_file",
    description: "读取工作区内文件内容",
    parameters: Type.Object({ path: Type.String() }),
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "parallel",
  };
}

test("合法注册后可按名取回，元数据原样保留", () => {
  const registry = new ToolRegistry();
  const registration = makeReadFileRegistration();
  registry.register(registration);

  assert.equal(registry.has("read_file"), true);
  assert.equal(registry.size, 1);
  assert.deepEqual(registry.get("read_file"), registration);
  assert.deepEqual(registry.list(), [registration]);
  assert.equal(registry.get("nonexistent"), undefined);
});

test("重名注册被拒绝", () => {
  const registry = new ToolRegistry();
  registry.register(makeReadFileRegistration());
  assert.throws(() => registry.register(makeReadFileRegistration()), ToolRegistryError);
});

test("畸形元数据被拒绝：非法名称 / 空描述 / 越界 tier / 越界 executionMode", () => {
  const base = makeReadFileRegistration();
  const malformed: Array<[string, ToolRegistration]> = [
    ["空名称", { ...base, name: "" }],
    ["大写名称", { ...base, name: "ReadFile" }],
    ["空描述", { ...base, description: "" }],
    ["越界 tier", { ...base, tier: "admin" } as unknown as ToolRegistration],
    ["越界 executionMode", { ...base, executionMode: "exclusive" } as unknown as ToolRegistration],
  ];
  for (const [label, registration] of malformed) {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register(registration), ToolRegistryError, label);
  }
});

test("畸形路径约束被拒绝：未知 kind / 空 roots 清单", () => {
  const base = makeReadFileRegistration();
  const badKinds: PathConfinement[] = [
    { kind: "anywhere" } as unknown as PathConfinement,
    { kind: "roots", roots: [] },
  ];
  for (const pathConfinement of badKinds) {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register({ ...base, pathConfinement }), ToolRegistryError);
  }
});

test("parameters 必须是 typebox 对象 schema：裸对象与非对象 schema 被拒绝", () => {
  const base = makeReadFileRegistration();
  const badParameters: unknown[] = [{}, Type.String(), null, undefined];
  for (const parameters of badParameters) {
    const registry = new ToolRegistry();
    assert.throws(
      () => registry.register({ ...base, parameters } as unknown as ToolRegistration),
      ToolRegistryError
    );
  }
});

test("三种路径约束形态与 exec 层工具均可注册", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "run_tests",
    description: "在隔离环境执行固定测试命令",
    parameters: Type.Object({ suite: Type.String() }),
    tier: "exec",
    pathConfinement: { kind: "none" },
    executionMode: "sequential",
  });
  registry.register({
    name: "edit_file",
    description: "hashline 锚定稀疏编辑",
    parameters: Type.Object({ path: Type.String(), edits: Type.Array(Type.String()) }),
    tier: "write",
    pathConfinement: { kind: "roots", roots: ["src", "docs"] },
    executionMode: "sequential",
  });
  assert.equal(registry.size, 2);
  assert.equal(registry.get("run_tests")?.tier, "exec");
  assert.equal(registry.get("edit_file")?.pathConfinement.kind, "roots");
});
