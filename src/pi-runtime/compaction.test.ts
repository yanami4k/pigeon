// 压缩服务（决策 188、189、218、192、207）：配置缺省与校验、阈值判定、上下文 token 估算（压缩后的旧 usage 不算）、
// 摘要请求经给定的模型接入、待摘要段为空不调模型、压缩前回调先于摘要请求且失败不阻断。
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type AgentMessage,
  type CompactResult,
  createCompactionSummaryMessage,
  type Entry,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type CompactionStore,
  ContextCompactor,
  contextTokens,
  DEFAULT_CONTEXT_WINDOW,
  exceedsThreshold,
  resolveCompactionConfig,
  summaryModels,
} from "./compaction.ts";
import { createFakeStreamFn } from "./fixtures.ts";

function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function assistant(text: string, timestamp: number, totalTokens: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "fake",
    model: "fake",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as AgentMessage;
}

// 内存里的会话树：按序追加，读分支即全部条目
function memoryStore(messages: AgentMessage[]): CompactionStore & {
  entries: Entry[];
  appended: CompactResult[];
} {
  const entries: Entry[] = messages.map(
    (message, index) =>
      ({
        type: "message",
        id: `e${index}`,
        parentId: index === 0 ? null : `e${index - 1}`,
        seq: index + 1,
        timestamp: message.timestamp,
        message,
      }) as Entry
  );
  const appended: CompactResult[] = [];
  return {
    entries,
    appended,
    branch: async () => [...entries],
    appendCompaction: async (result) => {
      appended.push(result);
      const last = entries.at(-1);
      entries.push({
        type: "compaction",
        id: `c${appended.length}`,
        parentId: last?.id ?? null,
        seq: entries.length + 1,
        timestamp: Date.now(),
        summary: result.summary,
        retainedTail: result.retainedTail,
        tokensBefore: result.tokensBefore,
        details: result.details,
      } as Entry);
      return [...entries];
    },
  };
}

function summaryModel(maxTokens = 16_384): Model<Api> {
  return {
    id: "fake-model",
    name: "fake-model",
    api: "anthropic-messages",
    provider: "fake",
    baseUrl: "",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens,
  };
}

// 一段足够长、能切出待摘要段的对话：保留量设小，只留最后一问
function longConversation(): AgentMessage[] {
  return [
    user("第一件事：请修 a.ts 里的空指针".repeat(20), 1),
    assistant("已修好 a.ts".repeat(20), 2, 0),
    user("第二件事：把 b.ts 的日志改成中文".repeat(20), 3),
    assistant("已改好 b.ts".repeat(20), 4, 0),
    // 最后一问本身就超过保留量：切点落在它上面，不切开一轮，只发一次摘要请求
    user("第三件事：跑一下全部测试并汇报结果".repeat(5), 5),
  ];
}

const noop = () => {};

describe("压缩配置", () => {
  test("缺省：窗口为产品缺省 1M、预留 16384、保留 20000，触发点为窗口减预留", () => {
    assert.equal(DEFAULT_CONTEXT_WINDOW, 1_000_000);
    assert.deepEqual(resolveCompactionConfig(), {
      contextWindow: 1_000_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      thresholdTokens: 983_616,
    });
  });

  test("可配置：给定触发点与保留量即用给定的；非正整数、窗口不大于预留、触发点不小于窗口都报错", () => {
    assert.deepEqual(resolveCompactionConfig({ thresholdTokens: 30_000, keepRecentTokens: 5000 }), {
      contextWindow: 1_000_000,
      reserveTokens: 16_384,
      keepRecentTokens: 5000,
      thresholdTokens: 30_000,
    });
    assert.throws(() => resolveCompactionConfig({ thresholdTokens: 0 }), /触发点/);
    assert.throws(() => resolveCompactionConfig({ keepRecentTokens: 1.5 }), /保留量/);
    assert.throws(
      () => resolveCompactionConfig({ contextWindow: 1000, reserveTokens: 1000 }),
      /须大于预留量/
    );
    assert.throws(() => resolveCompactionConfig({ thresholdTokens: 1_000_000 }), /须小于模型窗口/);
  });
});

