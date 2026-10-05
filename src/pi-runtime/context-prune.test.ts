// 缓存感知的上下文裁剪（决策 361、373）：付费时机只裁过时读取（较大的旧结果只在免费时机裁），按 裁掉量 × N ≥
// （价格比 − 1）× 改写点之后的量 且不小于最小批量才裁；
// 受保护的内容（用户的话、模型正文与思考、工具调用参数、状态消息、最近几轮的工具结果）不碰，调用与结果的配对保留；
// 无事发生的结果只随批顺带；过时读取不论大小都算，裁掉的读取在上下文里再没有同一文件的读写时不再算读过；命令输出没落盘的
// 先补落盘（空输出不落盘），截断而全文没落盘的、补落盘失败的不裁，带文件变化的保留清单；先写进会话记录再生效；免费时机
// （模型或工具集变化、空闲超时、压缩前）一次裁光；同一请求前裁两次不重复扣减；续跑照记录重放（含决策 373 之前付费时机裁掉的
// 较大旧结果），逐字节一致，总开关关掉也照放。
import assert from "node:assert/strict";
import { estimateTokens } from "@earendil-works/pi-agent-core";
import { test } from "vitest";
import { type ContextPruneSettings, contextPruneSettings } from "../state/prune-config.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import { STATUS_MARKER } from "../state/status-text.ts";
import {
  ContextPruner,
  type PruneEffects,
  type PruneRecord,
  pruneSeedFromEntries,
} from "./context-prune.ts";
import type { AgentMessage } from "./index.ts";

let clock = 0;
const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Call {
  name: string;
  text: string;
  details?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

// 一轮：一条带一个工具调用的助手消息与它的结果
function turn(call: Call, id: string): AgentMessage[] {
  clock += 1;
  return [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `想想 ${id}` },
        { type: "text", text: `调用 ${id}` },
        { type: "toolCall", id, name: call.name, arguments: call.args ?? { path: `${id}.txt` } },
      ],
      api: "fake",
      provider: "fake",
      model: "fake",
      usage: USAGE,
      stopReason: "toolUse",
      timestamp: clock,
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: id,
      toolName: call.name,
      content: [{ type: "text", text: call.text }],
      ...(call.details !== undefined ? { details: call.details } : {}),
      isError: false,
      timestamp: clock,
    } as AgentMessage,
  ];
}

// 命令前后没有文件变化
const NONE = { added: [], removed: [], modified: [], truncated: false };

// 约 tokens 个 token 的文本（上游按 4 字符一个 token 估算）
const sized = (tokens: number) => "x".repeat(tokens * 4);
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });

// 先是 old 里的各轮，再是 recent 轮保护内的小读取（各 recentTokens 大）
function conversation(old: Call[], recent = 5, recentTokens = 10): AgentMessage[] {
  return [
    user("任务"),
    ...old.flatMap((call, index) => turn(call, `old${index}`)),
    ...Array.from({ length: recent }, (_, index) =>
      turn({ name: "read_file", text: sized(recentTokens) }, `new${index}`)
    ).flat(),
  ];
}

// 读取 path 的第 1–100 行（约 tokens 大）；同一文件之后再读一次即成过时读取
const readAll = (path: string, tokens: number): Call => ({
  name: "read_file",
  text: sized(tokens),
  args: { path },
  details: { resolvedPath: `/w/${path}`, offset: 1, returnedLines: 100 },
});
// 约 tokens 大的过时读取，后面跟着覆盖它的小读取（两轮）
const stale = (path: string, tokens: number): Call[] => [readAll(path, tokens), readAll(path, 10)];

function settings(overrides: Partial<ContextPruneSettings> = {}): ContextPruneSettings {
  return { ...contextPruneSettings(undefined, undefined), ...overrides };
}

const contentOf = (messages: readonly AgentMessage[], id: string) =>
  JSON.stringify(
    messages.find((message) => message.role === "toolResult" && message.toolCallId === id)
  );

test("付费时机：裁掉量 × N 与（价格比 − 1）× 改写点之后的量比较，恰在分界两侧一裁一不裁；不足最小批量不裁", () => {
  const messages = conversation(stale("a.txt", 12_000), 5, 8_000);
  // 价格比为 1 时不收改写费，先量出裁掉量与改写点之后的量
  const probe = new ContextPruner(settings({ priceRatio: 1 })).beforeRequest(messages).record;
  assert.ok(probe !== undefined);
  const boundary = 1 + (20 * probe.prunedTokens) / probe.rewriteTokens;
  const below = new ContextPruner(settings({ priceRatio: boundary - 0.01 })).beforeRequest(
    messages
  );
  assert.equal(below.record?.items[0]?.toolCallId, "old0");
  assert.ok((below.record?.estimatedSaving ?? 0) >= (below.record?.estimatedCost ?? 0));
  const above = new ContextPruner(settings({ priceRatio: boundary + 0.01 })).beforeRequest(
    messages
  );
  assert.equal(above.record, undefined);
  assert.equal(contentOf(above.messages, "old0"), contentOf(messages, "old0"));
  // 价格比为 1 也不足最小批量（缺省 1 万 token）的不裁
  const small = conversation(stale("a.txt", 9_000));
  assert.equal(
    new ContextPruner(settings({ priceRatio: 1 })).beforeRequest(small).record,
    undefined
  );
});

