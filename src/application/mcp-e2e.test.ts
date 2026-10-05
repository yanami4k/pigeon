// MCP 治理接线端到端（M5.7 S3，决策 051 / 052 / 053）：真实装配根 + 内存传输夹具 server + fake streamFn。
// 注解与配置冲突落 Run 开始条目；声明只读但配置（或缺省）write 的工具与声明 destructive 但配置 read 的工具
// 都走审批，配置 read 且无冲突的自动放行；审批决定挂在工具结果上，MCP 调用的来源与结构化内容在工具结果 details 里；
// server 掉线后核心 Run 照跑，MCP 调用报环境错误，下个 Run 的开始条目记 server 不可用。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { test } from "vitest";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { createFixtureServer, type FixtureServer } from "../mcp/fixtures.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import { mcpConfigOf } from "../state/settings.ts";
import { startMcpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

// 决策 325：MCP 风险档写在项目共享设置的 mcp 一节，经设置快照取用（用户级指到空的临时目录，不碰真实的家目录）
function writeMcpConfig(root: string, servers: Record<string, unknown>): void {
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  writeFileSync(join(root, ".pigeon", "settings.json"), JSON.stringify({ mcp: { servers } }));
}

function mcpConfigAt(root: string) {
  const home = mkdtempSync(join(tmpdir(), "pigeon-mcp-home-"));
  try {
    return mcpConfigOf(loadSettings(root, { homeDir: home }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

// 读会话存储里本会话的视图
function loadView(root: string, sessionId: string) {
  const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(loaded !== undefined, "会话存储里应有本会话");
  return loaded.view;
}

function messagesOf(view: ReturnType<typeof loadView>): StoreMessage[] {
  return view.runs.flatMap((run) => run.messages.map((ref) => ref.message));
}

function textOf(message: StoreMessage | undefined): string {
  return Array.isArray(message?.content)
    ? (message.content as Array<{ type: string; text?: string }>)
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("")
    : "";
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { text: `调用 ${name}`, toolCalls: [{ name, args }] };
}

test("MCP 接线：冲突落 Run 开始条目；声明只读或未配置、声明 destructive 配 read 的工具走审批，read 档自动放行；工具结果带 MCP 来源", async () => {
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
      config: mcpConfigAt(root),
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

    const view = loadView(root, sessionId);
    assert.equal(view.runs.length, 1);
    const started = view.runs[0]?.start;
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

    // write 档三次调用经人工批准，read 档一次自动放行：审批决定挂在各自的工具结果上
    const messages = messagesOf(view);
    const toolResults = messages.filter((message) => message.role === "toolResult");
    assert.deepEqual(
      toolResults.map((message) => [
        message.toolName,
        message.isError,
        toolResultMark(message)?.gate,
      ]),
      [
        ["mcp__fx__echo", false, { outcome: "approved", approvedBy: "human" }],
        ["mcp__fx__peek", false, { outcome: "approved", approvedBy: "human" }],
        ["mcp__fx__look", false, { outcome: "approved", approvedBy: "policy:auto" }],
        ["mcp__fx__note", false, { outcome: "approved", approvedBy: "human" }],
      ]
    );
    // note 调用的原始参数在助手消息的工具调用块里
    const noteResult = toolResults.find((message) => message.toolName === "mcp__fx__note");
    const noteCall = messages
      .flatMap((message) =>
        message.role === "assistant" && Array.isArray(message.content)
          ? (message.content as Array<{ type: string; id?: string; arguments?: unknown }>)
          : []
      )
      .find((block) => block.type === "toolCall" && block.id === noteResult?.toolCallId);
    assert.deepEqual(noteCall?.arguments, { text: "n1" });
    // MCP 来源与结构化内容在工具结果 details 里，结果正文为外部内容标记（决策 379，单元层测）加 server 返回的文本
    const details = noteResult?.details as
      | { server?: string; tool?: string; structuredContent?: { evidence?: unknown } }
      | undefined;
    assert.equal(details?.server, "fx");
    assert.equal(details?.tool, "note");
    assert.ok(textOf(noteResult).endsWith("\nnoted"), textOf(noteResult));
    assert.deepEqual(details?.structuredContent?.evidence, { path: "notes.txt", sha: "abc" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP 接线：server 掉线后核心 Run 照跑，MCP 调用报环境错误，下个 Run 的开始条目记 server 不可用", async () => {
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
      config: mcpConfigAt(root),
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

    const view = loadView(root, sessionId);
    assert.deepEqual(
      view.runs.map((run) => run.start.mcpServers?.[0]?.state),
      ["connected", "unavailable"]
    );
    const toolResults = messagesOf(view).filter((message) => message.role === "toolResult");
    assert.deepEqual(
      toolResults.map((message) => [
        message.toolName,
        message.isError,
        toolResultMark(message)?.errorKind,
      ]),
      [
        ["mcp__fx__look", true, "environment"],
        ["read_file", false, undefined],
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP 接线：没有 MCP 配置时会话为空，Run 开始条目不带 MCP 字段，核心 Run 不受影响", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-mcp-e2e-"));
  try {
    const mcp = await startMcpSession({
      governanceRoot: root,
      workspaceRoot: root,
      config: mcpConfigAt(root),
    });
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
    const started = loadView(root, sessionId).runs[0]?.start;
    assert.ok(started !== undefined);
    assert.equal(started.mcpTools, undefined);
    assert.equal(started.mcpServers, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
