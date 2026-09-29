// 复盘（决策 191、192、207、221、240、242、243）：headless 的收尾复盘与压缩前复盘。
// 分叉目标为最后一条消息、位置 at；沿用原会话冻结的系统提示与工具定义；指令里的当前记忆现读；{验证结论} 按最后一次验证填；
// 只放行 read_file 与 update_memory；复盘会话的 Run 开始条目记种类与模板版本；复盘失败或撞上限不改变这一步的结果；
// 复盘上限独立于这一步的上限；压缩前复盘经压缩前回调触发、用压缩前指令；开关关掉即不推送、不注册工具、不复盘。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MEMORY_FILE_HEADER } from "../memory/learned.ts";
import { memoryFileOf } from "../memory/learned-store.ts";
import {
  branchEntries,
  locateSessionFile,
  readSessionFile,
} from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { type RunStartData, SessionEntryType } from "../state/session-entries.ts";
import { type HeadlessRunOptions, runHeadless } from "./headless.ts";

const SUMMARY_PROMPT_HEAD = "You are a context summarization assistant.";
const REFUSAL = "复盘中只能使用 read_file 与 update_memory，这次调用没有执行。";

interface LoggedMessage {
  role: string;
  content?: unknown;
  toolName?: string;
}

function textOf(message: LoggedMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

function isReview(messages: readonly LoggedMessage[]): boolean {
  return messages.some((m) => m.role === "user" && textOf(m).startsWith("【复盘 v1"));
}

// 按请求分派：摘要请求、复盘请求、干活的请求各走各的剧本；记下每次请求的系统提示、工具名与消息
function routed(input: {
  main: FakeReply[];
  review: FakeReply[];
  summary?: FakeReply[];
  reviewDelayMs?: number;
  reviewFails?: boolean;
}) {
  const main = createFakeStreamFn({ replies: input.main });
  const review = createFakeStreamFn({
    replies: input.review,
    ...(input.reviewFails === true ? { failOnCall: 1, failureMessage: "模拟复盘请求失败" } : {}),
  });
  const summary = createFakeStreamFn({ replies: input.summary ?? [{ text: "## Goal\n摘要" }] });
  const calls: Array<{
    kind: "main" | "review" | "summary";
    // 请求发往的模型号
    model: string;
    system: string;
    tools: string[];
    messages: LoggedMessage[];
  }> = [];
  const streamFn: StreamFn = async (model, context, options) => {
    const messages = context.messages as unknown as LoggedMessage[];
    const system = context.systemPrompt ?? "";
    const kind = system.startsWith(SUMMARY_PROMPT_HEAD)
      ? "summary"
      : isReview(messages)
        ? "review"
        : "main";
    calls.push({
      kind,
      model: model.id,
      system,
      tools: (context.tools ?? []).map((tool) => tool.name),
      messages: structuredClone(messages),
    });
    if (kind === "review" && input.reviewDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, input.reviewDelayMs));
    }
    return (kind === "summary" ? summary : kind === "review" ? review : main)(
      model,
      context,
      options
    );
  };
  return { streamFn, calls };
}

function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-memory-review-"));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function base(root: string, streamFn: StreamFn): HeadlessRunOptions {
  return {
    task: "给 a.txt 加一行",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn,
    yolo: true,
    homeDir: root,
    skillRoots: [],
    memoryRoots: [],
    pushedMemory: true,
  };
}

function sessionEntries(root: string, sessionId: string) {
  const located = locateSessionFile(join(root, ".pigeon", "sessions"), sessionId);
  assert.ok(located !== undefined, `会话 ${sessionId} 没有文件`);
  const loaded = loadStoreSessionFile(located.path);
  assert.ok(loaded !== undefined);
  return loaded;
}

function runStarts(root: string, sessionId: string): RunStartData[] {
  return (
    sessionEntries(root, sessionId).main as unknown as Array<{
      type: string;
      customType?: string;
      data?: unknown;
    }>
  )
    .filter((entry) => entry.type === "custom" && entry.customType === SessionEntryType.RunStart)
    .map((entry) => entry.data as RunStartData);
}

// 来源会话主分支上最后一条消息条目（条目号与序号）
function lastMessageEntry(root: string, sessionId: string): { id: string; seq: number } {
  const located = locateSessionFile(join(root, ".pigeon", "sessions"), sessionId);
  assert.ok(located !== undefined);
  const view = readSessionFile(located.path);
  assert.ok(view !== undefined);
  const last = branchEntries(view, view.lanes.get("main") ?? null).findLast(
    (entry) => entry.type === "message"
  );
  assert.ok(last !== undefined);
  return { id: last.id, seq: last.seq };
}