test("受保护的内容不碰、调用与结果配对保留、传入的消息不被改动", () => {
  const status = {
    role: "user",
    content: [{ type: "text", text: sized(2_000) }],
    timestamp: 0,
    [STATUS_MARKER]: true,
  } as AgentMessage;
  const messages = [
    status,
    ...conversation(
      [
        { name: "read_file", text: sized(2_000), args: { path: sized(1_000) } },
        { name: "grep", text: sized(2_000), args: { pattern: "make" } },
      ],
      5,
      2_000
    ),
  ];
  const before = structuredClone(messages);
  const pruner = new ContextPruner(settings());
  const record = pruner.beforeCompaction(messages);
  assert.deepEqual(
    record?.items.map((item) => item.toolCallId),
    ["old0", "old1"]
  );
  const view = pruner.view(messages);
  assert.deepEqual(messages, before);
  assert.equal(view.length, messages.length);
  view.forEach((message, index) => {
    const original = messages[index] as AgentMessage;
    if (message.role === "toolResult" && original.role === "toolResult") {
      assert.equal(message.toolCallId, original.toolCallId);
      assert.equal(message.toolName, original.toolName);
      if (!message.toolCallId.startsWith("old")) assert.deepEqual(message, original);
    } else {
      assert.deepEqual(message, original);
    }
  });
});

test("无事发生的结果只随批顺带：单靠它们不裁；有一批要裁时起点之后的一起裁", () => {
  const empty: Call = {
    name: "grep",
    // 比占位大（占位比原文还大的不算候选）
    text: sized(100),
    details: { total: 0 },
    args: { pattern: "x" },
  };
  const only = conversation([empty, empty, empty]);
  assert.equal(
    new ContextPruner(settings({ priceRatio: 1, minBatchTokens: 0 })).beforeRequest(only).record,
    undefined
  );
  const withBatch = conversation([...stale("a.txt", 12_000), empty]);
  const record = new ContextPruner(settings({ priceRatio: 1 })).beforeRequest(withBatch).record;
  assert.deepEqual(
    record?.items.map((item) => [item.toolCallId, item.reason]),
    [
      ["old0", "stale"],
      ["old2", "empty"],
    ]
  );
});

test("较大的旧结果只在免费时机裁：付费时机不论价格比与下限都不选它，压缩前一次裁光", () => {
  const messages = conversation([
    { name: "read_file", text: sized(12_000) },
    ...stale("a.txt", 200),
  ]);
  const paid = new ContextPruner(settings({ priceRatio: 1, minBatchTokens: 0 })).beforeRequest(
    messages
  ).record;
  assert.deepEqual(
    paid?.items.map((item) => [item.toolCallId, item.reason]),
    [["old1", "stale"]]
  );
  const free = new ContextPruner(settings({ priceRatio: 50 })).beforeCompaction(messages);
  assert.deepEqual(
    free?.items.map((item) => [item.toolCallId, item.reason]),
    [
      ["old0", "large"],
      ["old1", "stale"],
    ]
  );
});

test("过时读取不论大小都算；同一文件在上下文里还有没裁的读取时仍算读过，都裁掉才不再算", () => {
  const read = (path: string, offset: number, lines: number, tokens: number): Call => ({
    name: "read_file",
    text: sized(tokens),
    args: { path },
    details: { resolvedPath: `/w/${path}`, offset, returnedLines: lines },
  });
  const forgotten: string[] = [];
  const effects: PruneEffects = { forgetRead: (path) => forgotten.push(path) };
  // a.txt 第 5–14 行之后被第 1–100 行的读取覆盖；b.txt 只读过一次；c.txt 之后读的第 20–30 行不覆盖第 1–10 行；
  // d.txt 之后被 write_file 整体覆写（覆写的结果还在，不撤读取记录）
  const messages = conversation([
    read("a.txt", 5, 10, 50),
    read("a.txt", 1, 100, 50),
    read("b.txt", 1, 10, 1_000),
    read("c.txt", 1, 10, 50),
    read("c.txt", 20, 11, 50),
    read("d.txt", 1, 10, 50),
    { name: "write_file", text: "已覆盖", details: { resolvedPath: "/w/d.txt" } },
  ]);
  const record = new ContextPruner(settings(), effects).beforeCompaction(messages);
  assert.deepEqual(
    record?.items.map((item) => [item.toolCallId, item.reason]),
    [
      ["old0", "stale"],
      ["old2", "large"],
      ["old5", "stale"],
    ]
  );
  assert.deepEqual(forgotten, ["/w/b.txt"]);
});

