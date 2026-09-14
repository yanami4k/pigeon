// 注册表接受原生 JSON Schema 对象参数（M5.7 S2）：MCP 工具的 inputSchema 原样透传——上游按 JSON Schema
// 关键字校验参数、按原样发给 provider，不依赖 typebox 的类型标记；非对象形 schema 仍拒绝。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TSchema } from "typebox";
import { ToolRegistry, ToolRegistryError } from "./registry.ts";

function registration(name: string, parameters: unknown) {
  return {
    name,
    description: "外部工具",
    parameters: parameters as TSchema,
    tier: "write" as const,
    pathConfinement: { kind: "none" as const },
    executionMode: "sequential" as const,
  };
}

test("注册表：原生 JSON Schema 对象参数可注册；非对象形 schema 拒绝", () => {
  const registry = new ToolRegistry();
  const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  registry.register(registration("mcp__fs__read", schema));
  assert.equal(registry.get("mcp__fs__read")?.parameters, schema);
  for (const bad of [{ type: "string" }, null, "object", { properties: {} }]) {
    assert.throws(
      () => registry.register(registration("mcp__fs__bad", bad)),
      ToolRegistryError,
      JSON.stringify(bad)
    );
  }
});
