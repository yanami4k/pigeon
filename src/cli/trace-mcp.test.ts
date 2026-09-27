// trace 的 MCP 投影（M5.7 S3，决策 052）：trace 的 Run 头列出注解与配置冲突、不可用的 server 与工具清单变更通知，
// 来源是 Run 开始条目里的 MCP 工具集与 server 状态。replay 旧有的回执 mcp 块摘要随写操作回执停写（184）不再有来源。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { runTraceCommand } from "./trace.ts";

test("trace Run 头列出 MCP 冲突、不可用 server 与清单变更", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-mcp-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const session = createFixtureSession({ sessionsDir });
    session.startRun({
      task: "用 mcp",
      config: {
        policy: { allow: ["mcp__fx__echo"], deny: [], approvalMode: "prompt" },
        advertisedTools: ["mcp__fx__echo", "mcp__fx__peek", "mcp__fx__look"],
        mcpTools: [
          {
            name: "mcp__fx__echo",
            server: "fx",
            tool: "echo",
            configuredTier: "write",
            effectiveTier: "write",
            declaredHint: { readOnlyHint: true },
            conflict: true,
          },
          {
            name: "mcp__fx__peek",
            server: "fx",
            tool: "peek",
            configuredTier: "read",
            effectiveTier: "write",
            declaredHint: { destructiveHint: true },
            conflict: true,
          },
          {
            name: "mcp__fx__look",
            server: "fx",
            tool: "look",
            configuredTier: "read",
            effectiveTier: "read",
            declaredHint: { readOnlyHint: true },
          },
        ],
        mcpServers: [
          {
            name: "fx",
            state: "unavailable",
            restarts: 2,
            error: "连接断开",
            listChanges: [{ list: "tools", at: 5 }],
          },
        ],
      },
    });
    session.endRun();
    const { sessionId } = await session.close();

    const trace = runTraceCommand({ root, sessionId });
    assert.ok(
      trace.includes(
        "  MCP 工具集冲突：mcp__fx__echo（声明只读，配置 write，按 write）、mcp__fx__peek（声明 destructive，配置 read，按 write）"
      ),
      trace
    );
    assert.ok(!trace.includes("mcp__fx__look（"), trace);
    assert.ok(trace.includes("  MCP server fx 不可用（重启 2 次：连接断开）"), trace);
    assert.ok(
      trace.includes("  MCP server fx 发来工具清单变更通知 1 次（本会话不变，下个会话生效）"),
      trace
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