test("命令输出：已落盘的用原路径；没截断的整段输出补落盘，占位给出虚拟路径", () => {
  const saved: string[] = [];
  const effects: PruneEffects = {
    saveOutput: (text) => {
      saved.push(text);
      return "pigeon://outputs/s1/7";
    },
  };
  const output = sized(1_000);
  const messages = conversation([
    {
      name: "run_command",
      text: output,
      args: { command: "make test" },
      details: {
        truncated: false,
        output,
        exitCode: 0,
        outputBytes: output.length,
        fileChanges: NONE,
      },
    },
    {
      name: "run_command",
      text: sized(1_000),
      args: { command: "make all" },
      details: { truncated: true, savedOutput: { uri: "pigeon://outputs/s1/3" }, exitCode: 1 },
    },
  ]);
  const record = new ContextPruner(settings(), effects).beforeCompaction(messages);
  assert.deepEqual(saved, [output]);
  assert.match(record?.items[0]?.placeholder ?? "", /pigeon:\/\/outputs\/s1\/7/);
  assert.match(record?.items[1]?.placeholder ?? "", /pigeon:\/\/outputs\/s1\/3/);
});

test("命令：截断而全文没落盘的、补落盘失败的不裁；部分落盘照实写；带文件变化的保留清单；空输出不落盘", () => {
  const saved: string[] = [];
  const failing = sized(1_000);
  const effects: PruneEffects = {
    saveOutput: (text) => {
      if (text === failing) throw new Error("磁盘满");
      saved.push(text);
      return "pigeon://outputs/s1/9";
    },
  };
  const generated = "y".repeat(4_000);
  const changes = "\n文件变化：新增 1 / 删除 0 / 修改 0\n新增：gen.txt";
  const echo = `echo ${"x".repeat(800)}`;
  const command = (text: string, details: Record<string, unknown>, run = "make"): Call => ({
    name: "run_command",
    text,
    args: { command: run },
    details: { exitCode: 0, fileChanges: NONE, ...details },
  });
  const messages = conversation([
    command(sized(1_000), { truncated: true, outputBytes: 999_999, savedOutputError: "磁盘满" }),
    command(failing, { truncated: false, output: failing, outputBytes: failing.length }),
    command(sized(1_000), {
      truncated: true,
      outputBytes: 999_999,
      savedOutput: { uri: "pigeon://outputs/s1/4", bytes: 1_000, partial: true },
    }),
    command(`$ gen\n退出码：0\n${generated}${changes}`, {
      truncated: false,
      output: generated,
      outputBytes: generated.length,
      fileChanges: { added: ["gen.txt"], removed: [], modified: [], truncated: false },
    }),
    command(`$ ${echo}\n退出码：0\n`, { truncated: false, output: "", outputBytes: 0 }, echo),
    {
      name: "web_search",
      text: sized(200),
      args: { query: "q" },
      details: { results: 0, answered: true },
    },
  ]);
  const record = new ContextPruner(settings(), effects).beforeCompaction(messages);
  assert.deepEqual(
    record?.items.map((item) => [item.toolCallId, item.reason]),
    [
      ["old2", "large"],
      ["old3", "large"],
      ["old4", "empty"],
    ]
  );
  assert.deepEqual(saved, [generated]);
  const [partial, withChanges, empty] = (record?.items ?? []).map((item) => item.placeholder);
  assert.match(partial ?? "", /已保存的是输出的前 1000 字节.*pigeon:\/\/outputs\/s1\/4/);
  assert.ok(withChanges?.endsWith(changes), withChanges);
  assert.match(empty ?? "", /没有输出/);
});

test("先写进会话记录再生效：写不成时这次裁剪不生效、错误照抛，之后照常可裁", () => {
  const messages = conversation(stale("a.txt", 12_000));
  const pruner = new ContextPruner(settings({ priceRatio: 1 }));
  assert.throws(
    () =>
      pruner.beforeRequest(messages, () => {
        throw new Error("写不进");
      }),
    /写不进/
  );
  assert.equal(JSON.stringify(pruner.view(messages)), JSON.stringify(messages));
  assert.deepEqual(pruner.seed().placeholders, []);
  assert.notEqual(pruner.beforeRequest(messages).record, undefined);
});

