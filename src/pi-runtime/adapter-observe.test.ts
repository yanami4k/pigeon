// 工具结果观察口（决策 286）的故障隔离：构造通知出错（结果 details 不可克隆，如带函数）只进 listenerErrors，
// 不打断运行、不妨碍后续工具结果的转发；listener 自己抛异常同样只进 listenerErrors。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createToolGovernance } from "../application/governance.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter, type ToolResultNotice } from "./adapter.ts";
import { createFakeStreamFn } from "./fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION } from "./snapshot.ts";

function probeTool(name: string, details: unknown): AgentTool {
  return {
    name,
    label: name,
    description: `${name} 探针`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: `${name} 的结果` }], details }),
  } as unknown as AgentTool;
}

test("工具结果观察口：details 不可克隆时通知构造失败只进 listenerErrors，运行照常，后续结果照常转发", async () => {
  const registry = new ToolRegistry();
  for (const name of ["odd_tool", "plain_tool"]) {
    registry.register({
      name,
      description: name,
      parameters: Type.Object({}),
      tier: "read",
      pathConfinement: { kind: "none" },
      executionMode: "sequential",
    });
  }
  const adapter = new PiRuntimeAdapter({
    snapshot: {
      version: INJECTION_SNAPSHOT_VERSION,
      model: { provider: "fake-provider", id: "fake-model-1" },
      tools: {
        policy: { allow: ["odd_tool", "plain_tool"], deny: [], approvalMode: "yolo" },
        advertised: [],
      },
      context: { systemPrompt: "你是 Pigeon 测试助手。" },
      memory: [],
      skills: [],
      createdAt: 1700000000000,
    },
    streamFn: createFakeStreamFn({
      replies: [
        { text: "先调怪工具", toolCalls: [{ name: "odd_tool", args: {} }] },
        { text: "再调普通工具", toolCalls: [{ name: "plain_tool", args: {} }] },
        { text: "完成" },
      ],
    }),
    governance: createToolGovernance({ registry }),
    tools: [probeTool("odd_tool", { callback: () => 1 }), probeTool("plain_tool", { n: 1 })],
  });
  const notices: ToolResultNotice[] = [];
  adapter.subscribeToolResults((notice) => notices.push(notice));
  adapter.subscribeToolResults(() => {
    throw new Error("订阅方自己的故障");
  });
  try {
    const result = await adapter.run("动手");
    assert.equal(result.status, "completed");
    assert.deepEqual(
      notices.map((notice) => [notice.toolName, notice.text, (notice.details as { n?: number }).n]),
      [["plain_tool", "plain_tool 的结果", 1]]
    );
    const errors = adapter.listenerErrors();
    assert.ok(
      errors.some((error) => error instanceof Error && error.name === "DataCloneError"),
      String(errors)
    );
    assert.ok(
      errors.some((error) => error instanceof Error && error.message === "订阅方自己的故障")
    );
    assert.ok(
      adapter.events().some((event) => event.kind === "run.ended"),
      "运行走到收尾"
    );
  } finally {
    await adapter.dispose();
  }
});
