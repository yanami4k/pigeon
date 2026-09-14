// MCP 治理接线端到端（M5.7 S3，决策 051 / 052 / 053）：真实装配根 + 内存传输夹具 server + fake streamFn。
// 注解与配置冲突落 run.started；声明只读但配置（或缺省）write 的工具与声明 destructive 但配置 read 的工具
// 都走审批，配置 read 且无冲突的自动放行；write 档调用 intent 记原始参数、receipt 带 mcp 块；
// server 掉线后核心 Run 照跑，MCP 调用报环境错误，下个 Run 的 run.started 记 server 不可用。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { createFixtureServer, type FixtureServer } from "../mcp/fixtures.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { canonicalJson, sha256Hex } from "../state/message-content.ts";
import { startMcpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

function writeMcpConfig(root: string, servers: Record<string, unknown>): void {
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  writeFileSync(join(root, ".pigeon", "mcp.json"), JSON.stringify({ version: 1, servers }));
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function fxServer(fixtures: FixtureServer[]) {
  return (): Transport => {
    const { fixture, clientTransport } = createFixtureServer({
      tools: [
        {
          definition: {
            name: "echo",
            inputSchema: { type: "object", properties: { message: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
          handler: (args) => text(`echo:${String(args.message)}`),
        },
        {
          definition: {
            name: "peek",
            inputSchema: { type: "object" },
            annotations: { destructiveHint: true },
          },
          handler: () => text("peeked"),
        },
        {
          definition: {
            name: "look",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
          handler: () => text("looked"),
        },
        {
          definition: {
            name: "note",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
          handler: () => ({
            content: [{ type: "text", text: "noted" }],
            structuredContent: { evidence: { path: "notes.txt", sha: "abc" }, other: 1 },
          }),
        },
      ],
    });
    fixtures.push(fixture);
    return clientTransport;
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { text: `调用 ${name}`, toolCalls: [{ name, args }] };
}

test("MCP 接线：冲突落 run.started；声明只读或未配置、声明 destructive 配 read 的工具走审批，read 档自动放行；receipt 带 mcp 块", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-mcp-e2e-"));
  try {
    writeMcpConfig(root, {
      fx: {
        launch: { command: "node", args: ["fixture.js"] },
        tools: { peek: { tier: "read" }, look: { tier: "read" }, note: { tier: "write" } },
      },
    });
    const fixtures: FixtureServer[] = [];
    const mcp = await startMcpSession({
      governanceRoot: root,
      workspaceRoot: root,
      createTransport: fxServer(fixtures),
    });
    const asked: ApprovalRequest[] = [];
    const sessionId = newSessionId();
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({
        replies: [
          toolCall("mcp__fx__echo", { message: "hi" }),
          toolCall("mcp__fx__peek"),
          toolCall("mcp__fx__look"),
          toolCall("mcp__fx__note", { text: "n1" }),
          { text: "完成" },
        ],
      }),
      workspaceRoot: root,
      homeDir: root,
      sessionId,
      yolo: false,
      provider: "fake-provider",
      modelId: "fake-model-1",
      mcp,
      createApprovalHandler: () => async (request) => {
        asked.push(request);
        return { approved: true };
      },
    });
    try {
      const result = await bundle.adapter.run("用 MCP 工具");
      assert.equal(result.failure, null);
      assert.ok(result.advertisedTools.includes("mcp__fx__note"));
    } finally {
      await disposeRuntime(bundle);
    }
    assert.deepEqual(
      asked.map((request) => request.toolName),
      ["mcp__fx__echo", "mcp__fx__peek", "mcp__fx__note"]
    );
    assert.deepEqual(
      fixtures[0]?.calls.map((call) => call.name),
      ["echo", "peek", "look", "note"]
    );

    const session = materializeSession(join(root, ".pigeon", "sessions"), sessionId);
    const started = session.runStarteds[0]?.payload;
    const byName = new Map((started?.mcpTools ?? []).map((entry) => [entry.name, entry]));
    assert.deepEqual(byName.get("mcp__fx__echo"), {
      name: "mcp__fx__echo",
      server: "fx",
      tool: "echo",
      configuredTier: "write",
      effectiveTier: "write",
      declaredHint: { readOnlyHint: true },
      conflict: true,
    });
    assert.deepEqual(byName.get("mcp__fx__peek"), {
      name: "mcp__fx__peek",
      server: "fx",
      tool: "peek",
      configuredTier: "read",
      effectiveTier: "write",
      declaredHint: { destructiveHint: true },
      conflict: true,
    });
    assert.deepEqual(byName.get("mcp__fx__look"), {
      name: "mcp__fx__look",
      server: "fx",
      tool: "look",
      configuredTier: "read",
      effectiveTier: "read",
      declaredHint: { readOnlyHint: true },
    });
    assert.deepEqual(byName.get("mcp__fx__note"), {
      name: "mcp__fx__note",
      server: "fx",
      tool: "note",
      configuredTier: "write",
      effectiveTier: "write",
    });
    assert.deepEqual(started?.mcpServers, [{ name: "fx", state: "connected", restarts: 0 }]);

    // write 档三次调用 intent / receipt 齐全；read 档无 receipt
    assert.equal(session.receipts.length, 3);
    const noteIntent = session.intents.find((intent) => intent.toolName === "mcp__fx__note");
    assert.deepEqual(noteIntent?.rawArgs, { text: "n1" });
    const noteReceipt = session.receipts.find(
      (receipt) => receipt.toolCallId === noteIntent?.toolCallId
    );
    assert.equal(noteReceipt?.executed, true);
    assert.equal(noteReceipt?.mcp?.server, "fx");
    assert.equal(noteReceipt?.mcp?.tool, "note");
    assert.equal(noteReceipt?.mcp?.argsHash, sha256Hex(canonicalJson(noteIntent?.rawArgs)));
    assert.equal(noteReceipt?.mcp?.resultSummary, "noted");
    assert.deepEqual(noteReceipt?.mcp?.serverEvidence?.value, { path: "notes.txt", sha: "abc" });
    assert.ok(noteReceipt?.mcp?.structuredHash !== undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP 接线：server 掉线后核心 Run 照跑，MCP 调用报环境错误，下个 Run 的 run.started 记 server 不可用", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-mcp-e2e-"));
  try {
    writeFileSync(join(root, "a.txt"), "alpha\n");
    writeMcpConfig(root, {
      fx: { launch: { command: "node", args: ["fixture.js"] }, tools: { look: { tier: "read" } } },
    });
    const fixtures: FixtureServer[] = [];
    const mcp = await startMcpSession({
      governanceRoot: root,
      workspaceRoot: root,
      createTransport: fxServer(fixtures),
      maxRestarts: 0,
    });
    const sessionId = newSessionId();
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({
        replies: [
          { text: "第一轮完成" },
          toolCall("mcp__fx__look"),
          toolCall("read_file", { path: "a.txt" }),
          { text: "第二轮完成" },
        ],
      }),
      workspaceRoot: root,
      homeDir: root,
      sessionId,
      yolo: false,
      provider: "fake-provider",
      modelId: "fake-model-1",
      mcp,
      createApprovalHandler: () => async () => ({ approved: true }),
    });
    let second: Awaited<ReturnType<typeof bundle.adapter.run>>;
    try {
      await bundle.adapter.run("第一轮");
      await fixtures[0]?.drop();
      await Promise.all(mcp.connections.map((connection) => connection.idle()));
      second = await bundle.adapter.run("第二轮");
    } finally {
      await disposeRuntime(bundle);
    }
    assert.equal(second.failure, null);
    assert.equal(mcp.connections[0]?.state, "closed");

    const session = materializeSession(join(root, ".pigeon", "sessions"), sessionId);
    assert.deepEqual(
      session.runStarteds.map((record) => record.payload.mcpServers?.[0]?.state),
      ["connected", "unavailable"]
    );
    const settled = session.runtimeEvents.flatMap((record) =>
      record.kind === "tool.settled" ? [record.payload] : []
    );
    assert.deepEqual(
      settled.map((payload) => [payload.toolName, payload.isError, payload.errorKind]),
      [
        ["mcp__fx__look", true, "environment"],
        ["read_file", false, undefined],
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP 接线：没有 MCP 配置时会话为空，run.started 不带 MCP 字段，核心 Run 不受影响", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-mcp-e2e-"));
  try {
    const mcp = await startMcpSession({ governanceRoot: root, workspaceRoot: root });
    assert.deepEqual(mcp.tools, []);
    assert.deepEqual(mcp.summary(), { mcpTools: [], mcpServers: [] });
    const sessionId = newSessionId();
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({ replies: [{ text: "完成" }] }),
      workspaceRoot: root,
      homeDir: root,
      sessionId,
      yolo: false,
      provider: "fake-provider",
      modelId: "fake-model-1",
      mcp,
      createApprovalHandler: () => async () => ({ approved: true }),
    });
    try {
      await bundle.adapter.run("你好");
    } finally {
      await disposeRuntime(bundle);
    }
    const started = materializeSession(join(root, ".pigeon", "sessions"), sessionId).runStarteds[0]
      ?.payload;
    assert.ok(started !== undefined);
    assert.equal(started.mcpTools, undefined);
    assert.equal(started.mcpServers, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
