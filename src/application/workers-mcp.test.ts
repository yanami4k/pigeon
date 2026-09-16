// worker 的 MCP 会话（M5.7 S4，决策 054）：worker 运行面按其工作树启动自己的 MCP server——roots 广告为 worker
// 工作树路径；装配是异步的，订阅先于就绪也不丢事件；MCP 写工具经汇聚审批、落 receipt；worker 会话头记工作树；
// 释放时关闭 server 连接。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createFixtureServer, type FixtureServer } from "../mcp/fixtures.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { McpConfig } from "../state/mcp-config.ts";
import { type McpSession, startMcpSession } from "./mcp.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

const CONFIG: McpConfig = {
  servers: [
    {
      name: "fx",
      launch: { command: "node", args: ["x.js"] },
      launchSource: ".pigeon/mcp.json",
      defaultTier: "write",
      tools: {},
    },
  ],
};

test("worker 的 MCP 会话：按工作树启动，roots 为工作树路径；订阅先于就绪不丢事件；写工具经审批落 receipt；释放关闭连接", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-workers-mcp-"));
  try {
    const root = join(base, "repo");
    const workspacePath = join(base, "worktree-fix-a");
    mkdirSync(root, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    const fixtures: FixtureServer[] = [];
    const sessions: McpSession[] = [];
    const asked: string[] = [];
    const factory = createWorkerRuntimeFactory({
      provider: "fake-provider",
      modelId: "fake-model-1",
      homeDir: base,
      streamFnFor: () =>
        createFakeStreamFn({
          replies: [
            { text: "写", toolCalls: [{ name: "mcp__fx__note", args: { text: "w" } }] },
            { text: "完成" },
          ],
        }),
      startMcp: async (request) => {
        const session = await startMcpSession({
          governanceRoot: request.governanceRoot,
          workspaceRoot:
            request.workspace.kind === "git-worktree"
              ? request.workspace.path
              : request.governanceRoot,
          config: CONFIG,
          createTransport: () => {
            const { fixture, clientTransport } = createFixtureServer({
              tools: [
                {
                  definition: { name: "note", inputSchema: { type: "object" } },
                  handler: () => ({ content: [{ type: "text", text: "noted" }] }),
                },
              ],
            });
            fixtures.push(fixture);
            return clientTransport;
          },
        });
        sessions.push(session);
        return session;
      },
    });
    const sessionId = newSessionId();
    const handle = factory({
      sessionId,
      name: "fix-a",
      role: "implementer",
      task: "写",
      policy: {
        allow: ["read_file", "edit_file", "mcp__fx__note"],
        deny: [],
        approvalMode: "prompt",
      },
      governanceRoot: root,
      workspace: { kind: "git-worktree", path: workspacePath, branch: "pigeon/fix-a" },
      lineage: { parentSessionId: newSessionId() },
      approvalHandler: async (request) => {
        asked.push(request.toolName);
        return { approved: true };
      },
    });
    const kinds: string[] = [];
    const unsubscribe = handle.subscribe((event) => kinds.push(event.kind));
    const result = await handle.run("写");
    unsubscribe();
    assert.equal(result.status, "completed");
    assert.deepEqual(await fixtures[0]?.listRoots(), {
      roots: [{ uri: pathToFileURL(workspacePath).href, name: basename(workspacePath) }],
    });
    assert.deepEqual(asked, ["mcp__fx__note"]);
    assert.ok(kinds.includes("tool.settled"), JSON.stringify(kinds));
    assert.equal(handle.receiptIds().length, 1);
    assert.equal(handle.summary(), "完成");
    await handle.dispose();
    assert.equal(sessions[0]?.connections[0]?.state, "closed");
    const worker = materializeSession(join(root, ".pigeon", "sessions"), sessionId);
    const headerWorkspace = worker.sessionHeader?.workspace;
    assert.equal(
      headerWorkspace?.kind === "git-worktree" ? headerWorkspace.path : undefined,
      workspacePath
    );
    assert.equal(worker.receipts[0]?.mcp?.tool, "note");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
