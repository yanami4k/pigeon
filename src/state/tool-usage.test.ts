// 工具结果里的模型用量（决策 289）：web_fetch 的提炼等在工具执行中另发的模型请求，用量写在工具结果 details 的 modelUsage 下；
// 运行指标与会话摘要把它计入总 token 与花费；形状不对的不计。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { readSessionView } from "../persistence/session-catalog.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { storeRunMetrics } from "./session-judge.ts";
import { summarizeSessionView } from "./session-view.ts";
import { addTurnUsage, TOOL_RESULT_USAGE_KEY, toolResultModelUsage } from "./tool-usage.ts";

const distillUsage = {
  input: 1000,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1050,
  cost: { input: 0.5, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.6 },
};

test("details 里的 modelUsage 读取：形状对才认；累加就地修改", () => {
  assert.deepEqual(toolResultModelUsage({ [TOOL_RESULT_USAGE_KEY]: distillUsage }), distillUsage);
  assert.equal(toolResultModelUsage({ [TOOL_RESULT_USAGE_KEY]: { input: 1 } }), undefined);
  assert.equal(toolResultModelUsage({ other: 1 }), undefined);
  assert.equal(toolResultModelUsage(undefined), undefined);
  assert.equal(toolResultModelUsage("x"), undefined);
  const target = {
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
    totalTokens: 4,
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
  };
  addTurnUsage(target, distillUsage);
  assert.equal(target.totalTokens, 1054);
  assert.equal(target.cost.total, 4.6);
});

test("运行指标与会话摘要把工具结果里的模型用量一并计入", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tool-usage-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const s = createFixtureSession({ sessionsDir, cwd: root });
    s.startRun({ task: "读网页" });
    s.toolTurn({
      name: "web_fetch",
      args: { url: "https://docs.example/a", prompt: "找什么" },
      result: "提炼结果",
      details: { url: "https://docs.example/a", [TOOL_RESULT_USAGE_KEY]: distillUsage },
    });
    s.toolTurn({ name: "read_file", args: { path: "a" }, details: { snapshot: "x" } });
    s.assistant({ text: "好了" });
    s.endRun();
    const { path, sessionId } = await s.close();
    const store = loadStoreSession(sessionsDir, sessionId);
    assert.ok(store !== undefined);
    const metrics = storeRunMetrics(store.view);
    // 三条助手消息的 usage 由夹具按内容长度给出；提炼的用量另加 1050 token 与 0.6 花费
    const assistantTokens = store.view.runs[0]?.messages
      .filter(({ message }) => message.role === "assistant")
      .reduce((sum, { message }) => sum + (message.usage?.totalTokens ?? 0), 0);
    assert.equal(metrics.usage.totalTokens, (assistantTokens ?? 0) + 1050);
    assert.equal(metrics.usage.cost.total, 0.6);
    assert.equal(metrics.turns, 3);
    const view = readSessionView({ path });
    assert.ok(view !== undefined);
    const summary = summarizeSessionView(view);
    assert.equal(summary.totalTokens, metrics.usage.totalTokens);
    assert.equal(summary.totalCost, 0.6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
