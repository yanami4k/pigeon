// 运行面写会话存储（决策 206 起）：Adapter 把每条 message_end 的完整消息、每个 Run 的开始（本次配置与系统提示全文）
// 与收尾（结束方式）写进会话存储。写入面出错不中断运行，异常只进内部错误清单。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { createToolGovernance } from "../application/governance.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { locateSessionFile, readSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { newGrantId, newSessionId } from "../state/ids.ts";
import {
  type RunEndData,
  type RunStartData,
  type SessionCustomEntry,
  SessionEntryType,
} from "../state/session-entries.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn, createGate, type FakeReply } from "./fixtures.ts";
import type { AgentTool } from "./governance.ts";
import type { AgentMessage } from "./index.ts";
import { openSessionStoreWriter, type SessionStoreSink } from "./session-store.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

const SYSTEM_PROMPT = "你是 Pigeon 测试助手。\n第二行";

function snapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1", maxOutputTokens: 1024 },
    tools: {
      policy: { allow: ["echo"], deny: [], approvalMode: "yolo" },
      advertised: [],
    },
    context: { systemPrompt: SYSTEM_PROMPT, taskDirective: "只改需要改的" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
    repairRounds: 2,
  };
}

const echoTool: AgentTool = {
  name: "echo",
  label: "echo",
  description: "原样返回",
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id, params) => ({
    content: [{ type: "text", text: (params as { text: string }).text }],
    details: undefined,
  }),
};

function governance() {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "原样返回",
    parameters: Type.Object({ text: Type.String() }),
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  return createToolGovernance({ registry });
}

type Captured =
  | { kind: "message"; message: AgentMessage }
  | { kind: "entry"; entry: SessionCustomEntry };

function captureSink(): { sink: SessionStoreSink; captured: Captured[] } {
  const captured: Captured[] = [];
  return {
    captured,
    sink: {
      appendMessage: (message) => captured.push({ kind: "message", message }),
      append: (entry) => captured.push({ kind: "entry", entry }),
    },
  };
}

function adapterWith(replies: FakeReply[], sessionStore: SessionStoreSink): PiRuntimeAdapter {
  return new PiRuntimeAdapter({
    snapshot: snapshot(),
    streamFn: createFakeStreamFn({ replies }),
    governance: governance(),
    tools: [echoTool],
    sessionStore,
  });
}

test("写会话存储：Run 开始带本次配置与系统提示全文，完整消息按序写，Run 收尾带结束方式与消息条数", async () => {
  const { sink, captured } = captureSink();
  const adapter = adapterWith(
    [{ text: "调工具", toolCalls: [{ name: "echo", args: { text: "回声" } }] }, { text: "完成" }],
    sink
  );
  const result = await adapter.run("做事");
  assert.equal(result.status, "completed");
  assert.deepEqual(
    captured.map((item) =>
      item.kind === "message" ? item.message.role : (item.entry.customType as string)
    ),
    [
      SessionEntryType.RunStart,
      "user",
      "assistant",
      "toolResult",
      "assistant",
      SessionEntryType.RunEnd,
    ]
  );
  const start = (captured[0] as { entry: { data: RunStartData } }).entry.data;
  assert.equal(start.runId, result.runId);
  assert.equal(start.systemPrompt, SYSTEM_PROMPT);
  assert.equal(start.taskDirective, "只改需要改的");
  assert.equal(start.repairRounds, 2);
  assert.deepEqual(start.advertisedTools, ["echo"]);
  assert.deepEqual(start.policy, { allow: ["echo"], deny: [], approvalMode: "yolo" });
  assert.deepEqual(start.model, {
    provider: "fake-provider",
    id: "fake-model-1",
    thinkingLevel: "off",
    maxOutputTokens: 1024,
  });
  assert.equal("stepStart" in start, false, "这一步起点不进 Run 开始条目");
  assert.equal("structuredMemory" in start, false);
  assert.equal("systemPromptHash" in start, false);
  // 消息与 transcript 逐条一致（完整消息，含工具调用参数、用量与停止原因）
  const messages = captured.flatMap((item) => (item.kind === "message" ? [item.message] : []));
  assert.deepEqual(messages, adapter.transcript());
  // 上游 agent-loop 构造工具结果消息时恒带 usage 键，工具不报用量即为 undefined：写入前必须剥掉，否则上游序列化拒绝整条
  const toolResult = messages.find((message) => message.role === "toolResult") as
    | Record<string, unknown>
    | undefined;
  assert.ok(toolResult !== undefined && Object.hasOwn(toolResult, "usage"));
  assert.equal(toolResult.usage, undefined);
  const end = (captured.at(-1) as { entry: { data: RunEndData } }).entry.data;
  assert.equal(end.runId, result.runId);
  assert.equal(end.ending, "completed");
  assert.equal(end.stopReason, "stop");
  assert.equal(end.messageCount, 4);
  await adapter.dispose();
});

