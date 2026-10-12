// 运行面的上下文压缩（决策 188、189、192、207、218）：两个触发挂点——一次 Run 内轮与轮之间、一次 Run 开始之前
// （交互中的下一条输入、回炉轮、续跑），加手动 /compact；摘要消息经上游 convertToLlm 发给模型；Run 结束后按会话树
// 重新还原一次；压缩前回调在两个挂点都被调用；Run 开始条目记下本次的压缩配置。模型请求因上下文超长出错时先压缩再重试一次
// （决策 422）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { test } from "vitest";
import { compactionNoticeText } from "../application/compaction-text.ts";
import { createToolGovernance } from "../application/governance.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import { newSessionId } from "../state/ids.ts";
import { type RunEndData, type RunStartData, SessionEntryType } from "../state/session-entries.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { type CompactionNotice, PiRuntimeAdapter } from "./adapter.ts";
import {
  type BeforeCompactionInfo,
  type CompactionConfigInput,
  ContextCompactor,
  resolveCompactionConfig,
} from "./compaction.ts";
import {
  createFakeStreamFn,
  type FakeReply,
  type FakeStreamFn,
  isContinuationSummary,
  isSummaryRequest as isSummaryContext,
} from "./fixtures.ts";
import type { AgentTool } from "./governance.ts";
import type { AgentMessage } from "./index.ts";
import { openSessionStoreWriter, type SessionStoreWriter } from "./session-store.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

const COMPACTION_PREFIX = "The conversation history before this point was compacted";
const LONG_TASK = `请修好 a.ts 里的空指针，${"细节说明。".repeat(80)}`;
// 足够长的回复：保留量设为 5 时切点落在它上面，长任务那条用户消息进待摘要段
const LONG_REPLY = "我已经读完了相关文件，接下来开始修改。".repeat(3);

// 会话文件的主分支（从根到叶），与续跑同一条读法
function mainBranch(
  sessions: string,
  sessionId: string
): Array<{ type: string } & Record<string, unknown>> {
  const located = locateSessionFile(sessions, sessionId);
  assert.ok(located !== undefined);
  const loaded = loadStoreSessionFile(located.path);
  assert.ok(loaded !== undefined);
  return loaded.main as unknown as Array<{ type: string } & Record<string, unknown>>;
}

function snapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1", maxOutputTokens: 1024 },
    tools: { policy: { allow: ["echo"], deny: [], approvalMode: "yolo" }, advertised: [] },
    context: { systemPrompt: "你是测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
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

interface Harness {
  adapter: PiRuntimeAdapter;
  streamFn: FakeStreamFn;
  store: SessionStoreWriter;
  sessions: string;
  sessionId: string;
  before: BeforeCompactionInfo[];
  notices: Array<{ trigger: string; tokensBefore: number; tokensAfter: number }>;
  // 没压成与压缩前回调失败的提示
  problems: CompactionNotice[];
  cleanup: () => Promise<void>;
}

interface HarnessFaults {
  // 摘要请求一律失败（如网关拒绝）
  failSummary?: boolean;
  // 压缩条目写不进会话文件
  failCompactionWrite?: boolean;
  // 摘要请求另用这组回复（不占主请求的回复序列）
  summaries?: FakeReply[];
}

function harness(
  replies: FakeReply[],
  config: CompactionConfigInput = { thresholdTokens: 1000, keepRecentTokens: 5 },
  beforeCompaction?: (info: BeforeCompactionInfo, adapter: PiRuntimeAdapter) => Promise<void>,
  faults: HarnessFaults = {}
): Harness {
  const root = mkdtempSync(join(tmpdir(), "pigeon-compaction-"));
  const sessions = join(root, ".pigeon", "state", "sessions");
  const sessionId = newSessionId();
  const store = openSessionStoreWriter({
    sessionsRoot: sessions,
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
  });
  const streamFn = createFakeStreamFn({ replies });
  const summaryFn =
    faults.summaries !== undefined ? createFakeStreamFn({ replies: faults.summaries }) : streamFn;
  const before: BeforeCompactionInfo[] = [];
  const ref: { adapter?: PiRuntimeAdapter } = {};
  const compactor = new ContextCompactor({
    config: resolveCompactionConfig(config),
    streamFn:
      faults.failSummary === true
        ? () => Promise.reject(new Error("网关拒绝：花费上限"))
        : summaryFn,
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
    beforeCompaction: async (info) => {
      before.push(info);
      if (beforeCompaction !== undefined && ref.adapter !== undefined) {
        await beforeCompaction(info, ref.adapter);
      }
    },
  });
  const adapter = new PiRuntimeAdapter({
    snapshot: snapshot(),
    streamFn,
    tools: [echoTool],
    governance: governance(),
    sessionId: sessionId as never,
    sessionStore:
      faults.failCompactionWrite === true
        ? {
            appendMessage: (message) => store.appendMessage(message),
            append: (entry) => store.append(entry),
            branch: () => store.branch(),
            appendCompaction: async () => undefined,
          }
        : store,
    compaction: compactor,
  });
  ref.adapter = adapter;
  const notices: Harness["notices"] = [];
  const problems: CompactionNotice[] = [];
  adapter.subscribeCompaction((notice) => {
    if (notice.kind === "compacted") {
      notices.push({
        trigger: notice.trigger,
        tokensBefore: notice.tokensBefore,
        tokensAfter: notice.tokensAfter,
      });
    } else {
      problems.push(notice);
    }
  });
  return {
    adapter,
    streamFn,
    store,
    sessions,
    sessionId,
    before,
    notices,
    problems,
    cleanup: async () => {
      await adapter.dispose();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function isSummaryRequest(call: FakeStreamFn["calls"][number]): boolean {
  return isSummaryContext(call.context);
}

function requestText(call: FakeStreamFn["calls"][number] | undefined): string {
  return JSON.stringify(call?.context.messages ?? []);
}

function roles(messages: ReadonlyArray<{ role: string }>): string[] {
  return messages.map((message) => message.role);
}

// 主分支上最后一条压缩条目记下的摘要请求发法（决策 424）
function summaryRequestOf(main: ReturnType<typeof mainBranch>): unknown {
  const entry = main.findLast((item) => item.type === "compaction") as
    | { details?: { summaryRequest?: unknown } }
    | undefined;
  return entry?.details?.summaryRequest;
}

test("轮间挂点：上下文超过触发点时在下一轮之前压缩，下一轮请求以摘要开头（经 convertToLlm 发给模型）；原始消息仍在会话文件里", async () => {
  const h = harness([
    { text: "", toolCalls: [{ name: "echo", args: { text: "ok" } }], contextTokens: 5000 },
    { text: "## Goal\n修空指针" },
    { text: "修好了", contextTokens: 300 },
  ]);
  try {
    const result = await h.adapter.run(LONG_TASK);
    assert.equal(result.status, "completed");
    assert.equal(h.streamFn.calls.length, 3);
    assert.equal(isSummaryRequest(h.streamFn.calls[1] as never), true);
    const third = h.streamFn.calls[2];
    assert.equal(isSummaryRequest(third as never), false);
    const firstMessage = JSON.stringify(third?.context.messages[0]);
    assert.ok(firstMessage.includes(COMPACTION_PREFIX), firstMessage);
    // 被摘要的那条长任务不再原样出现在压缩后的请求里
    assert.equal(requestText(third).includes("细节说明。细节说明。"), false);
    assert.deepEqual(
      h.before.map((info) => info.trigger),
      ["turn"]
    );
    assert.deepEqual(
      h.notices.map((notice) => notice.trigger),
      ["turn"]
    );
    assert.ok((h.notices[0]?.tokensBefore ?? 0) > (h.notices[0]?.tokensAfter ?? 0));
    // 决策 424：接续式——系统提示与工具同上一次主请求，消息以它的消息逐字节开头，接着是这一轮的回复与工具结果，末尾一条摘要指令
    const [first, summary] = h.streamFn.calls;
    const sent = first?.context.messages ?? [];
    assert.equal(summary?.context.systemPrompt, first?.context.systemPrompt);
    assert.deepEqual(summary?.context.tools, first?.context.tools);
    assert.equal(
      JSON.stringify(summary?.context.messages.slice(0, sent.length)),
      JSON.stringify(sent)
    );
    assert.deepEqual(roles(summary?.context.messages.slice(sent.length) ?? []), [
      "assistant",
      "toolResult",
      "user",
    ]);
    assert.ok(summary !== undefined && isContinuationSummary(summary.context));
    assert.equal(summary.options?.toolChoice, undefined);

    await h.store.flush();
    const main = mainBranch(h.sessions, h.sessionId);
    const types = main.map((entry) => entry.type);
    assert.equal(types.filter((type) => type === "compaction").length, 1);
    assert.deepEqual(summaryRequestOf(main), { mode: "continuation" });
    // 原始消息保留（179）：长任务那条用户消息仍在文件里
    assert.ok(JSON.stringify(main).includes("细节说明。细节说明。"));
  } finally {
    await h.cleanup();
  }
});

test("Run 结束后按会话树还原：运行面的对话上下文以摘要开头，下一次 Run 的请求不再带被摘要的历史", async () => {
  const h = harness([
    { text: "", toolCalls: [{ name: "echo", args: { text: "ok" } }], contextTokens: 5000 },
    { text: "## Goal\n修空指针" },
    { text: "修好了", contextTokens: 300 },
    { text: "第二问的回答", contextTokens: 400 },
  ]);
  try {
    await h.adapter.run(LONG_TASK);
    const transcript = h.adapter.transcript();
    assert.equal(transcript[0]?.role, "compactionSummary");
    assert.equal(JSON.stringify(transcript).includes("细节说明。细节说明。"), false);
    await h.adapter.run("第二问");
    const fourth = h.streamFn.calls[3];
    assert.equal(isSummaryRequest(fourth as never), false);
    assert.equal(requestText(fourth).includes("细节说明。细节说明。"), false);
    assert.ok(JSON.stringify(fourth?.context.messages[0]).includes(COMPACTION_PREFIX));
  } finally {
    await h.cleanup();
  }
});

test("Run 开始前挂点：交互中的下一条输入发出前，上下文已超过触发点即先压缩并整体替换上下文", async () => {
  const h = harness([
    { text: LONG_REPLY, contextTokens: 5000 },
    { text: "## Goal\n第一问" },
    { text: "第二问的回答", contextTokens: 300 },
  ]);
  try {
    await h.adapter.run(LONG_TASK);
    assert.equal(h.streamFn.calls.length, 1);
    await h.adapter.run("第二问");
    assert.equal(h.streamFn.calls.length, 3);
    assert.equal(isSummaryRequest(h.streamFn.calls[1] as never), true);
    const third = h.streamFn.calls[2];
    assert.ok(JSON.stringify(third?.context.messages[0]).includes(COMPACTION_PREFIX));
    assert.equal(requestText(third).includes("细节说明。细节说明。"), false);
    assert.ok(requestText(third).includes("第二问"));
    assert.deepEqual(
      h.before.map((info) => info.trigger),
      ["run-start"]
    );
    assert.deepEqual(
      h.notices.map((notice) => notice.trigger),
      ["run-start"]
    );
  } finally {
    await h.cleanup();
  }
});

test("Run 开始前挂点：续跑（continueRun，会话里还原的上下文）同样先检查并压缩", async () => {
  const h = harness([{ text: "## Goal\n续跑" }, { text: "续跑完成", contextTokens: 300 }]);
  try {
    // 续跑的真实路径：会话文件里已有的消息还原给运行面（session-runtime 的 restoreContext 同此）
    const restored: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: LONG_TASK }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: LONG_REPLY }],
        api: "anthropic-messages",
        provider: "fake-provider",
        model: "fake-model-1",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      { role: "user", content: [{ type: "text", text: "继续" }], timestamp: 3 },
    ] as AgentMessage[];
    for (const message of restored) {
      h.store.appendMessage(message);
    }
    await h.store.flush();
    h.adapter.restoreMessages(restored);
    const result = await h.adapter.continueRun();
    assert.equal(result.status, "completed");
    assert.equal(h.streamFn.calls.length, 2);
    assert.equal(isSummaryRequest(h.streamFn.calls[0] as never), true);
    assert.ok(JSON.stringify(h.streamFn.calls[1]?.context.messages[0]).includes(COMPACTION_PREFIX));
    assert.deepEqual(
      h.before.map((info) => info.trigger),
      ["run-start"]
    );
  } finally {
    await h.cleanup();
  }
});

