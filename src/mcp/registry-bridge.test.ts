// MCP 工具映射进注册表（M5.7 S2）：工具名加 server 前缀并归一为注册表形态；风险档取配置（未列出落
// defaultTier）；inputSchema 原样透传；注解摘要与配置档位留给 S3 的冲突判定；执行转发并映射内容块。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpServerConfig } from "../state/mcp-config.ts";
import { classifyToolError } from "../tools/error-kind.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { McpServerUnavailableError, type McpToolDescriptor } from "./client.ts";
import { bridgeMcpServer, MCP_TOOL_NAME_MAX, mcpToolName } from "./registry-bridge.ts";

const ECHO_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" }, count: { type: "integer", minimum: 1 } },
  required: ["message"],
  additionalProperties: false,
} as const;

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "Server-Everything",
    launch: { command: "node", args: ["s.js"] },
    launchSource: ".mcp.json",
    defaultTier: "write",
    tools: {},
    ...overrides,
  };
}

function source(tools: McpToolDescriptor[], callTool: (name: string, args: unknown) => unknown) {
  return {
    tools: () => tools,
    callTool: async (name: string, args: unknown) => callTool(name, args),
  };
}

test("MCP 映射：工具名加 server 前缀归一；风险档取配置、未列出落 defaultTier；schema 原样透传且注册表接受；注解摘要保留", () => {
  const tools: McpToolDescriptor[] = [
    {
      name: "echo",
      description: "回显",
      inputSchema: ECHO_SCHEMA,
      annotations: { readOnlyHint: true, title: "Echo" },
    },
    { name: "get-Tiny.Image", inputSchema: { type: "object" } },
  ];
  const bridged = bridgeMcpServer({
    server: server({
      defaultTier: "exec",
      tools: { echo: { tier: "read", pathConfinement: { kind: "workspace" } } },
    }),
    source: source(tools, () => ({ content: [] })),
  });
  assert.deepEqual(bridged.problems, []);
  assert.equal(mcpToolName("Server-Everything", "echo"), "mcp__server_everything__echo");
  const [echo, image] = bridged.tools;
  assert.ok(echo !== undefined && image !== undefined);
  assert.equal(echo.name, "mcp__server_everything__echo");
  assert.equal(echo.mcpName, "echo");
  assert.equal(echo.server, "Server-Everything");
  assert.equal(echo.registration.tier, "read");
  assert.deepEqual(echo.registration.pathConfinement, { kind: "workspace" });
  assert.equal(echo.configured, true);
  assert.deepEqual(echo.declaredHint, { readOnlyHint: true });
  // 原样透传：同一份 JSON Schema，不经 typebox 重建
  assert.deepEqual(echo.registration.parameters, ECHO_SCHEMA);
  assert.deepEqual(echo.tool.parameters, ECHO_SCHEMA);
  assert.match(echo.registration.description, /回显/);
  assert.equal(image.name, "mcp__server_everything__get_tiny_image");
  assert.equal(image.registration.tier, "exec");
  assert.equal(image.configured, false);
  assert.equal(image.declaredHint, undefined);
  assert.deepEqual(image.registration.pathConfinement, { kind: "none" });
  const registry = new ToolRegistry();
  for (const tool of bridged.tools) {
    registry.register(tool.registration);
  }
  assert.equal(registry.size, 2);
});

test("MCP 映射：执行转发参数；文本与图片内容块映射；isError 结果抛域错误；server 不可用的环境错误原样上抛", async () => {
  const seen: { name: string; args: unknown }[] = [];
  const bridged = bridgeMcpServer({
    server: server(),
    source: source(
      [
        { name: "echo", inputSchema: ECHO_SCHEMA },
        { name: "fail", inputSchema: { type: "object" } },
        { name: "gone", inputSchema: { type: "object" } },
      ],
      (name, args) => {
        seen.push({ name, args });
        if (name === "fail") {
          return { content: [{ type: "text", text: "坏参数" }], isError: true };
        }
        if (name === "gone") {
          throw new McpServerUnavailableError("everything", "掉线");
        }
        return {
          content: [
            { type: "text", text: "hi" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "resource_link", uri: "file:///x", name: "x" },
          ],
          structuredContent: { evidence: { ok: true } },
        };
      }
    ),
  });
  const [echo, fail, gone] = bridged.tools;
  assert.ok(echo !== undefined && fail !== undefined && gone !== undefined);
  const result = await echo.tool.execute("call-1", { message: "hi" });
  assert.deepEqual(seen[0], { name: "echo", args: { message: "hi" } });
  assert.deepEqual(result.content.slice(0, 2), [
    { type: "text", text: "hi" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
  assert.equal(result.content[2]?.type, "text");
  assert.equal(result.details.server, "Server-Everything");
  assert.equal(result.details.tool, "echo");
  assert.equal(result.details.isError, false);

  const domain = await fail.tool.execute("call-2", {}).then(
    () => undefined,
    (error: unknown) => error
  );
  assert.ok(domain instanceof Error);
  assert.match(domain.message, /坏参数/);
  assert.equal(classifyToolError(domain), "domain");

  const environment = await gone.tool.execute("call-3", {}).then(
    () => undefined,
    (error: unknown) => error
  );
  assert.ok(environment instanceof McpServerUnavailableError);
  assert.equal(classifyToolError(environment), "environment");
});

test("MCP 映射：归一后重名或超出长度上限的工具跳过并列出问题", () => {
  const long = "x".repeat(MCP_TOOL_NAME_MAX);
  const bridged = bridgeMcpServer({
    server: server({ name: "fs" }),
    source: source(
      [
        { name: "read-file", inputSchema: { type: "object" } },
        { name: "read_file", inputSchema: { type: "object" } },
        { name: long, inputSchema: { type: "object" } },
      ],
      () => ({ content: [] })
    ),
  });
  assert.deepEqual(
    bridged.tools.map((tool) => tool.name),
    ["mcp__fs__read_file"]
  );
  assert.equal(bridged.problems.length, 2);
  assert.match(bridged.problems[0] ?? "", /read_file/);
  assert.match(bridged.problems[1] ?? "", /长度/);
});