function messagesOf(root: string, sessionId: string): LoggedMessage[] {
  return (
    sessionEntries(root, sessionId).main as unknown as Array<{
      type: string;
      message?: LoggedMessage;
    }>
  )
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as LoggedMessage);
}

const ADD_BY_AGENT = {
  name: "update_memory",
  args: { action: "add", fact: "干活时记下的事实", refs: ["a.txt"], reason: "干活时发现" },
};

test("收尾复盘：从最后一条消息（含）分叉；沿用冻结的系统提示与工具定义；指令现读记忆；只放行两件工具；Run 开始条目记种类与模板版本", () =>
  withRoot(async (root) => {
    writeFileSync(join(root, "a.txt"), "一\n");
    const { streamFn, calls } = routed({
      main: [{ text: "先记一条", toolCalls: [ADD_BY_AGENT] }, { text: "干完了" }],
      review: [
        {
          text: "复盘",
          toolCalls: [
            { name: "edit_file", args: { path: "a.txt", old_string: "一", new_string: "二" } },
            { name: "run_command", args: { command: "echo hi" } },
            { name: "read_file", args: { path: "a.txt" } },
            {
              name: "update_memory",
              args: { action: "add", fact: "复盘记下的事实", refs: ["a.txt"], reason: "复盘看到" },
            },
          ],
        },
        { text: "记了一条" },
      ],
    });
    const result = await runHeadless(base(root, streamFn));
    assert.equal(result.status, "completed");
    assert.equal(result.reviews?.length, 1);
    const [review] = result.reviews ?? [];
    assert.equal(review?.kind, "closing");
    assert.equal(review?.status, "completed");
    assert.equal(review?.turns, 2);
    assert.ok(review?.sessionId !== undefined);
    const reviewId = review.sessionId;
    // 干活的轮数不含复盘
    assert.equal(result.turns, 2);
    // 分叉：复盘会话里原会话的消息一条不少（最后一条"干完了"也在，位置 at），其后是复盘指令
    const sourceMessages = messagesOf(root, result.sessionId);
    const reviewMessages = messagesOf(root, reviewId);
    assert.deepEqual(
      reviewMessages.slice(0, sourceMessages.length).map(textOf),
      sourceMessages.map(textOf)
    );
    assert.equal(textOf(sourceMessages.at(-1) as LoggedMessage), "干完了");
    const instruction = textOf(reviewMessages[sourceMessages.length] as LoggedMessage);
    assert.ok(instruction.startsWith("【复盘 v1】这次会话的工作已经结束。"));
    assert.ok(instruction.includes("\n验证门的最终结论：本次没有运行验证门\n"));
    // 当前记忆现读：含干活的 agent 中途记下的那条
    assert.ok(instruction.includes("- [L1] 事实：干活时记下的事实"));
    // 沿用原会话冻结的系统提示（开局时记忆为空，不含中途那条）与工具定义
    const mainCall = calls.find((call) => call.kind === "main");
    const reviewCall = calls.find((call) => call.kind === "review");
    assert.ok(mainCall !== undefined && reviewCall !== undefined);
    assert.equal(reviewCall.system, mainCall.system);
    assert.ok(!reviewCall.system.includes("干活时记下的事实"));
    assert.deepEqual(reviewCall.tools, mainCall.tools);
    assert.ok(reviewCall.tools.includes("update_memory"));
    const [sourceStart] = runStarts(root, result.sessionId);
    const [reviewStart] = runStarts(root, reviewId).slice(-1);
    assert.equal(reviewStart?.systemPrompt, sourceStart?.systemPrompt);
    // 283 补充：复盘记录写明覆盖到来源会话的哪一条记录——来源主分支上最后一条消息条目
    const lastSource = lastMessageEntry(root, result.sessionId);
    assert.deepEqual(reviewStart?.memoryReview, {
      kind: "closing",
      template: "v1",
      covers: { entryId: lastSource.id, seq: lastSource.seq },
    });
    assert.equal(sourceStart?.memoryReview, undefined);
    // 只放行两件：edit_file 与 run_command 回固定的话、没执行；read_file 与 update_memory 照常
    const results = reviewMessages.filter((m) => m.role === "toolResult");
    const byTool = new Map(results.map((m) => [m.toolName, textOf(m)]));
    assert.equal(byTool.get("edit_file"), REFUSAL);
    assert.equal(byTool.get("run_command"), REFUSAL);
    assert.ok(byTool.get("read_file")?.includes("一"));
    assert.ok(byTool.get("update_memory")?.startsWith("已新增 L2"));
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "一\n");
    assert.ok(readFileSync(memoryFileOf(root), "utf8").includes("- [L2] 事实：复盘记下的事实"));
  }));