test("convertToLlm：还原出的压缩摘要消息作为用户消息发给模型，不被静默丢掉", async () => {
  const h = harness([{ text: "好的", contextTokens: 10 }], { thresholdTokens: 900_000 });
  try {
    h.adapter.restoreMessages([
      { role: "compactionSummary", summary: "之前修过 a.ts", tokensBefore: 1000, timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "继续" }], timestamp: 2 },
    ] as AgentMessage[]);
    await h.adapter.continueRun();
    const sent = h.streamFn.calls[0]?.context.messages ?? [];
    assert.equal(sent.length, 2);
    assert.ok(JSON.stringify(sent[0]).includes("之前修过 a.ts"));
    assert.equal(sent[0]?.role, "user");
  } finally {
    await h.cleanup();
  }
});

test("未超过触发点：两个挂点都不压缩，不调压缩前回调", async () => {
  const h = harness(
    [
      { text: "", toolCalls: [{ name: "echo", args: { text: "ok" } }], contextTokens: 900 },
      { text: "完成", contextTokens: 950 },
    ],
    { thresholdTokens: 1000, keepRecentTokens: 5 }
  );
  try {
    await h.adapter.run(LONG_TASK);
    await h.adapter.run("再来");
    assert.equal(h.streamFn.calls.filter((call) => isSummaryRequest(call)).length, 0);
    assert.deepEqual(h.before, []);
    assert.deepEqual(h.notices, []);
  } finally {
    await h.cleanup();
  }
});

