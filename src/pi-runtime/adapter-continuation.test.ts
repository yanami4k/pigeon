// 撞上限续跑（决策 367、376）：末条回复因输出上限截断且没有工具调用时，同一个 Run 里追加提示接着跑；连续与每次 Run 合计
// 各有上限，用尽照原样收尾。按原因分开：单纯撞上限的截断正文留在上下文与主分支上、提示从断处接着写；流式重复检测掐断的
// 从上下文去掉、会话文件里照留但移出主分支，提示直接发工具调用，其轮数与用量按续跑条目加回统计。两种情况按主分支还原的上下文
// 都与续跑请求的上下文一致。本 Run 轮间压缩过时续跑请求用压缩后的上下文；中止请求在任何空档里都让续跑停下
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { createToolGovernance } from "../application/governance.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { locateSessionFile, readSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { newSessionId } from "../state/ids.ts";
import {
  OMP_REPETITION_PARAMS,
  TRUNCATION_CONTINUE_PROMPT,
  TRUNCATION_RESUME_PROMPT,
} from "../state/runaway-config.ts";
import { type SessionCustomEntry, SessionEntryType } from "../state/session-entries.ts";
import { storeRunMetrics } from "../state/session-judge.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter, type PiRuntimeAdapterOptions } from "./adapter.ts";
import { ContextCompactor, resolveCompactionConfig } from "./compaction.ts";
import { createFakeStreamFn, type FakeReply } from "./fixtures.ts";
import type { AgentTool } from "./governance.ts";
import type { AgentMessage } from "./index.ts";
import {
  openSessionStoreWriter,
  restoreSessionContext,
  type SessionStoreSink,
} from "./session-store.ts";
import { INJECTION_SNAPSHOT_VERSION } from "./snapshot.ts";

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

function adapterWith(replies: FakeReply[], extra: Partial<PiRuntimeAdapterOptions>) {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "原样返回",
    parameters: Type.Object({ text: Type.String() }),
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  const streamFn = createFakeStreamFn({ replies });
  const adapter = new PiRuntimeAdapter({
    snapshot: {
      version: INJECTION_SNAPSHOT_VERSION,
      model: { provider: "fake-provider", id: "fake-model-1" },
      tools: { policy: { allow: ["echo"], deny: [], approvalMode: "yolo" }, advertised: [] },
      context: { systemPrompt: "测试" },
      memory: [],
      skills: [],
      createdAt: 1700000000000,
    },
    streamFn,
    governance: createToolGovernance({ registry }),
    tools: [echoTool],
    ...extra,
  });
  return { adapter, streamFn };
}

const TRUNCATED: FakeReply = { text: "写了一半的计划", stopReason: "length" };
const CALL: FakeReply = { text: "调", toolCalls: [{ name: "echo", args: { text: "x" } }] };
const textOf = (value: unknown) => JSON.stringify(value) ?? "";

test("连续上限：每条都截断时请求 1 + 连续上限次后照原样收尾（completed、停止原因 length）", async () => {
  const { adapter, streamFn } = adapterWith([TRUNCATED], {
    truncationContinuation: { maxConsecutive: 2, maxPerRun: 5 },
  });
  const result = await adapter.run("做事");
  assert.equal(streamFn.calls.length, 3);
  assert.equal(result.status, "completed");
  assert.equal(result.stopReason, "length");
  await adapter.dispose();
});

test("合计上限：中间有正常回复即连续次数清零，但一个 Run 合计续跑到上限后照原样收尾", async () => {
  // 截断、调工具交替：前三次截断各续跑一次（连续次数被工具调用清零），第四次截断时合计已到 3，收尾
  const { adapter, streamFn } = adapterWith(
    [TRUNCATED, CALL, TRUNCATED, CALL, TRUNCATED, CALL, TRUNCATED, { text: "用不到" }],
    { truncationContinuation: { maxConsecutive: 2, maxPerRun: 3 } }
  );
  const result = await adapter.run("做事");
  assert.equal(streamFn.calls.length, 7);
  assert.equal(result.stopReason, "length");
  // 下一个 Run 重新计数
  assert.equal((await adapter.run("再来")).stopReason, "stop");
  await adapter.dispose();
});

const REPEATING: FakeReply = { text: `开头${"再读一遍文件。".repeat(60)}`, chunkSize: 30 };
// 逐条消息的角色与内容（续跑请求的上下文与按主分支还原的上下文比对用）
const shapeOf = (messages: readonly unknown[]) =>
  messages.map((message) => {
    const { role, content } = message as { role: string; content: unknown };
    return [role, textOf(content)];
  });