test("写会话存储：撞上限的一方带原因中止，收尾条目一次写全结束方式；不带原因的中止记为中止", async () => {
  for (const cause of ["turn-limit", "wall-clock-limit", "token-limit", undefined] as const) {
    const gate = createGate();
    const { sink, captured } = captureSink();
    const adapter = adapterWith([{ text: "慢慢说", chunkSize: 1, chunkGate: gate }], sink);
    const running = adapter.run("说话");
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stopping = adapter.interrupt(cause);
    gate.open();
    await stopping;
    const result = await running;
    assert.equal(result.status, "aborted");
    const end = (captured.at(-1) as { entry: { data: RunEndData } }).entry.data;
    assert.equal(end.ending, cause ?? "aborted");
    assert.equal(end.stopReason, "aborted");
    await adapter.dispose();
  }
});

test("写会话存储：中止原因只管当前 Run，下一个 Run 不继承", async () => {
  const gate = createGate();
  const { sink, captured } = captureSink();
  const adapter = adapterWith([{ text: "慢慢说", chunkSize: 1, chunkGate: gate }], sink);
  const first = adapter.run("一");
  gate.release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const stopping = adapter.interrupt("turn-limit");
  gate.open();
  await stopping;
  await first;
  await adapter.run("二");
  const ends = captured.flatMap((item) =>
    item.kind === "entry" && item.entry.customType === SessionEntryType.RunEnd
      ? [(item.entry.data as RunEndData).ending]
      : []
  );
  assert.deepEqual(ends, ["turn-limit", "completed"]);
  await adapter.dispose();
});

test("写会话存储：模型出错收尾记为出错，带错误文本", async () => {
  const { sink, captured } = captureSink();
  const adapter = adapterWith([{ text: "", streamError: "上游 500" }], sink);
  const result = await adapter.run("做事");
  assert.equal(result.status, "failed");
  const end = (captured.at(-1) as { entry: { data: RunEndData } }).entry.data;
  assert.equal(end.ending, "error");
  assert.equal(end.stopReason, "error");
  assert.equal(end.errorMessage, "上游 500");
  await adapter.dispose();
});

test("写会话存储：熔断中止的 Run 记为熔断", async () => {
  const { sink, captured } = captureSink();
  const adapter = new PiRuntimeAdapter({
    snapshot: snapshot(),
    streamFn: createFakeStreamFn({
      replies: [{ text: "调", toolCalls: [{ name: "echo", args: { text: "x" } }] }],
    }),
    // 首次调用即落闸的治理桩
    governance: (host) => {
      let tripped = false;
      return {
        beginRun: () => {
          tripped = false;
        },
        decide: async () => {
          tripped = true;
          host.abort();
          return { kind: "block", reason: "熔断" };
        },
        governs: () => true,
        decisionOf: () => undefined,
        settle: () => {},
        runOutcome: () => ({ breakerTripped: tripped, toolExecutions: [] }),
        toolExecutions: () => [],
      };
    },
    tools: [echoTool],
    sessionStore: sink,
  });
  const result = await adapter.run("做事");
  assert.equal(result.status, "aborted");
  const end = (captured.at(-1) as { entry: { data: RunEndData } }).entry.data;
  assert.equal(end.ending, "breaker");
  await adapter.dispose();
});