test("手动压缩：重点作为摘要的附加说明，替换上下文并发出一行提示；Run 进行中不接受", async () => {
  const h = harness(
    [
      { text: LONG_REPLY, contextTokens: 50 },
      { text: LONG_REPLY, contextTokens: 80 },
      { text: "## Goal\n手动" },
      { text: "后续回答", contextTokens: 60 },
    ],
    { thresholdTokens: 900_000, keepRecentTokens: 5 }
  );
  try {
    // 两问之后再压缩：第一问进历史段，切点落在第二问那一轮中间——接续式一次请求写出历史摘要与那一轮的摘要（上游是两次请求）
    await h.adapter.run(LONG_TASK);
    await h.adapter.run("第二问");
    const outcome = await h.adapter.compact("保留 a.ts 的改动");
    assert.equal(outcome.kind, "compacted");
    const summaryCalls = h.streamFn.calls.slice(2);
    assert.equal(summaryCalls.length, 1);
    assert.ok(isSummaryRequest(summaryCalls[0] as never));
    const instruction = requestText(summaryCalls[0]);
    assert.ok(instruction.includes("Additional focus: 保留 a.ts 的改动"));
    assert.ok(instruction.includes("**Turn Context (split turn):**"));
    assert.ok(instruction.includes("<turn-start>第二问</turn-start>"));
    assert.equal(h.adapter.transcript()[0]?.role, "compactionSummary");
    assert.deepEqual(
      h.notices.map((notice) => notice.trigger),
      ["manual"]
    );
    assert.deepEqual(
      h.before.map((info) => [info.trigger, info.customInstructions]),
      [["manual", "保留 a.ts 的改动"]]
    );
    const running = h.adapter.run("后续");
    await assert.rejects(h.adapter.compact(), /Run 进行中/);
    await running;
  } finally {
    await h.cleanup();
  }
});

test("Run 开始前压缩期间被中断：这次 Run 以中止收尾，不照常开跑", async () => {
  const h = harness(
    [
      { text: LONG_REPLY, contextTokens: 5000 },
      { text: "## Goal\n不该用上的摘要" },
      { text: "不该出现的回答", contextTokens: 300 },
    ],
    { thresholdTokens: 1000, keepRecentTokens: 5 },
    async (_info, adapter) => {
      await adapter.interrupt();
    }
  );
  try {
    await h.adapter.run(LONG_TASK);
    const result = await h.adapter.run("第二问");
    assert.equal(result.status, "aborted");
    assert.equal(JSON.stringify(h.adapter.transcript()).includes("不该出现的回答"), false);
  } finally {
    await h.cleanup();
  }
});