test('收尾复盘的验证结论：通过填"通过"，未通过填回炉反馈的同一份失败摘要', () =>
  withRoot(async (root) => {
    for (const [command, expected] of [
      ["node --version", "\n验证门的最终结论：通过\n"],
      [
        'node -e "process.exit(3)"',
        '\n验证门的最终结论：未通过：验证命令：node -e "process.exit(3)"\n退出码：3\n输出末尾：\n（无输出）\n',
      ],
    ] as const) {
      const { streamFn, calls } = routed({ main: [{ text: "好了" }], review: [{ text: "不记" }] });
      const result = await runHeadless({
        ...base(root, streamFn),
        verify: { command, timeoutMs: 60_000, source: "flag" },
      });
      assert.equal(result.reviews?.[0]?.status, "completed");
      const reviewCall = calls.find((call) => call.kind === "review");
      const instruction = textOf(reviewCall?.messages.at(-1) as LoggedMessage);
      assert.ok(instruction.includes(expected), instruction);
    }
  }));

test("复盘失败不改变这一步的结果：去重告警写出，结果里记下失败原因", () =>
  withRoot(async (root) => {
    const warned: string[] = [];
    const { streamFn } = routed({
      main: [{ text: "好了" }],
      review: [{ text: "x" }],
      reviewFails: true,
    });
    const result = await runHeadless({
      ...base(root, streamFn),
      warn: (line) => warned.push(line),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.label, "Unknown");
    const [review] = result.reviews ?? [];
    assert.notEqual(review?.status, "completed");
    assert.ok(review?.error !== undefined);
    assert.equal(warned.length, 1);
    assert.ok(warned[0]?.startsWith("收尾复盘失败："));
  }));

test("复盘上限独立（一）：复盘不占这一步的轮数上限——这一步只给 1 轮，复盘照样用满自己要的轮数做完", () =>
  withRoot(async (root) => {
    const { streamFn } = routed({
      main: [{ text: "好了" }],
      review: [
        { text: "读一下", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
        { text: "不记" },
      ],
    });
    writeFileSync(join(root, "a.txt"), "一\n");
    const result = await runHeadless({
      ...base(root, streamFn),
      maxTurns: 1,
      reviewBudget: { maxTurns: 5, wallClockMs: 60_000 },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.turns, 1);
    const [review] = result.reviews ?? [];
    assert.equal(review?.status, "completed");
    assert.equal(review?.turns, 2);
  }));

test("复盘上限独立（二）：复盘撞自己的轮数上限即中止并记下、告警，这一步的结果不受影响", () =>
  withRoot(async (root) => {
    const warned: string[] = [];
    const { streamFn } = routed({
      main: [{ text: "好了" }],
      review: [{ text: "读一下", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] }],
    });
    writeFileSync(join(root, "a.txt"), "一\n");
    const result = await runHeadless({
      ...base(root, streamFn),
      maxTurns: 50,
      reviewBudget: { maxTurns: 2, wallClockMs: 60_000 },
      warn: (line) => warned.push(line),
    });
    assert.equal(result.status, "completed");
    const [review] = result.reviews ?? [];
    assert.equal(review?.status, "turn-limit");
    assert.equal(review?.hitLimit, true);
    // 撞上限那一轮之后、中止生效之前已开的一轮照样计数（与这一步的轮数上限同一口径）
    assert.ok((review?.turns ?? 0) >= 2 && (review?.turns ?? 0) <= 3, String(review?.turns));
    assert.ok(warned[0]?.startsWith("收尾复盘撞上复盘上限（轮数）"));
  }));

test("压缩前复盘：经压缩前回调触发、用压缩前指令，期间这一步的墙钟暂停；收尾复盘照常", () =>
  withRoot(async (root) => {
    writeFileSync(join(root, "a.txt"), "内容\n");
    const { streamFn, calls } = routed({
      main: [
        {
          // 足够长：保留量落在这条助手消息上，长任务那条进待摘要段，轮间即压缩
          text: "我先读一下文件。".repeat(20),
          toolCalls: [{ name: "read_file", args: { path: "a.txt" } }],
          contextTokens: 5000,
        },
        { text: "读完了", contextTokens: 300 },
      ],
      review: [{ text: "不记" }],
      reviewDelayMs: 2000,
    });
    const result = await runHeadless({
      ...base(root, streamFn),
      task: `请读 a.txt。${"背景说明。".repeat(60)}`,
      compaction: { thresholdTokens: 1000, keepRecentTokens: 20 },
      // 这一步的墙钟比压缩前复盘的耗时还短：复盘期间暂停，这一步照常完成
      wallClockMs: 1500,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(
      (result.reviews ?? []).map((review) => [review.kind, review.status]),
      [
        ["pre-compaction", "completed"],
        ["closing", "completed"],
      ]
    );
    const reviewCalls = calls.filter((call) => call.kind === "review");
    const pre = textOf(reviewCalls[0]?.messages.at(-1) as LoggedMessage);
    assert.ok(pre.startsWith("【复盘 v1·压缩前】会话还没结束"));
    assert.ok(
      pre.includes(
        "\n验证门的最终结论：会话尚未结束，暂无最终结论；以前面出现过的验证或测试结果为准。\n"
      )
    );
    assert.ok(pre.includes("还在处理中的问题留给会话结束时的复盘，现在不写。"));
    const closing = textOf(reviewCalls.at(-1)?.messages.at(-1) as LoggedMessage);
    assert.ok(closing.startsWith("【复盘 v1】这次会话的工作已经结束。"));
    // 296：没指定复盘模型时，压缩前与收尾复盘都用这一步本身的模型
    const mainModel = calls.find((call) => call.kind === "main")?.model;
    assert.ok(mainModel !== undefined);
    assert.ok(reviewCalls.every((call) => call.model === mainModel));
    // 压缩前复盘的会话也记种类
    const preId = result.reviews?.[0]?.sessionId;
    assert.ok(preId !== undefined);
    // 283 补充：压缩前复盘覆盖到压缩之前的那条消息，收尾复盘覆盖到最后一条
    const preTag = runStarts(root, preId).at(-1)?.memoryReview;
    const closingId = result.reviews?.[1]?.sessionId;
    assert.ok(closingId !== undefined);
    const closingTag = runStarts(root, closingId).at(-1)?.memoryReview;
    const lastSource = lastMessageEntry(root, result.sessionId);
    assert.deepEqual(closingTag?.covers, { entryId: lastSource.id, seq: lastSource.seq });
    assert.equal(preTag?.kind, "pre-compaction");
    assert.equal(preTag?.template, "v1");
    const preCovers = preTag?.covers;
    assert.ok(preCovers !== undefined);
    assert.ok(preCovers.seq < lastSource.seq);
    const sourceMessageIds = (
      sessionEntries(root, result.sessionId).main as unknown as Array<{ type: string; id: string }>
    )
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.id);
    assert.ok(sourceMessageIds.includes(preCovers.entryId));
  }));

test("复盘模型（296）：指定后压缩前与收尾复盘都用它，干活的请求仍用这一步本身的模型", () =>
  withRoot(async (root) => {
    writeFileSync(join(root, "a.txt"), "内容\n");
    const { streamFn, calls } = routed({
      main: [
        {
          text: "我先读一下文件。".repeat(20),
          toolCalls: [{ name: "read_file", args: { path: "a.txt" } }],
          contextTokens: 5000,
        },
        { text: "读完了", contextTokens: 300 },
      ],
      review: [{ text: "不记" }],
    });
    const result = await runHeadless({
      ...base(root, streamFn),
      task: `请读 a.txt。${"背景说明。".repeat(60)}`,
      compaction: { thresholdTokens: 1000, keepRecentTokens: 20 },
      reviewModel: { provider: "review-provider", modelId: "review-model" },
    });
    assert.deepEqual(
      (result.reviews ?? []).map((review) => [review.kind, review.status]),
      [
        ["pre-compaction", "completed"],
        ["closing", "completed"],
      ]
    );
    const reviewCalls = calls.filter((call) => call.kind === "review");
    assert.ok(reviewCalls.length >= 2);
    assert.ok(reviewCalls.every((call) => call.model === "review-model"));
    // 干活的请求用这一步本身的模型（复盘运行面内的压缩摘要属于复盘，随复盘模型）
    const work = calls.filter((call) => call.kind === "main");
    assert.ok(work.length > 0);
    assert.ok(
      work.every((call) => call.model !== "review-model"),
      JSON.stringify(calls.map((call) => [call.kind, call.model]))
    );
  }));

test("开关关掉：不推送、不注册记忆工具、不复盘", () =>
  withRoot(async (root) => {
    mkdirSync(join(root, ".pigeon", "learned"), { recursive: true });
    writeFileSync(
      memoryFileOf(root),
      `${MEMORY_FILE_HEADER}- [L1] 事实：甲\n  引用：a\n  理由：r\n`
    );
    const { streamFn, calls } = routed({ main: [{ text: "好了" }], review: [{ text: "x" }] });
    const result = await runHeadless({ ...base(root, streamFn), pushedMemory: false });
    assert.equal(result.reviews, undefined);
    assert.equal(calls.filter((call) => call.kind === "review").length, 0);
    const [mainCall] = calls;
    assert.ok(mainCall !== undefined);
    assert.ok(!mainCall.system.includes("## 学到的记忆"));
    assert.ok(!mainCall.tools.includes("update_memory"));
    const [start] = runStarts(root, result.sessionId);
    assert.equal(start?.learnedMemory, undefined);
  }));