describe.each([
  {
    cause: "output-limit",
    first: TRUNCATED,
    guard: undefined,
    kept: true,
    prompt: TRUNCATION_RESUME_PROMPT,
    main: [SessionEntryType.RunStart, "user", "assistant", SessionEntryType.Continuation],
  },
  {
    cause: "repetition",
    first: REPEATING,
    guard: { mode: "abort" as const, params: OMP_REPETITION_PARAMS },
    kept: false,
    prompt: TRUNCATION_CONTINUE_PROMPT,
    main: [
      SessionEntryType.RunStart,
      "user",
      SessionEntryType.Repetition,
      SessionEntryType.Continuation,
    ],
  },
])("续跑按原因分开：$cause", ({ cause, first, guard, kept, prompt, main }) => {
  test("截断的正文留不留在续跑请求里、提示各异；主分支还原的上下文与续跑请求一致；轮数与用量与逐轮事件一致", async () => {
    const root = mkdtempSync(join(tmpdir(), "pigeon-continuation-"));
    const sessionsDir = join(root, "sessions");
    const sessionId = newSessionId();
    const store = openSessionStoreWriter({
      sessionsRoot: sessionsDir,
      sessionId,
      cwd: root,
      lock: acquireSessionFileLock,
    });
    try {
      const { adapter, streamFn } = adapterWith([first, { text: "改好了" }], {
        sessionId,
        sessionStore: store,
        truncationContinuation: { maxConsecutive: 2, maxPerRun: 5 },
        ...(guard !== undefined ? { repetitionGuard: guard } : {}),
      });
      const result = await adapter.run("做事");
      assert.equal(result.status, "completed");
      assert.equal(result.stopReason, "stop");
      assert.equal(adapter.events().filter((event) => event.kind === "run.ended").length, 1);
      assert.equal(streamFn.calls.length, 2);
      const truncatedText = first.text.slice(0, 4);
      const sent = streamFn.calls[1]?.context.messages ?? [];
      assert.equal(textOf(sent).includes(truncatedText), kept);
      const last = textOf(sent.at(-1));
      assert.ok(last.includes(prompt));
      assert.ok(!last.includes(kept ? TRUNCATION_CONTINUE_PROMPT : TRUNCATION_RESUME_PROMPT));
      await adapter.dispose();
      await store.close();

      // 会话文件照留截断的回复；主分支上留不留它按原因
      const file = readSessionFile(locateSessionFile(sessionsDir, sessionId)?.path ?? "");
      assert.ok(file?.entries.some((entry) => textOf(entry.message).includes(truncatedText)));
      const loaded = loadStoreSession(sessionsDir, sessionId);
      assert.ok(loaded !== undefined);
      assert.deepEqual(
        loaded.main.map((entry) =>
          entry.type === "custom" ? entry.customType : (entry.message as { role: string }).role
        ),
        [...main, "user", "assistant", SessionEntryType.RunEnd]
      );
      const continuation = loaded.main.find(
        (entry) => entry.customType === SessionEntryType.Continuation
      )?.data as Record<string, unknown> | undefined;
      assert.equal(continuation?.cause, cause);
      assert.equal(continuation?.replyKept, kept ? true : undefined);
      assert.equal(continuation?.droppedUsage !== undefined, !kept);

      // 续跑重放：按主分支还原的上下文以续跑请求的上下文为前缀
      const restored = restoreSessionContext(loaded.main).messages;
      assert.deepEqual(shapeOf(restored.slice(0, sent.length)), shapeOf(sent));

      // 轮数与用量：与运行中逐轮发出的事件一致（移出主分支的按续跑条目加回，留着的不重复计）
      const completed = adapter.events().filter((event) => event.kind === "turn.completed");
      const metrics = storeRunMetrics(loaded.view);
      assert.equal(metrics.turns, completed.length);
      assert.equal(
        metrics.usage.totalTokens,
        completed.reduce(
          (sum, event) =>
            sum + ((event.payload as { usage?: { totalTokens: number } }).usage?.totalTokens ?? 0),
          0
        )
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("重复检测掐断的回复交给续跑：命中记一条（判据、通道、模式），其后是续跑记录", async () => {
  const entries: SessionCustomEntry[] = [];
  const { adapter, streamFn } = adapterWith([REPEATING, { text: "改好了" }], {
    sessionStore: { appendMessage: () => {}, append: (entry) => entries.push(entry) },
    truncationContinuation: { maxConsecutive: 2, maxPerRun: 5 },
    repetitionGuard: { mode: "abort", params: OMP_REPETITION_PARAMS },
  });
  const result = await adapter.run("做事");
  assert.equal(result.stopReason, "stop");
  assert.equal(streamFn.calls.length, 2);
  const kinds = entries.map((entry) => entry.customType);
  assert.deepEqual(kinds, [
    SessionEntryType.RunStart,
    SessionEntryType.Repetition,
    SessionEntryType.Continuation,
    SessionEntryType.RunEnd,
  ]);
  const [, hit] = entries;
  assert.equal(hit?.customType, SessionEntryType.Repetition);
  assert.deepEqual(
    hit?.customType === SessionEntryType.Repetition
      ? [hit.data.criterion, hit.data.channel, hit.data.mode]
      : [],
    ["cycle", "text", "abort"]
  );
  await adapter.dispose();
});

test("截断的回复落定时来了中止请求：不续跑，照原样收尾", async () => {
  const { adapter, streamFn } = adapterWith([TRUNCATED, { text: "用不到" }], {
    truncationContinuation: { maxConsecutive: 2, maxPerRun: 5 },
  });
  adapter.subscribe((event) => {
    if (event.kind === "turn.completed") void adapter.interrupt();
  });
  await adapter.run("做事");
  assert.equal(streamFn.calls.length, 1);
  await adapter.dispose();
});

// 轮间压缩：第一轮带工具调用、上下文 5000 超过触发点 1000，第二轮之前压缩（第二次请求是摘要），第三轮的回复被截断
const LONG_TASK = `请修好 a.ts 里的空指针，${"细节说明。".repeat(80)}`;
const COMPACTING: FakeReply[] = [
  { text: "", toolCalls: [{ name: "echo", args: { text: "ok" } }], contextTokens: 5000 },
  { text: "## Goal\n修空指针" },
  { text: "写了一半", stopReason: "length", contextTokens: 300 },
  { text: "修好了", contextTokens: 300 },
];

function compacting(
  sink?: (store: SessionStoreSink, adapter: () => PiRuntimeAdapter) => SessionStoreSink
) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-continuation-compaction-"));
  const sessionId = newSessionId();
  const store = openSessionStoreWriter({
    sessionsRoot: join(root, "sessions"),
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
  });
  const streamFn = createFakeStreamFn({ replies: COMPACTING });
  const compaction = new ContextCompactor({
    config: resolveCompactionConfig({ thresholdTokens: 1000, keepRecentTokens: 5 }),
    streamFn,
    model: {
      id: "fake-model-1",
      name: "fake-model-1",
      api: "anthropic-messages",
      provider: "fake-provider",
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 1024,
    },
  });
  const ref: { adapter?: PiRuntimeAdapter } = {};
  const { adapter } = adapterWith([{ text: "用不到" }], {
    streamFn,
    sessionId,
    sessionStore: sink !== undefined ? sink(store, () => ref.adapter as PiRuntimeAdapter) : store,
    compaction,
    truncationContinuation: { maxConsecutive: 2, maxPerRun: 5 },
  });
  ref.adapter = adapter;
  return {
    adapter,
    streamFn,
    cleanup: async () => {
      await adapter.dispose();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("本 Run 轮间压缩过：续跑请求用压缩后的上下文（以摘要开头、不再带被摘要的历史），带着截断的正文，末尾是接续提示", async () => {
  const h = compacting();
  try {
    const result = await h.adapter.run(LONG_TASK);
    assert.equal(result.stopReason, "stop");
    assert.equal(h.streamFn.calls.length, 4);
    const sent: AgentMessage[] = (h.streamFn.calls[3]?.context.messages ?? []) as AgentMessage[];
    assert.ok(textOf(sent[0]).includes("The conversation history before this point was compacted"));
    assert.ok(!textOf(sent).includes("细节说明。细节说明。"));
    assert.ok(textOf(sent.at(-2)).includes("写了一半"));
    assert.ok(textOf(sent.at(-1)).includes(TRUNCATION_RESUME_PROMPT));
  } finally {
    await h.cleanup();
  }
});

test("续跑前按会话树还原期间来了中止请求：续跑照常发起再立即中止，这次 Run 以中止收尾", async () => {
  let armed = false;
  const h = compacting((store, adapter) => ({
    appendMessage: (message) => store.appendMessage(message),
    append: (entry) => store.append(entry),
    appendCompaction: (result) => store.appendCompaction?.(result) ?? Promise.resolve(undefined),
    dropTruncatedReply: () => store.dropTruncatedReply?.(),
    branch: async () => {
      if (armed) {
        armed = false;
        await adapter().interrupt();
      }
      return store.branch?.();
    },
  }));
  h.adapter.subscribe((event) => {
    if ((event.payload as { stopReason?: string }).stopReason === "length") armed = true;
  });
  try {
    const result = await h.adapter.run(LONG_TASK);
    assert.equal(result.status, "aborted");
  } finally {
    await h.cleanup();
  }
});

test("移出截断的回复时，它之后挂的自定义条目重写到退回后的叶子上，仍在主分支上", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-continuation-trailing-"));
  const sessionsDir = join(root, "sessions");
  const sessionId = newSessionId();
  const store = openSessionStoreWriter({
    sessionsRoot: sessionsDir,
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
  });
  try {
    store.appendMessage({ role: "user", content: [{ type: "text", text: "做事" }], timestamp: 1 });
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "写了一半" }],
      api: "unknown",
      provider: "fake",
      model: "fake",
      usage: {
        input: 0,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "length",
      timestamp: 2,
    });
    store.append({
      customType: SessionEntryType.Hook,
      data: {
        version: 1,
        event: "Notification",
        command: "true",
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        conclusion: "notify",
      },
    });
    store.dropTruncatedReply?.();
    await store.close();
    const loaded = loadStoreSession(sessionsDir, sessionId);
    assert.deepEqual(
      loaded?.main.map((entry) =>
        entry.type === "custom" ? entry.customType : (entry.message as { role: string }).role
      ),
      ["user", SessionEntryType.Hook]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