test("Run 开始条目记下本次的压缩配置（窗口、预留、保留量、触发点）", async () => {
  const h = harness([{ text: "好", contextTokens: 10 }], {
    thresholdTokens: 30_000,
    keepRecentTokens: 4000,
  });
  try {
    await h.adapter.run("你好");
    await h.store.flush();
    const start = mainBranch(h.sessions, h.sessionId).find(
      (entry) =>
        entry.type === "custom" &&
        (entry as { customType?: string }).customType === SessionEntryType.RunStart
    ) as unknown as { data: RunStartData };
    assert.deepEqual(start.data.compaction, {
      contextWindow: 1_000_000,
      contextWindowSource: "default",
      reserveTokens: 16_384,
      keepRecentTokens: 4000,
      thresholdTokens: 30_000,
    });
    assert.deepEqual(roles(h.adapter.transcript()), ["user", "assistant"]);
  } finally {
    await h.cleanup();
  }
});

test("自动压缩未完成（摘要请求失败）：提示一行未完成，本轮按原上下文继续；不计入会话记录写入失败", async () => {
  const h = harness(
    [
      { text: "", toolCalls: [{ name: "echo", args: { text: "ok" } }], contextTokens: 5000 },
      { text: "修好了", contextTokens: 300 },
    ],
    { thresholdTokens: 1000, keepRecentTokens: 5 },
    undefined,
    { failSummary: true }
  );
  try {
    const result = await h.adapter.run(LONG_TASK);
    assert.equal(result.status, "completed");
    assert.equal(h.streamFn.calls.length, 2);
    assert.ok(requestText(h.streamFn.calls[1]).includes("细节说明。细节说明。"));
    assert.deepEqual(
      h.problems.map((notice) => [notice.kind, notice.trigger]),
      [["incomplete", "turn"]]
    );
    const problem = h.problems[0];
    assert.ok(problem?.kind === "incomplete" && problem.outcome.kind === "failed");
    assert.match(String(problem.outcome.error), /网关拒绝/);
    assert.deepEqual(h.notices, []);
    assert.equal(h.adapter.listenerErrors().length, 0);
  } finally {
    await h.cleanup();
  }
});

test("压缩前回调失败：提示一行回调失败，压缩照常完成；不计入会话记录写入失败", async () => {
  const h = harness(
    [
      { text: LONG_REPLY, contextTokens: 5000 },
      { text: "## Goal\n第一问" },
      { text: "第二问的回答", contextTokens: 300 },
    ],
    { thresholdTokens: 1000, keepRecentTokens: 5 },
    async () => {
      throw new Error("复盘失败：记忆文件被锁");
    }
  );
  try {
    await h.adapter.run(LONG_TASK);
    await h.adapter.run("第二问");
    assert.deepEqual(
      h.problems.map((notice) => [notice.kind, notice.trigger]),
      [["hook-failed", "run-start"]]
    );
    assert.deepEqual(
      h.notices.map((notice) => notice.trigger),
      ["run-start"]
    );
    assert.equal(h.adapter.listenerErrors().length, 0);
  } finally {
    await h.cleanup();
  }
});

test("压缩条目写不进会话文件：提示一行未完成，仍计入会话记录写入失败", async () => {
  const h = harness(
    [
      { text: LONG_REPLY, contextTokens: 5000 },
      { text: "## Goal\n第一问" },
      { text: "第二问的回答", contextTokens: 300 },
    ],
    { thresholdTokens: 1000, keepRecentTokens: 5 },
    undefined,
    { failCompactionWrite: true }
  );
  try {
    await h.adapter.run(LONG_TASK);
    await h.adapter.run("第二问");
    assert.deepEqual(
      h.problems.map((notice) => [notice.kind, notice.trigger]),
      [["incomplete", "run-start"]]
    );
    assert.equal(h.adapter.listenerErrors().length, 1);
    assert.ok(requestText(h.streamFn.calls[2]).includes("细节说明。细节说明。"));
  } finally {
    await h.cleanup();
  }
});

// 决策 422：上游识别函数认得的超长报错（各家 SDK 的写法：状态码开头）；一般的 400 文案不算
const OVERFLOW = "400 Input length (265330) exceeds model's maximum context length (262144).";
const FIRST: FakeReply = { text: LONG_REPLY, contextTokens: 10 };
const TOO_LONG: FakeReply = { text: "", streamError: OVERFLOW };

