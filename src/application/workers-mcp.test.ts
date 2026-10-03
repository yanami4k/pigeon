// worker 的 MCP 会话（M5.7 S4，决策 054）：worker 运行面按其工作树启动自己的 MCP server——roots 广告为 worker
// 工作树路径；装配是异步的，订阅先于就绪也不丢事件；MCP 写工具经汇聚审批放行并执行（工具结果上挂审批闸标记）；
// worker 会话文件头记工作树；释放时关闭 server 连接。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createFixtureServer, type FixtureServer } from "../mcp/fixtures.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { McpConfig } from "../state/mcp-config.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import { type McpSession, startMcpSession } from "./mcp.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

const CONFIG: McpConfig = {
  servers: [
    {
      name: "fx",
      launch: { command: "node", args: ["x.js"] },
      launchSource: "settings",
      defaultTier: "write",
      tools: {},
    },
  ],
};

test("worker 的 MCP 会话：按工作树启动，roots 为工作树路径；订阅先于就绪不丢事件；写工具经审批放行并执行；释放关闭连接", async () => {
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
    assert.equal(handle.summary(), "完成");
    await handle.dispose();
    assert.equal(sessions[0]?.connections[0]?.state, "closed");
    const worker = loadSessionView(join(root, ".pigeon", "state", "sessions"), sessionId);
    assert.ok(worker !== undefined);
    // 写档 MCP 工具经审批放行并执行：worker 会话里唯一的调用有结果、未出错，审批闸标记为人工批准
    const calls = worker.runs.flatMap((run) => run.toolCalls);
    assert.deepEqual(
      calls.map((call) => [call.toolName, call.result?.isError]),
      [["mcp__fx__note", false]]
    );
    const noteResult = calls[0]?.result;
    assert.ok(noteResult !== undefined);
    assert.deepEqual(toolResultMark(noteResult.raw as unknown as StoreMessage)?.gate, {
      outcome: "approved",
      approvedBy: "human",
    });
    assert.ok(
      JSON.stringify(noteResult.blocks).includes("noted"),
      JSON.stringify(noteResult.blocks)
    );
    const headerWorkspace = worker.worker?.workspace;
    assert.equal(
      headerWorkspace?.kind === "git-worktree" ? headerWorkspace.path : undefined,
      workspacePath
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
