// 决策 430：续跑时所用模型与最后一个 Run 记下的不同，按新模型重建系统提示；相同照旧逐字节沿用（363）。
// 旧记录没有模型信息时照旧沿用，见 status-channel.test.ts 的旧会话续跑
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

test("续跑换了模型：系统提示按新模型重建；再用同一模型续跑，逐字节沿用重建后的那份", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-prompt-model-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-prompt-model-home-"));
  const sessionId = newSessionId();
  const promptWith = async (modelId: string, resume: boolean): Promise<string> => {
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn,
      flags: { yolo: true, provider: "deepseek", modelId, persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
      ...(resume ? { resume: true } : {}),
    });
    try {
      await opened.bundle.adapter.run("你好");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    return streamFn.calls[0]?.context.systemPrompt ?? "";
  };
  try {
    const flash = await promptWith("deepseek-flash", false);
    assert.match(flash, /^You are Pigeon, a coding agent powered by the deepseek-flash model\./);
    assert.equal(await promptWith("deepseek-flash", true), flash, "同一模型续跑逐字节沿用");
    const pro = await promptWith("deepseek-pro", true);
    assert.match(pro, /^You are Pigeon, a coding agent powered by the deepseek-pro model\./);
    assert.equal(pro, flash.replace("deepseek-flash", "deepseek-pro"), "只有模型名变了");
    assert.equal(await promptWith("deepseek-pro", true), pro, "重建后的那份照旧沿用");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
