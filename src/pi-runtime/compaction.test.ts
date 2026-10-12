// 压缩服务（决策 188、189、218、192、207、422、424）：配置缺省与校验（窗口取运行参数、模型元数据或缺省）、阈值判定、上下文 token 估算（压缩后的旧 usage 不算）、
// 摘要请求经给定的模型接入、待摘要段为空不调模型、压缩前回调先于摘要请求且失败不阻断；接续式与独立式两种摘要请求。
import assert from "node:assert/strict";
import {
  type AgentMessage,
  type CompactResult,
  convertToLlm,
  createCompactionSummaryMessage,
  type Entry,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, test } from "vitest";
import {
  type CompactionStore,
  ContextCompactor,
  type ConversationSource,
  contextTokens,
  DEFAULT_CONTEXT_WINDOW,
  exceedsThreshold,
  resolveCompactionConfig,
  type SummaryRequestRecord,
  summaryModels,
} from "./compaction.ts";
import {
  createFakeStreamFn,
  type FakeReply,
  isContinuationSummary,
  isStandaloneSummary,
} from "./fixtures.ts";

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
  test("缺省：窗口为缺省 1M、预留 16384、保留 20000，触发点为窗口减预留", () => {
    assert.equal(DEFAULT_CONTEXT_WINDOW, 1_000_000);
    assert.deepEqual(resolveCompactionConfig(), {
      contextWindow: 1_000_000,
      contextWindowSource: "default",
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      thresholdTokens: 983_616,
    });
  });

  test("可配置：给定触发点与保留量即用给定的；非正整数、窗口不大于预留、触发点不小于窗口都报错", () => {
    assert.deepEqual(resolveCompactionConfig({ thresholdTokens: 30_000, keepRecentTokens: 5000 }), {
      contextWindow: 1_000_000,
      contextWindowSource: "default",
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

  test("窗口（决策 422）：模型元数据给了即用它，触发点随之为它减预留；显式给的优先；取不到用缺省", () => {
    const declared = { source: "declared", value: 200_000 } as const;
    assert.deepEqual(resolveCompactionConfig({}, declared), {
      contextWindow: 200_000,
      contextWindowSource: "declared",
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      thresholdTokens: 183_616,
    });
    const explicit = resolveCompactionConfig({ contextWindow: 300_000 }, declared);
    assert.deepEqual([explicit.contextWindow, explicit.contextWindowSource], [300_000, "explicit"]);
    const unknown = resolveCompactionConfig({}, { source: "unknown" });
    assert.deepEqual(
      [unknown.contextWindow, unknown.contextWindowSource],
      [DEFAULT_CONTEXT_WINDOW, "default"]
    );
    assert.throws(
      () => resolveCompactionConfig({ thresholdTokens: 200_000 }, declared),
      /须小于模型窗口（200000，来源 declared）/
    );
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

describe("摘要请求的两种发法（决策 424）", () => {
  // 原会话：系统提示、工具与按主请求转换过的消息；选项带主请求的推理档位
  function conversation(messages: AgentMessage[], tokens = 100): ConversationSource {
    return {
      tokens,
      build: () => ({
        model: summaryModel(),
        context: { systemPrompt: "原会话的系统提示", messages: convertToLlm(messages), tools: [] },
        options: { reasoning: "high" },
      }),
    };
  }

  async function compactWith(
    messages: AgentMessage[],
    replies: FakeReply[],
    input: { trigger?: "turn" | "overflow"; conversation?: ConversationSource } = {}
  ) {
    const streamFn = createFakeStreamFn({ replies });
    const store = memoryStore(messages);
    const outcome = await new ContextCompactor({
      config: resolveCompactionConfig({ thresholdTokens: 10, keepRecentTokens: 5 }),
      streamFn,
      model: summaryModel(),
    }).run(store, {
      trigger: input.trigger ?? "turn",
      tokens: 100,
      signal: new AbortController().signal,
      onHookError: noop,
      ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    });
    const kinds = streamFn.calls.map((call) =>
      isContinuationSummary(call.context)
        ? "continuation"
        : isStandaloneSummary(call.context)
          ? "standalone"
          : "?"
    );
    const result = store.appended[0];
    const record = (result?.details as { summaryRequest?: SummaryRequestRecord } | undefined)
      ?.summaryRequest;
    return { streamFn, outcome, result, record, kinds };
  }

  test("接续式：会话（系统提示、工具、消息）原样在前、末尾一条摘要指令，选项同会话另带输出上限、不带 toolChoice；切点、保留段与还原同独立式", async () => {
    // 第一条回复改过 a.ts：读改文件清单两种发法相同
    const messages = longConversation();
    const edited = messages[1] as AssistantMessage;
    messages[1] = {
      ...edited,
      content: [
        ...edited.content,
        { type: "toolCall", id: "t1", name: "edit", arguments: { path: "a.ts" } },
      ],
    };
    const source = conversation(messages);
    const continued = await compactWith(messages, [{ text: "## Goal\n接续式" }], {
      conversation: source,
    });
    const call = continued.streamFn.calls[0];
    const sent = source.build().context;
    assert.deepEqual(continued.kinds, ["continuation"]);
    assert.equal(call?.context.systemPrompt, sent.systemPrompt);
    // 工具定义原样带上：去掉或改动会让服务方换一种方式组织提示，前缀对不上
    assert.equal(JSON.stringify(call?.context.tools), JSON.stringify(sent.tools));
    assert.equal(
      JSON.stringify(call?.context.messages.slice(0, -1)),
      JSON.stringify(sent.messages)
    );
    assert.deepEqual(
      [call?.options?.reasoning, call?.options?.toolChoice, call?.options?.maxTokens],
      ["high", undefined, Math.floor(0.8 * 16_384)]
    );
    assert.deepEqual(continued.record, { mode: "continuation" });
    assert.ok(continued.result?.summary.startsWith("## Goal\n接续式"));
    assert.ok(continued.result?.summary.endsWith("<modified-files>\na.ts\n</modified-files>"));

    const standalone = await compactWith(messages, [{ text: "## Goal\n独立式" }]);
    assert.deepEqual(standalone.record, { mode: "standalone", reason: "no-conversation" });
    assert.deepEqual(continued.result?.retainedTail, standalone.result?.retainedTail);
    assert.equal(continued.result?.tokensBefore, standalone.result?.tokensBefore);
    const lists = (result: CompactResult | undefined) => {
      const { summaryRequest: _mode, ...rest } = (result?.details ?? {}) as Record<string, unknown>;
      return rest;
    };
    assert.deepEqual(lists(continued.result), lists(standalone.result));
    assert.ok(continued.outcome.kind === "compacted" && standalone.outcome.kind === "compacted");
    assert.deepEqual(continued.outcome.messages.slice(1), standalone.outcome.messages.slice(1));
  });

  test("切在一轮中间、之前没有历史：指令只要那一轮的摘要并引出它开头的话；摘要照上游补上 No prior history. 与分隔", async () => {
    const task = `长任务：${"把每个模块的日志改成中文。".repeat(30)}`;
    const messages = [
      user(task, 1),
      assistant("先读 a.ts。".repeat(10), 2, 0),
      assistant("再改 b.ts。".repeat(10), 3, 0),
      assistant("最后跑测试，全部通过。".repeat(5), 4, 0),
    ];
    const { result, kinds, streamFn } = await compactWith(
      messages,
      [{ text: "## Original Request\n改日志" }],
      { conversation: conversation(messages) }
    );
    assert.deepEqual(kinds, ["continuation"]);
    const instruction = JSON.stringify(streamFn.calls[0]?.context.messages.at(-1));
    assert.ok(instruction.includes(`<turn-start>${task.slice(0, 200)}…</turn-start>`));
    assert.ok(!instruction.includes("Create a structured context checkpoint summary"));
    assert.ok(
      result?.summary.startsWith(
        "No prior history.\n\n---\n\n**Turn Context (split turn):**\n\n## Original Request\n改日志"
      )
    );
    assert.equal(result?.retainedTail.length, 1);
  });

  test("走独立式：超长触发；整段放不下；回复里有工具调用（接续式作废，改走一次独立式）", async () => {
    const messages = longConversation();
    const text: FakeReply = { text: "## Goal\n独立式" };
    const overflow = await compactWith(messages, [text], {
      trigger: "overflow",
      conversation: conversation(messages),
    });
    assert.deepEqual(overflow.kinds, ["standalone"]);
    assert.deepEqual(overflow.record, { mode: "standalone", reason: "overflow" });
    const full = await compactWith(messages, [text], {
      conversation: conversation(messages, 1_000_000 - 100),
    });
    assert.deepEqual(full.kinds, ["standalone"]);
    assert.deepEqual(full.record, { mode: "standalone", reason: "no-room" });
    const toolCall: FakeReply = { text: "", toolCalls: [{ name: "echo", args: { text: "x" } }] };
    const misfire = await compactWith(messages, [toolCall, text], {
      conversation: conversation(messages),
    });
    assert.deepEqual(misfire.kinds, ["continuation", "standalone"]);
    assert.deepEqual(misfire.record, { mode: "standalone", reason: "tool-call" });
    assert.ok(misfire.result?.summary.startsWith("## Goal\n独立式"));
  });
});
