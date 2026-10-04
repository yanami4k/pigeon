// MCP 启动提示（M5.7，决策 052）：注解与配置冲突除记进 run.started 外，启动时进程内同时警告；启动问题（server 起不来、
// 映射跳过、prompt 不登记）一并给出。Actor 只负责把这些行打出去。
import assert from "node:assert/strict";
import { test } from "vitest";
import { describeMcpStartup } from "./mcp.ts";

test("MCP 启动提示：启动问题原样列出，注解与配置冲突逐项警告，无冲突无问题时为空", () => {
  const notes = describeMcpStartup({
    problems: ["MCP server fs 启动失败：spawn ENOENT（本会话不暴露其工具）"],
    summary: () => ({
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
        },
      ],
      mcpServers: [],
    }),
  });
  assert.deepEqual(notes, [
    "MCP server fs 启动失败：spawn ENOENT（本会话不暴露其工具）",
    "MCP 注解与配置冲突：mcp__fx__echo 声明只读，配置 write，按 write 执行",
    "MCP 注解与配置冲突：mcp__fx__peek 声明 destructive，配置 read，按 write 执行",
  ]);
  assert.deepEqual(
    describeMcpStartup({ problems: [], summary: () => ({ mcpTools: [], mcpServers: [] }) }),
    []
  );
});