describe("阈值判定与 token 估算", () => {
  test("上下文 token 数大于触发点才压缩，等于触发点不压缩", () => {
    const config = resolveCompactionConfig({ thresholdTokens: 1000 });
    assert.equal(exceedsThreshold(1000, config), false);
    assert.equal(exceedsThreshold(1001, config), true);
    const defaults = resolveCompactionConfig();
    assert.equal(exceedsThreshold(983_616, defaults), false);
    assert.equal(exceedsThreshold(983_617, defaults), true);
  });

  test("估算：取最后一条正常助手消息的 usage，加其后消息按字符数除 4", () => {
    const messages = [user("你好", 1), assistant("好", 2, 5000), user("x".repeat(400), 3)];
    assert.equal(contextTokens(messages), 5000 + 100);
  });

  test("估算：压缩摘要之前产生的助手 usage 已过期，不拿来用；摘要之后的新 usage 照用", () => {
    const summary = createCompactionSummaryMessage("摘要", 900_000, 100);
    // 保留段里的助手消息带着压缩前的整段 usage
    const stale = [summary, user("保留的问题", 50), assistant("保留的回答", 60, 900_000)];
    const estimated = contextTokens(stale);
    assert.ok(estimated < 1000, `过期 usage 不应计入：${estimated}`);
    const fresh = [...stale, user("新问题", 200), assistant("新回答", 300, 7000)];
    assert.equal(contextTokens(fresh), 7000);
  });
});

describe("摘要请求的模型适配", () => {
  test("completeSimple 经给定的 streamFn 发出，调用选项原样交给它；其余方法报错", async () => {
    const streamFn = createFakeStreamFn({ replies: [{ text: "摘要" }] });
    const models = summaryModels(streamFn);
    const reply = await models.completeSimple(
      summaryModel(),
      { messages: [{ role: "user", content: "q", timestamp: 1 }] },
      { maxTokens: 123 }
    );
    assert.equal(reply.role, "assistant");
    assert.equal(streamFn.calls.length, 1);
    assert.equal(streamFn.calls[0]?.options?.maxTokens, 123);
    assert.throws(() => models.getModels(), /只实现 completeSimple/);
  });
});

