// M5 S1（决策 037 / 045）：消息内容记录叶子模块测试——内容块抽取、规范序列化哈希、
// 按块截断可见、thinking 持久化开关、图片只记元数据、schema 往返。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { newEntryId, newRunId, newSessionId } from "./ids.ts";
import {
  buildMessageContent,
  canonicalJson,
  DEFAULT_CONTENT_BLOCK_LIMIT_BYTES,
  hashContentBlocks,
  MESSAGE_CONTENT_VERSION,
  type MessageContentRecord,
  parseMessageContentRecord,
  recomputeContentHash,
  truncateUtf8,
} from "./message-content.ts";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

test("规范序列化：键序无关、数组保序；哈希 = sha256(规范 JSON)", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  const blocks = [{ type: "text" as const, text: "你好", truncated: false }];
  assert.equal(hashContentBlocks(blocks), sha256(canonicalJson(blocks)));
  assert.match(hashContentBlocks(blocks), /^[0-9a-f]{64}$/);
});

test("三角色抽取：user 字符串、assistant 的 text/thinking/toolCall、toolResult 文本与元数据", () => {
  const user = buildMessageContent({ role: "user", content: "改一下 a.ts" });
  assert.equal(user.role, "user");
  assert.deepEqual(user.blocks, [{ type: "text", text: "改一下 a.ts", truncated: false }]);
  assert.equal(user.contentHash, hashContentBlocks(user.blocks));

  const assistant = buildMessageContent({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先读文件", thinkingSignature: "sig-opaque" },
      { type: "text", text: "我来改", textSignature: "x" },
      { type: "toolCall", id: "tc-1", name: "edit_file", arguments: { path: "a.ts" } },
    ],
  });
  assert.deepEqual(assistant.blocks, [
    { type: "thinking", thinking: "先读文件", truncated: false },
    { type: "text", text: "我来改", truncated: false },
    // toolCall 只记 id 与 name：参数已在 tool.proposed / intent 里，不重复存
    { type: "toolCall", id: "tc-1", name: "edit_file" },
  ]);
  // 签名等 provider 不透明载荷不进内容文件
  assert.ok(!JSON.stringify(assistant).includes("sig-opaque"));

  const toolResult = buildMessageContent({
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "edit_file",
    isError: false,
    content: [{ type: "text", text: "已写入" }],
  });
  assert.equal(toolResult.toolCallId, "tc-1");
  assert.equal(toolResult.toolName, "edit_file");
  assert.equal(toolResult.isError, false);
  assert.deepEqual(toolResult.blocks, [{ type: "text", text: "已写入", truncated: false }]);
});

test("thinking：redacted 标记如实记录；持久化开关关闭时只留哈希与字节数，不存正文", () => {
  const redacted = buildMessageContent({
    role: "assistant",
    content: [{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "enc" }],
  });
  assert.deepEqual(redacted.blocks, [
    { type: "thinking", thinking: "", truncated: false, redacted: true },
  ]);

  const off = buildMessageContent(
    { role: "assistant", content: [{ type: "thinking", thinking: "内部推理甲乙丙" }] },
    { persistThinking: false }
  );
  assert.deepEqual(off.blocks, [
    {
      type: "thinking",
      thinking: "",
      truncated: false,
      omitted: true,
      bytes: Buffer.byteLength("内部推理甲乙丙"),
      fullHash: sha256("内部推理甲乙丙"),
    },
  ]);
  assert.ok(!JSON.stringify(off).includes("内部推理"));
});

test("图片只记 mimeType、字节数与哈希，不存 base64 数据", () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5]);
  const content = buildMessageContent({
    role: "user",
    content: [
      { type: "text", text: "看图" },
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ],
  });
  assert.deepEqual(content.blocks[1], {
    type: "image",
    mimeType: "image/png",
    bytes: 5,
    hash: sha256(bytes),
  });
  assert.ok(!JSON.stringify(content).includes(bytes.toString("base64")));
});

test("按块截断：超上限可见标记 truncated 并带全文哈希；UTF-8 边界不劈字符", () => {
  assert.equal(DEFAULT_CONTENT_BLOCK_LIMIT_BYTES, 64 * 1024);
  const long = "汉".repeat(10); // 每字 3 字节，共 30 字节
  const cut = truncateUtf8(long, 10);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, "汉".repeat(3)); // 9 字节，第 4 字会越界，不劈开
  assert.deepEqual(truncateUtf8("abc", 10), { text: "abc", truncated: false });
  // 代理对不劈开：😀 占 4 字节（两个 UTF-16 码元）
  assert.equal(truncateUtf8("a😀b", 3).text, "a");

  const content = buildMessageContent(
    {
      role: "toolResult",
      toolCallId: "tc",
      toolName: "read_file",
      content: [{ type: "text", text: long }],
    },
    { blockLimitBytes: 10 }
  );
  assert.deepEqual(content.blocks, [
    { type: "text", text: "汉".repeat(3), truncated: true, fullHash: sha256(long) },
  ]);
  // 未超限的块不带 fullHash
  const small = buildMessageContent({ role: "user", content: "短" }, { blockLimitBytes: 10 });
  assert.equal("fullHash" in (small.blocks[0] ?? {}), false);
});

test("未知块类型不静默丢弃：记为 unknown 并带原始类型与哈希", () => {
  const content = buildMessageContent({
    role: "assistant",
    content: [{ type: "audio", data: "xyz" }],
  });
  assert.deepEqual(content.blocks, [
    {
      type: "unknown",
      originalType: "audio",
      hash: sha256(canonicalJson({ type: "audio", data: "xyz" })),
    },
  ]);
  // 无 content 字段的消息（上游 harness 自定义消息）：空块，哈希仍确定
  const empty = buildMessageContent({ role: "custom" });
  assert.deepEqual(empty.blocks, []);
  assert.equal(empty.contentHash, hashContentBlocks([]));
});

test("记录 schema 往返：parse 校验通过；recomputeContentHash 识破被篡改的正文", () => {
  const content = buildMessageContent({ role: "user", content: "原文" });
  const record: MessageContentRecord = {
    version: MESSAGE_CONTENT_VERSION,
    sessionId: newSessionId(),
    runId: newRunId(),
    runSeq: 1,
    entryId: newEntryId(),
    timestamp: 1_757_000_000_000,
    ...content,
  };
  const parsed = parseMessageContentRecord(JSON.parse(JSON.stringify(record)));
  assert.deepEqual(parsed, record);
  assert.equal(recomputeContentHash(parsed), record.contentHash);
  const tampered = {
    ...parsed,
    blocks: [{ type: "text" as const, text: "篡改", truncated: false }],
  };
  assert.notEqual(recomputeContentHash(tampered), record.contentHash);
  assert.throws(() => parseMessageContentRecord({ ...record, contentHash: "zz" }));
});