// 第一问正常答完，第二问的请求超长出错；摘要请求另用一组回复
async function secondAsk(replies: FakeReply[], faults: HarnessFaults = {}) {
  const h = harness([FIRST, ...replies], undefined, undefined, {
    summaries: [{ text: "## Goal\n第一问" }],
    ...faults,
  });
  await h.adapter.run(LONG_TASK);
  return { h, result: await h.adapter.run("第二问") };
}

test("超长出错（决策 422）：先压缩（压缩前回调、压缩条目、提示），再以压缩后的上下文重试一次即成功；出错消息不再发给模型、照留在会话文件里", async () => {
  const { h, result } = await secondAsk([TOO_LONG, { text: "答", contextTokens: 300 }]);
  try {
    assert.equal(result.status, "completed");
    const retry = h.streamFn.calls[2];
    assert.ok(JSON.stringify(retry?.context.messages[0]).includes(COMPACTION_PREFIX));
    assert.ok(requestText(retry).includes("第二问"));
    assert.equal(requestText(retry).includes("maximum context length"), false);
    assert.deepEqual(
      [...h.before, ...h.notices].map((item) => item.trigger),
      ["overflow", "overflow"]
    );
    await h.store.flush();
    const branch = mainBranch(h.sessions, h.sessionId);
    // 决策 424：超长触发走独立式
    assert.deepEqual(summaryRequestOf(branch), { mode: "standalone", reason: "overflow" });
    const main = JSON.stringify(branch);
    assert.equal(main.split('"type":"compaction"').length - 1, 1);
    assert.ok(main.includes("maximum context length"));
  } finally {
    await h.cleanup();
  }
});

test("超长出错：重试的那次仍超长即按原错误收尾，不再压缩；之后来过正常回复再超长，算新的一次", async () => {
  const again = await secondAsk([TOO_LONG]);
  await again.h.cleanup();
  assert.equal(again.result.status, "failed");
  assert.equal(again.result.errorMessage, OVERFLOW);
  assert.equal(again.h.streamFn.calls.length, 3);
  // 不再尝试压缩：没有第二次压缩前回调，也没有"没压成"的提示
  assert.equal(again.h.before.length, 1);
  assert.deepEqual(again.h.problems, []);
  const echo: FakeReply = { text: "", toolCalls: [{ name: "echo", args: { text: "ok" } }] };
  const later = await secondAsk([TOO_LONG, echo, TOO_LONG, { text: "完成" }]);
  await later.h.cleanup();
  assert.equal(later.result.status, "completed");
  assert.equal(later.h.before.length, 2);
});

test("超长出错而压缩没压成（摘要请求失败）：不重试，按原错误收尾，Run 收尾条目记下没压成的阶段与原因", async () => {
  const { h, result } = await secondAsk([TOO_LONG], { failSummary: true });
  try {
    assert.equal(result.status, "failed");
    assert.equal(result.errorMessage, OVERFLOW);
    assert.equal(h.streamFn.calls.length, 2);
    const [problem] = h.problems;
    assert.ok(problem?.kind === "incomplete" && problem.trigger === "overflow");
    assert.match(compactionNoticeText(problem), /网关拒绝.*按原错误收尾/);
    await h.store.flush();
    const end = mainBranch(h.sessions, h.sessionId).findLast(
      (entry) => (entry as { customType?: string }).customType === SessionEntryType.RunEnd
    ) as unknown as { data: RunEndData };
    assert.deepEqual([end.data.ending, end.data.errorMessage], ["error", OVERFLOW]);
    assert.ok(end.data.overflowCompaction?.kind === "failed");
    assert.equal(end.data.overflowCompaction.stage, "summary");
    assert.match(end.data.overflowCompaction.error, /网关拒绝/);
  } finally {
    await h.cleanup();
  }
});

test("一般的 400（不是超长的报错文案）不压缩、不重试", async () => {
  const { h, result } = await secondAsk([
    { text: "", streamError: "400 messages: text content blocks must be non-empty" },
  ]);
  await h.cleanup();
  assert.equal(result.status, "failed");
  assert.equal(h.streamFn.calls.length, 2);
  assert.deepEqual(h.before, []);
});