describe("执行一次压缩", () => {
  test("待摘要段为空：不调用模型、不调压缩前回调、不写压缩条目", async () => {
    const streamFn = createFakeStreamFn({ replies: [{ text: "不该出现的摘要" }] });
    const before: string[] = [];
    const compactor = new ContextCompactor({
      config: resolveCompactionConfig({ thresholdTokens: 1 }),
      streamFn,
      model: summaryModel(),
      beforeCompaction: (info) => {
        before.push(info.trigger);
      },
    });
    // 只有一条用户消息：保留段就是全部，没有可摘要的
    const store = memoryStore([user("只有一问", 1)]);
    const outcome = await compactor.run(store, {
      trigger: "turn",
      tokens: 10,
      signal: new AbortController().signal,
      onHookError: noop,
    });
    assert.deepEqual(outcome, { kind: "skipped", reason: "nothing-to-summarize" });
    assert.equal(streamFn.calls.length, 0);
    assert.deepEqual(before, []);
    assert.equal(store.appended.length, 0);
  });

  test("压缩：压缩前回调先于摘要请求；摘要请求带上游摘要提示、不请求推理、输出上限取 0.8 倍预留与模型上限的较小者；写压缩条目并按会话树还原", async () => {
    const order: string[] = [];
    const base = createFakeStreamFn({ replies: [{ text: "## Goal\n修 bug" }] });
    const streamFn: typeof base = Object.assign(
      (...args: Parameters<typeof base>) => {
        order.push("summary");
        return base(...args);
      },
      { calls: base.calls }
    );
    const compactor = new ContextCompactor({
      config: resolveCompactionConfig({ thresholdTokens: 10, keepRecentTokens: 5 }),
      streamFn,
      model: summaryModel(),
      beforeCompaction: (info) => {
        order.push(`before:${info.trigger}:${info.tokens}`);
      },
    });
    const store = memoryStore(longConversation());
    const outcome = await compactor.run(store, {
      trigger: "run-start",
      tokens: 4321,
      signal: new AbortController().signal,
      onHookError: noop,
    });
    assert.equal(outcome.kind, "compacted");
    assert.deepEqual(order, ["before:run-start:4321", "summary"]);
    const call = base.calls[0];
    assert.ok(call?.context.systemPrompt?.startsWith("You are a context summarization assistant."));
    assert.equal(call?.options?.maxTokens, Math.floor(0.8 * 16_384));
    assert.equal(call?.options?.reasoning, undefined);
    assert.equal(store.appended.length, 1);
    assert.ok(store.appended[0]?.summary.startsWith("## Goal\n修 bug"));
    if (outcome.kind === "compacted") {
      assert.equal(outcome.messages[0]?.role, "compactionSummary");
      assert.equal(outcome.messages.at(-1)?.role, "user");
      assert.ok(outcome.tokensAfter < outcome.tokensBefore);
    }
  });

  test("模型输出上限小于 0.8 倍预留时，摘要请求的输出上限取模型上限", async () => {
    const streamFn = createFakeStreamFn({ replies: [{ text: "摘要" }] });
    const compactor = new ContextCompactor({
      config: resolveCompactionConfig({ thresholdTokens: 10, keepRecentTokens: 5 }),
      streamFn,
      model: summaryModel(4096),
    });
    await compactor.run(memoryStore(longConversation()), {
      trigger: "turn",
      tokens: 100,
      signal: new AbortController().signal,
      onHookError: noop,
    });
    assert.equal(streamFn.calls[0]?.options?.maxTokens, 4096);
  });

  test("手动压缩的重点作为摘要的附加说明交给上游摘要函数", async () => {
    const streamFn = createFakeStreamFn({ replies: [{ text: "摘要" }] });
    const compactor = new ContextCompactor({
      config: resolveCompactionConfig({ thresholdTokens: 10, keepRecentTokens: 5 }),
      streamFn,
      model: summaryModel(),
    });
    await compactor.run(memoryStore(longConversation()), {
      trigger: "manual",
      tokens: 100,
      customInstructions: "保留 b.ts 的改动细节",
      signal: new AbortController().signal,
      onHookError: noop,
    });
    const prompt = JSON.stringify(streamFn.calls[0]?.context.messages);
    assert.ok(prompt.includes("Additional focus: 保留 b.ts 的改动细节"));
  });

  test("压缩前回调抛错：记为内部故障，压缩照常完成", async () => {
    const streamFn = createFakeStreamFn({ replies: [{ text: "摘要" }] });
    const errors: unknown[] = [];
    const compactor = new ContextCompactor({
      config: resolveCompactionConfig({ thresholdTokens: 10, keepRecentTokens: 5 }),
      streamFn,
      model: summaryModel(),
      beforeCompaction: async () => {
        throw new Error("复盘失败");
      },
    });
    const outcome = await compactor.run(memoryStore(longConversation()), {
      trigger: "turn",
      tokens: 100,
      signal: new AbortController().signal,
      onHookError: (error) => errors.push(error),
    });
    assert.equal(outcome.kind, "compacted");
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /复盘失败/);
  });

  test("摘要请求失败：返回失败（出在摘要一步），不写压缩条目；没有存储时跳过", async () => {
    const streamFn = createFakeStreamFn({
      replies: [{ text: "摘要" }],
      failOnCall: 1,
      failureMessage: "网关拒绝",
    });
    const compactor = new ContextCompactor({
      config: resolveCompactionConfig({ thresholdTokens: 10, keepRecentTokens: 5 }),
      streamFn,
      model: summaryModel(),
    });
    const store = memoryStore(longConversation());
    const outcome = await compactor.run(store, {
      trigger: "turn",
      tokens: 100,
      signal: new AbortController().signal,
      onHookError: noop,
    });
    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.kind === "failed" ? outcome.stage : undefined, "summary");
    assert.equal(store.appended.length, 0);
    assert.deepEqual(
      await compactor.run(undefined, {
        trigger: "turn",
        tokens: 100,
        signal: new AbortController().signal,
        onHookError: noop,
      }),
      { kind: "skipped", reason: "store-unavailable" }
    );
  });
});

test("压缩条目写不进会话文件：返回失败（出在写入一步）", async () => {
  const streamFn = createFakeStreamFn({ replies: [{ text: "摘要" }] });
  const compactor = new ContextCompactor({
    config: resolveCompactionConfig({ thresholdTokens: 10, keepRecentTokens: 5 }),
    streamFn,
    model: summaryModel(),
  });
  const store = memoryStore(longConversation());
  const outcome = await compactor.run(
    { branch: store.branch, appendCompaction: async () => undefined },
    { trigger: "turn", tokens: 100, signal: new AbortController().signal, onHookError: noop }
  );
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" ? outcome.stage : undefined, "store");
});
