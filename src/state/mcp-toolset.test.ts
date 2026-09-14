// MCP 工具集摘要（M5.7 S3，决策 052）：注解只当线索、风险档以配置为准，冲突按更严执行——
// 声明只读但配置 write / exec 按配置并标冲突；声明 destructive 但配置 read 按 write 并标冲突；
// 摘要字段加法式进 run.started（不升版本，旧记录无此字段仍合法）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { effectiveMcpTier, McpServerStatusSchema, McpToolsetEntrySchema } from "./mcp-toolset.ts";
import { RunStartedPayloadSchema } from "./runtime-events.ts";

test("MCP 冲突规则：声明只读但配置 write / exec 按配置并标冲突；声明 destructive 但配置 read 按 write 并标冲突", () => {
  assert.deepEqual(effectiveMcpTier("write", { readOnlyHint: true }), {
    effectiveTier: "write",
    conflict: true,
  });
  assert.deepEqual(effectiveMcpTier("exec", { readOnlyHint: true }), {
    effectiveTier: "exec",
    conflict: true,
  });
  assert.deepEqual(effectiveMcpTier("read", { destructiveHint: true }), {
    effectiveTier: "write",
    conflict: true,
  });
  // 同时声明只读与 destructive、配置 read：取更严的 write
  assert.deepEqual(effectiveMcpTier("read", { readOnlyHint: true, destructiveHint: true }), {
    effectiveTier: "write",
    conflict: true,
  });
});

test("MCP 冲突规则：一致或无声明时按配置、不标冲突", () => {
  assert.deepEqual(effectiveMcpTier("read", { readOnlyHint: true }), {
    effectiveTier: "read",
    conflict: false,
  });
  assert.deepEqual(effectiveMcpTier("write", { destructiveHint: true }), {
    effectiveTier: "write",
    conflict: false,
  });
  assert.deepEqual(effectiveMcpTier("read", { readOnlyHint: false, destructiveHint: false }), {
    effectiveTier: "read",
    conflict: false,
  });
  assert.deepEqual(effectiveMcpTier("read"), { effectiveTier: "read", conflict: false });
  assert.deepEqual(effectiveMcpTier("exec", { idempotentHint: true, openWorldHint: true }), {
    effectiveTier: "exec",
    conflict: false,
  });
});

test("run.started 加法字段：MCP 工具集摘要与 server 状态可缺省、可携带", () => {
  const base = {
    model: { provider: "p", id: "m" },
    policy: { allow: [], deny: [], approvalMode: "prompt" },
    advertisedTools: [],
    systemPromptHash: "0".repeat(64),
    memory: [],
    skills: [],
  };
  assert.ok(Value.Check(RunStartedPayloadSchema, base));
  const entry = {
    name: "mcp__fx__echo",
    server: "fx",
    tool: "echo",
    configuredTier: "write",
    effectiveTier: "write",
    declaredHint: { readOnlyHint: true },
    conflict: true,
  };
  const server = {
    name: "fx",
    state: "unavailable",
    restarts: 2,
    error: "连接断开",
    listChanges: [{ list: "tools", at: 1 }],
  };
  assert.ok(Value.Check(McpToolsetEntrySchema, entry));
  assert.ok(Value.Check(McpServerStatusSchema, server));
  assert.ok(
    Value.Check(RunStartedPayloadSchema, { ...base, mcpTools: [entry], mcpServers: [server] })
  );
  assert.ok(!Value.Check(McpToolsetEntrySchema, { ...entry, effectiveTier: "admin" }));
  assert.ok(!Value.Check(McpServerStatusSchema, { ...server, state: "sleeping" }));
});
