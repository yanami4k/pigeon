// MCP 客户端（M5.7 S2）：内存传输夹具，不起子进程。连接后拉工具与 prompts 清单并转发调用；
// tools/list_changed 只记录不改清单（快照冻结，§2 规则 4）；掉线按退避重启，超过上限 fail-closed——
// 该 server 的工具一律报环境错误，不再触达 server。
import assert from "node:assert/strict";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { test } from "vitest";
import type { McpServerConfig } from "../state/mcp-config.ts";
import { classifyToolError } from "../tools/error-kind.ts";
import { McpServerConnection, McpServerUnavailableError } from "./client.ts";
import { createFixtureServer, type FixtureServer, failingTransport } from "./fixtures.ts";

const SERVER: McpServerConfig = {
  name: "everything",
  launch: { command: "node", args: ["server.js"] },
  launchSource: ".mcp.json",
  defaultTier: "write",
  tools: {},
};

function echoFixture() {
  return createFixtureServer({
    tools: [
      {
        definition: {
          name: "echo",
          description: "回显",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          annotations: { readOnlyHint: true },
        },
        handler: (args) => ({ content: [{ type: "text", text: `echo:${String(args.message)}` }] }),
      },
    ],
    prompts: [{ name: "greet", description: "打招呼", text: "你好" }],
  });
}

// 依次交出预设的传输：夹具 server 或"起不来"；记录每次创建出的夹具
function transportPlan(plan: ("ok" | "fail")[]) {
  const fixtures: FixtureServer[] = [];
  let index = 0;
  const createTransport = (): Transport => {
    const step = plan[Math.min(index, plan.length - 1)];
    index += 1;
    if (step === "fail") {
      return failingTransport();
    }
    const { fixture, clientTransport } = echoFixture();
    fixtures.push(fixture);
    return clientTransport;
  };
  return { fixtures, createTransport, created: () => index };
}

test("MCP 客户端：连接后拉取工具与 prompts 清单，调用转发参数与返回", async () => {
  const plan = transportPlan(["ok"]);
  const connection = new McpServerConnection({
    server: SERVER,
    roots: [],
    createTransport: plan.createTransport,
  });
  await connection.start();
  try {
    assert.equal(connection.state, "connected");
    assert.deepEqual(
      connection.tools().map((tool) => tool.name),
      ["echo"]
    );
    assert.deepEqual(connection.tools()[0]?.annotations, { readOnlyHint: true });
    assert.deepEqual(
      connection.prompts().map((prompt) => [prompt.name, prompt.description]),
      [["greet", "打招呼"]]
    );
    const result = await connection.callTool("echo", { message: "hi" });
    assert.deepEqual(result.content, [{ type: "text", text: "echo:hi" }]);
    assert.deepEqual(plan.fixtures[0]?.calls, [{ name: "echo", args: { message: "hi" } }]);
    const prompt = await connection.getPrompt("greet");
    assert.deepEqual(prompt.messages, [{ role: "user", content: { type: "text", text: "你好" } }]);
  } finally {
    await connection.close();
  }
});

test("MCP 客户端：tools/list_changed 只记录一条变更，已拉取的工具清单不变", async () => {
  const plan = transportPlan(["ok"]);
  let now = 1000;
  const connection = new McpServerConnection({
    server: SERVER,
    roots: [],
    createTransport: plan.createTransport,
    now: () => now,
  });
  await connection.start();
  try {
    now = 2000;
    await plan.fixtures[0]?.notifyToolsChanged();
    // 通知经内存传输同步投递；让出一轮事件循环等处理器跑完
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(connection.listChanges(), [{ list: "tools", at: 2000 }]);
    assert.deepEqual(
      connection.tools().map((tool) => tool.name),
      ["echo"]
    );
  } finally {
    await connection.close();
  }
});

test("MCP 客户端：掉线后按退避重启，重连成功恢复可用并计数", async () => {
  const plan = transportPlan(["ok", "fail", "ok"]);
  const connection = new McpServerConnection({
    server: SERVER,
    roots: [],
    createTransport: plan.createTransport,
    maxRestarts: 3,
    backoffMs: () => 1,
  });
  await connection.start();
  try {
    await plan.fixtures[0]?.drop();
    await connection.idle();
    assert.equal(connection.state, "connected");
    assert.equal(connection.restarts, 2);
    const result = await connection.callTool("echo", { message: "again" });
    assert.deepEqual(result.content, [{ type: "text", text: "echo:again" }]);
    assert.deepEqual(plan.fixtures[1]?.calls, [{ name: "echo", args: { message: "again" } }]);
  } finally {
    await connection.close();
  }
});

test("MCP 客户端：掉线超过重启上限 fail-closed——状态 unavailable，调用报环境错误且不触达 server", async () => {
  const plan = transportPlan(["ok", "fail"]);
  const connection = new McpServerConnection({
    server: SERVER,
    roots: [],
    createTransport: plan.createTransport,
    maxRestarts: 2,
    backoffMs: () => 1,
  });
  await connection.start();
  try {
    await plan.fixtures[0]?.drop();
    await connection.idle();
    assert.equal(connection.state, "unavailable");
    assert.equal(connection.restarts, 2);
    // 首次连接 1 次 + 重启 2 次，之后不再尝试
    assert.equal(plan.created(), 3);
    const failure = await connection.callTool("echo", { message: "x" }).then(
      () => undefined,
      (error: unknown) => error
    );
    assert.ok(failure instanceof McpServerUnavailableError, String(failure));
    assert.equal(classifyToolError(failure), "environment");
    assert.match((failure as Error).message, /everything/);
    assert.deepEqual(plan.fixtures[0]?.calls, []);
    assert.ok(connection.lastError !== undefined);
  } finally {
    await connection.close();
  }
});

test("MCP 客户端：启动失败——状态 unavailable、工具清单为空、调用报环境错误；启动本身不抛", async () => {
  const plan = transportPlan(["fail"]);
  const connection = new McpServerConnection({
    server: SERVER,
    roots: [],
    createTransport: plan.createTransport,
    maxRestarts: 2,
    backoffMs: () => 1,
  });
  await connection.start();
  try {
    assert.equal(connection.state, "unavailable");
    assert.deepEqual(connection.tools(), []);
    assert.equal(plan.created(), 1);
    await assert.rejects(connection.callTool("echo", {}), McpServerUnavailableError);
  } finally {
    await connection.close();
  }
});

test("MCP 客户端：主动关闭后不重启", async () => {
  const plan = transportPlan(["ok"]);
  const connection = new McpServerConnection({
    server: SERVER,
    roots: [],
    createTransport: plan.createTransport,
    maxRestarts: 3,
    backoffMs: () => 1,
  });
  await connection.start();
  await connection.close();
  await connection.idle();
  assert.equal(connection.state, "closed");
  assert.equal(plan.created(), 1);
  await assert.rejects(connection.callTool("echo", {}), McpServerUnavailableError);
});
