// M5 S5（决策 044）：usage 与快照摘要的投影——会话摘要算每会话总 token 与成本（会话列表呈现），
// trace 的 Run 头显示 Run 开始摘要与模型请求次数（助手消息条数），每轮显示 usage。读新会话存储：用量取自助手消息。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSessionListCommand } from "../application/session-list.ts";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { listSessionSummaries } from "../persistence/session-list.ts";
import { runTraceCommand } from "./trace.ts";

const HASH = "d".repeat(64);

function usage(input: number, output: number, cacheRead: number, total: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
  };
}

test("会话摘要合计 token 与成本并在会话列表呈现；trace Run 头显示启动快照，每轮显示 usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-usage-view-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const session = createFixtureSession({ sessionsDir });
    session.startRun({
      task: "读",
      config: {
        model: { provider: "kimi", id: "k2", thinkingLevel: "off" },
        policy: { allow: ["read_file"], deny: [], approvalMode: "prompt" },
        advertisedTools: ["read_file"],
        systemPrompt: "系统提示",
        memory: [
          { path: ".pigeon/memory/a.md", hash: HASH, bytes: 3, truncated: false, included: true },
        ],
      },
    });
    const [callId = ""] = session.assistant({
      toolCalls: [{ name: "read_file" }],
      usage: usage(120, 30, 100, 0.0031),
    });
    session.toolResult({ toolCallId: callId, toolName: "read_file", text: "内容" });
    session.assistant({ text: "好", usage: usage(200, 50, 0, 0.002) });
    session.endRun();
    const { sessionId } = await session.close();

    const [summary] = listSessionSummaries(sessionsDir);
    assert.equal(summary?.totalTokens, 500);
    assert.ok(Math.abs((summary?.totalCost ?? 0) - 0.0051) < 1e-9);

    const list = runSessionListCommand({ root });
    assert.match(list, /500 tokens {2}\$0\.0051/);

    const trace = runTraceCommand({ root, sessionId });
    const prompt = createHash("sha256").update("系统提示").digest("hex").slice(0, 12);
    assert.ok(
      trace.includes(
        `启动快照：模型 kimi/k2 ｜ 审批模式 prompt ｜ 工具 read_file ｜ Memory 1 个（注入 1） ｜ Skill 0 个 ｜ system prompt ${prompt} ｜ 模型请求 2 次`
      ),
      trace
    );
    assert.match(
      trace,
      /第 1 轮 .*tokens 输入 120 \/ 输出 30 \/ 缓存读 100 \/ 缓存写 0 ｜ \$0\.0031/
    );
    assert.match(
      trace,
      /第 2 轮 .*tokens 输入 200 \/ 输出 50 \/ 缓存读 0 \/ 缓存写 0 ｜ \$0\.0020/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