test("同一请求前裁两次：第二次的裁剪前 token 数接着第一次的裁剪后，不重复扣减；还没随请求发出的按所用 usage 的先后算", () => {
  const small: Call = { name: "read_file", text: sized(10) };
  // a 是较大的旧结果（压缩前裁）；b 被 c 覆盖成过时读取（付费时机裁）
  const [b, c] = stale("b.txt", 2_000) as [Call, Call];
  const base = [
    user("任务"),
    ...turn({ name: "read_file", text: sized(2_000) }, "a"),
    ...turn(b, "b"),
    ...turn(c, "c"),
    ...["d", "e", "f"].flatMap((id) => turn(small, id)),
  ];
  const pruner = new ContextPruner(
    settings({ priceRatio: 1, minBatchTokens: 0 }),
    {},
    undefined,
    () => 100
  );
  const first = pruner.beforeCompaction(base);
  const appended = turn(small, "g");
  const second = pruner.beforeRequest([...base, ...appended]).record;
  assert.deepEqual([first?.items[0]?.toolCallId, second?.items[0]?.toolCallId], ["a", "b"]);
  const added = appended.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.equal(second?.tokensBefore, (first?.tokensAfter ?? 0) + added);
  // f 的 usage 量在两次裁剪之前，g 的在两次之间，之后的新回复在两次之后（先后不看时间戳）
  const [f, g] = [base.at(-2), appended[0]];
  assert.equal(pruner.unsentTokens(f), (first?.prunedTokens ?? 0) + (second?.prunedTokens ?? 0));
  assert.equal(pruner.unsentTokens(g), second?.prunedTokens);
  assert.equal(pruner.unsentTokens(turn(small, "h")[0]), 0);
  assert.equal(pruner.unsentTokens(undefined), 0);
});

test("免费时机：模型或工具集与上一个 Run 不同、空闲超过保留时长，都一次裁光（不论价格比）", () => {
  const messages = conversation([{ name: "read_file", text: sized(1_000) }]);
  const signature = { model: "p/m", tools: ["read_file"], systemPrompt: "s" };
  const strict = settings({ priceRatio: 50 });
  const changed = new ContextPruner(strict, {}, { placeholders: [], signature });
  changed.observeRun({ ...signature, tools: ["read_file", "grep"] });
  assert.equal(changed.beforeRequest(messages).record?.trigger, "tools");
  const same = new ContextPruner(strict, {}, { placeholders: [], signature });
  same.observeRun(signature);
  assert.equal(same.beforeRequest(messages).record, undefined);
  let now = 1_000;
  const idle = new ContextPruner({ ...strict, retentionSeconds: 60 }, {}, undefined, () => now);
  assert.equal(idle.beforeRequest(messages).record, undefined);
  now += 61_000;
  assert.equal(idle.beforeRequest(messages).record?.trigger, "idle");
});

test("续跑照记录重放：从会话记录取回的裁剪应用到同样的消息上逐字节一致，之后追加的消息不改变前缀", () => {
  const messages = conversation([{ name: "read_file", text: sized(12_000) }]);
  const pruner = new ContextPruner(settings());
  // 决策 373 之前的会话记录：付费时机裁掉了较大的旧结果
  const record: PruneRecord = {
    ...(pruner.beforeCompaction(messages) as PruneRecord),
    trigger: "paid",
  };
  assert.equal(record.items[0]?.reason, "large");
  const first = { messages: pruner.view(messages) };
  const entries = [
    {
      type: "custom",
      customType: SessionEntryType.RunStart,
      data: {
        model: { provider: "p", id: "m" },
        advertisedTools: ["read_file"],
        systemPrompt: "s",
      },
    },
    { type: "message", message: messages[0] },
    {
      type: "custom",
      customType: SessionEntryType.Prune,
      data: { version: SESSION_ENTRY_VERSION, ...record },
    },
  ];
  const seed = pruneSeedFromEntries(entries);
  assert.deepEqual(seed.signature, { model: "p/m", tools: ["read_file"], systemPrompt: "s" });
  // 总开关关掉：不再新裁（候选照样够格），旧记录照重放
  const resumed = new ContextPruner(settings({ enabled: false, priceRatio: 1 }), {}, seed);
  const again = resumed.beforeRequest([
    ...messages,
    ...turn({ name: "read_file", text: sized(12_000) }, "x"),
  ]);
  assert.equal(again.record, undefined);
  assert.equal(JSON.stringify(resumed.view(messages)), JSON.stringify(first.messages));
  const longer = [...messages, user("接着做")];
  const prefix = JSON.stringify(resumed.view(longer).slice(0, messages.length));
  assert.equal(prefix, JSON.stringify(first.messages));
});
