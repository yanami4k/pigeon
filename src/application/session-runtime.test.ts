// 会话运行面装配（决策 067）：cli 与 tui 共用一份——作用域（worker 会话回到其工作树与委派策略）、
// grant 种子、MCP 启动、运行面构建。装配失败时先关掉已启动的 MCP server 再上抛（先建后换语义不变）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

function fakeMcp(): { session: McpSession; closed: () => boolean } {
  let closed = false;
  const session: McpSession = {
    tools: [],
    prompts: [],
    problems: ["server x 启动失败"],
    connections: [],
    summary: () => ({ mcpTools: [], mcpServers: [] }),
    close: async () => {
      closed = true;
    },
  };
  return { session, closed: () => closed };
}

test("装配失败：先关掉已启动的 MCP server 再上抛（畸形 grants.json 属治理配置 fail-closed）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-runtime-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(join(root, ".pigeon", "grants.json"), "{ 这不是 JSON");
    const mcp = fakeMcp();
    await assert.rejects(() =>
      openSessionRuntime({
        governanceRoot: root,
        sessionId: newSessionId(),
        streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
        flags: { yolo: false, provider: "custom", modelId: "custom", persistThinking: true },
        startMcp: async () => mcp.session,
      })
    );
    assert.equal(mcp.closed(), true, "装配失败必须关闭已启动的 MCP server");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("成功路径：返回运行面与作用域，MCP 启动提示交给调用方呈现", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-runtime-ok-"));
  try {
    const mcp = fakeMcp();
    const notes: string[] = [];
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId: newSessionId(),
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: async () => mcp.session,
      onMcpNote: (note) => notes.push(note),
    });
    try {
      assert.equal(opened.scope.workspaceRoot, root, "主会话的工作区根即治理根");
      const snapshot = opened.bundle.adapter.snapshot();
      assert.equal(snapshot.model.provider, "custom");
      assert.equal(snapshot.model.id, "custom");
      assert.deepEqual(notes, ["server x 启动失败"], "启动问题如实交给调用方");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    assert.equal(mcp.closed(), true, "释放运行面时一并关闭 MCP 会话");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