test("写会话存储：写入面抛错不中断运行，运行事件与对话照常，异常进内部错误清单", async () => {
  const broken: SessionStoreSink = {
    appendMessage: () => {
      throw new Error("消息写坏了");
    },
    append: () => {
      throw new Error("条目写坏了");
    },
  };
  const adapter = adapterWith([{ text: "好" }], broken);
  const result = await adapter.run("做事");
  assert.equal(result.status, "completed");
  // 对话一条不缺（用户消息与助手回复）
  assert.deepEqual(
    adapter.transcript().map((message) => message.role),
    ["user", "assistant"]
  );
  // 归一化与对外转发一个都不缺
  assert.deepEqual(
    adapter.events().map((event) => event.kind),
    ["turn.started", "turn.completed", "run.ended"]
  );
  assert.ok(adapter.listenerErrors().some((error) => String(error).includes("消息写坏了")));
  assert.ok(adapter.listenerErrors().some((error) => String(error).includes("条目写坏了")));
  await adapter.dispose();
});

test("写会话存储：接真实写者，文件里每个 Run 的开始、消息与收尾按序写全，消息与 transcript 同序同数", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-store-"));
  const sessionsDir = join(root, ".pigeon", "state", "sessions");
  const sessionId = newSessionId();
  const store = openSessionStoreWriter({
    sessionsRoot: sessionsDir,
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
  });
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: snapshot(),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "调", toolCalls: [{ name: "echo", args: { text: "x" } }] },
          { text: "好" },
        ],
      }),
      governance: governance(),
      tools: [echoTool],
      sessionId,
      sessionStore: store,
    });
    const first = await adapter.run("一");
    const second = await adapter.run("二");
    await adapter.dispose();
    await store.close();
    const view = readSessionFile(locateSessionFile(sessionsDir, sessionId)?.path ?? "");
    assert.ok(view !== undefined);
    const kinds = view.entries.map((entry) =>
      entry.type === "custom" ? String(entry.customType) : "message"
    );
    // 两个 Run 各自开始、消息、收尾，顺序严格（第一轮带一次工具调用共 4 条消息，第二轮 2 条）
    assert.deepEqual(kinds, [
      SessionEntryType.RunStart,
      "message",
      "message",
      "message",
      "message",
      SessionEntryType.RunEnd,
      SessionEntryType.RunStart,
      "message",
      "message",
      SessionEntryType.RunEnd,
    ]);
    // 按 Run 读回：归属、结束方式与消息角色都和运行结果一致，消息总序与 transcript 相同
    const loaded = loadStoreSession(sessionsDir, sessionId);
    assert.ok(loaded !== undefined);
    assert.deepEqual(
      loaded.view.runs.map((run) => [run.runId, run.end?.ending, run.end?.messageCount]),
      [
        [first.runId, "completed", 4],
        [second.runId, "completed", 2],
      ]
    );
    assert.deepEqual(
      loaded.view.runs.flatMap((run) => run.messages.map(({ message }) => message.role)),
      adapter.transcript().map((message) => message.role)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("收尾：Run 以异常结束（上游抛错）也写收尾条目，结束方式记出错并带异常文本；settled 等到收尾条目交出之后", async () => {
  const { sink, captured } = captureSink();
  const adapter = adapterWith([{ text: "不会用到" }], sink);
  // 没有任何消息时上游 continue 直接抛错
  await assert.rejects(adapter.continueRun());
  await adapter.settled();
  const last = captured.at(-1);
  assert.equal(last?.kind, "entry");
  const entry = (last as { entry: { customType: string; data: RunEndData } }).entry;
  assert.equal(entry.customType, SessionEntryType.RunEnd);
  assert.equal(entry.data.ending, "error");
  assert.ok((entry.data.errorMessage ?? "").length > 0);
  assert.equal(entry.data.messageCount, 0);
  await adapter.dispose();
});

test("工具结果消息的 details 带上错误归类与审批闸决定：执行出错的归类、上游拦截记域错误、固化规则放行记 policy:config", async () => {
  const registry = new ToolRegistry();
  for (const [name, tier] of [
    ["echo", "read"],
    ["boom", "write"],
    ["ruled", "write"],
  ] as const) {
    registry.register({
      name,
      description: name,
      parameters: Type.Object({ text: Type.String() }),
      tier,
      pathConfinement: { kind: "workspace" },
      executionMode: "sequential",
    });
  }
  const tool = (name: string, execute: AgentTool["execute"]): AgentTool => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({ text: Type.String() }),
    execute,
  });
  const environmentError = Object.assign(new Error("磁盘满了"), {
    pigeonToolErrorKind: "environment",
  });
  const { sink, captured } = captureSink();
  const adapter = new PiRuntimeAdapter({
    snapshot: {
      ...snapshot(),
      tools: {
        policy: { allow: ["echo", "boom", "ruled"], deny: [], approvalMode: "yolo" },
        advertised: [],
      },
    },
    streamFn: createFakeStreamFn({
      replies: [
        {
          text: "调",
          toolCalls: [
            { name: "echo", args: { text: "回声" } },
            { name: "boom", args: { text: "x" } },
            { name: "ruled", args: { text: "y" } },
            { name: "nope", args: {} },
          ],
        },
        { text: "完成" },
      ],
    }),
    governance: createToolGovernance({
      registry,
      configGrants: [
        {
          tool: "ruled",
          promotedFrom: {
            grantId: newGrantId(),
            sessionId: newSessionId(),
            firstCall: { toolCallId: "tc-0", args: {} },
            promotedAt: 1,
          },
        },
      ],
    }),
    tools: [
      echoTool,
      tool("boom", async () => {
        throw environmentError;
      }),
      tool("ruled", async () => ({
        content: [{ type: "text", text: "ok" }],
        details: { kept: 1 },
      })),
    ],
    sessionStore: sink,
  });
  await adapter.run("做事");
  const results = new Map(
    captured.flatMap((item) =>
      item.kind === "message" && item.message.role === "toolResult"
        ? [
            [
              item.message.toolName,
              item.message as unknown as { details?: Record<string, unknown> },
            ],
          ]
        : []
    )
  );
  const mark = (name: string) => results.get(name)?.details?.pigeon;
  assert.deepEqual(mark("echo"), { gate: { outcome: "approved", approvedBy: "policy:yolo" } });
  assert.deepEqual(mark("boom"), {
    errorKind: "environment",
    gate: { outcome: "approved", approvedBy: "policy:yolo" },
  });
  assert.deepEqual(mark("ruled"), { gate: { outcome: "approved", approvedBy: "policy:config" } });
  // 工具自己的 details 保留
  assert.equal(results.get("ruled")?.details?.kept, 1);
  // 上游拦截（幽灵工具名）：审批闸没跑过，记域错误、无决定
  assert.deepEqual(mark("nope"), { errorKind: "domain" });
  // 交给 Agent 的对话与写进会话存储的是同一份消息
  const messages = captured.flatMap((item) => (item.kind === "message" ? [item.message] : []));
  assert.deepEqual(messages, adapter.transcript());
  await adapter.dispose();
});

test("续跑：restoreMessages 以还原的消息作为对话上下文接着跑；跑过 Run 之后不能再还原", async () => {
  const { sink } = captureSink();
  const adapter = adapterWith([{ text: "接着说" }], sink);
  adapter.restoreMessages([
    { role: "user", content: [{ type: "text", text: "上次的问题" }], timestamp: 1 },
  ] as AgentMessage[]);
  const result = await adapter.continueRun();
  assert.equal(result.status, "completed");
  assert.deepEqual(
    adapter.transcript().map((message) => message.role),
    ["user", "assistant"]
  );
  assert.throws(() => adapter.restoreMessages([]), /之前还原/);
  await adapter.dispose();
});
