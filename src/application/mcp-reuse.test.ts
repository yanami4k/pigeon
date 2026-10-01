// MCP 会话沿用连接（决策 340 的 /reload）：启动定义与工作区根都未变、仍连着的 server 沿用旧连接，不再建传输；
// 连接按持有它的会话数关闭——新会话关闭（装配失败的出口）不断开旧会话还在用的连接，两边都关了才断开。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createFixtureServer } from "../mcp/fixtures.ts";
import type { McpServerConfig } from "../state/mcp-config.ts";
import { type McpSession, startMcpSession } from "./mcp.ts";

function server(name: string, script: string): McpServerConfig {
  return {
    name,
    launch: { command: "node", args: [script] },
    launchSource: ".mcp.json",
    defaultTier: "write",
    tools: {},
  };
}

function start(servers: McpServerConfig[], created: string[], reuse?: McpSession, root = "/w") {
  return startMcpSession({
    governanceRoot: root,
    workspaceRoot: root,
    config: { servers },
    ...(reuse !== undefined ? { reuse } : {}),
    createTransport: (launch): Transport => {
      created.push(launch.type === "http" ? launch.url : (launch.args ?? []).join(" "));
      return createFixtureServer({
        tools: [
          {
            definition: { name: "echo", inputSchema: { type: "object" } },
            handler: () => ({ content: [{ type: "text" as const, text: "e" }] }),
          },
        ],
      }).clientTransport;
    },
  });
}

test("沿用未变的连接；新会话先关（装配失败）不断开旧会话的连接，两边都关了才断开", async () => {
  const created: string[] = [];
  const first = await start([server("keep", "k.js"), server("gone", "g.js")], created);
  const keep = first.connections.find((connection) => connection.name === "keep");
  const second = await start([server("keep", "k.js"), server("gone", "g2.js")], created, first);
  assert.deepEqual(created, ["k.js", "g.js", "g2.js"], "keep 不再建传输，改了的另起");
  assert.equal(
    second.connections.find((connection) => connection.name === "keep"),
    keep
  );
  await second.close();
  assert.equal(keep?.state, "connected", "新会话关闭不断开旧会话还在用的连接");
  await second.close();
  assert.equal(keep?.state, "connected", "重复关闭只算一次");
  const third = await start([server("keep", "k.js")], created, first);
  await first.close();
  assert.equal(keep?.state, "connected", "旧会话关闭不断开新会话在用的连接");
  await third.close();
  assert.equal(keep?.state, "closed", "都关了才断开");
});

test("工作区根变了或连接已不可用时不沿用", async () => {
  const created: string[] = [];
  const first = await start([server("keep", "k.js")], created);
  const other = await start([server("keep", "k.js")], created, first, "/other");
  assert.deepEqual(created, ["k.js", "k.js"]);
  await first.close();
  const again = await start([server("keep", "k.js")], created, first);
  assert.deepEqual(created, ["k.js", "k.js", "k.js"], "已断开的连接不沿用");
  await other.close();
  await again.close();
});
