// normalizePiEvent 纯函数单元测试：不经过真实 Agent，直接构造上游 AgentEvent。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { newRunId, newSessionId } from "../state/ids.ts";
import { RuntimeEventKind, type ToolProposedPayload } from "../state/runtime-events.ts";
import { normalizePiEvent } from "./events.ts";

test("tool_execution_start：args 被深拷贝，事后修改源事件不回溯污染归一化 payload", () => {
  const sourceArgs = { path: "src/a.ts", nested: { lines: [1, 2] } };
  const event: AgentEvent = {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: sourceArgs,
  };

  const normalized = normalizePiEvent(event, { sessionId: newSessionId(), runId: newRunId() });

  assert.ok(normalized);
  assert.equal(normalized.kind, RuntimeEventKind.ToolProposed);
  const payload = normalized.payload as ToolProposedPayload;
  assert.equal(payload.toolCallId, "call-1");
  assert.equal(payload.toolName, "read");
  // 不共享引用
  assert.notEqual(payload.args, sourceArgs);
  // 归一化之后篡改源事件：payload 保持归一化时刻的内容
  sourceArgs.path = "已被篡改";
  sourceArgs.nested.lines.push(3);
  assert.deepEqual(payload.args, { path: "src/a.ts", nested: { lines: [1, 2] } });
});
