// MCP 回执证据块（M5.7 S3，决策 053）：参数哈希与 intent 原始参数按规范序列化对得上；返回全文哈希与
// 字节数、文本摘要超上限截断并标记；结构化返回算哈希；server 在 structuredContent.evidence 主动交的证据
// 原样收入，超 16 KiB 截断并标记，哈希恒按整体算。不解析返回语义。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  buildMcpEvidence,
  MCP_RESULT_SUMMARY_MAX_BYTES,
  MCP_SERVER_EVIDENCE_MAX_BYTES,
} from "./mcp-evidence.ts";
import { canonicalJson, sha256Hex } from "./message-content.ts";
import { ReceiptMcpSchema } from "./receipt.ts";

test("MCP 证据：参数与返回哈希、文本摘要、结构化哈希与小块 server 证据原样收入", () => {
  const args = { b: 2, a: "x" };
  const content = [
    { type: "text", text: "写入完成" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ];
  const structuredContent = { evidence: { path: "notes.txt", sha: "abc" }, other: 1 };
  const evidence = buildMcpEvidence({
    server: "fs",
    tool: "write_file",
    args,
    result: { content, structuredContent },
  });
  assert.equal(evidence.server, "fs");
  assert.equal(evidence.tool, "write_file");
  assert.equal(evidence.argsHash, sha256Hex(canonicalJson({ a: "x", b: 2 })));
  assert.equal(evidence.isError, false);
  assert.equal(evidence.resultHash, sha256Hex(canonicalJson(content)));
  assert.equal(evidence.resultBytes, Buffer.byteLength(canonicalJson(content)));
  assert.equal(evidence.resultSummary, "写入完成\n[image]");
  assert.equal(evidence.truncated, false);
  assert.equal(evidence.structuredHash, sha256Hex(canonicalJson(structuredContent)));
  assert.deepEqual(evidence.serverEvidence, {
    value: { path: "notes.txt", sha: "abc" },
    bytes: Buffer.byteLength(canonicalJson({ path: "notes.txt", sha: "abc" })),
    hash: sha256Hex(canonicalJson({ path: "notes.txt", sha: "abc" })),
    truncated: false,
  });
  assert.ok(Value.Check(ReceiptMcpSchema, JSON.parse(JSON.stringify(evidence))));
});

test("MCP 证据：无结构化返回时无 structuredHash 与 serverEvidence；server 报错如实标记；缺省参数按空对象算", () => {
  const evidence = buildMcpEvidence({
    server: "fs",
    tool: "write_file",
    args: undefined,
    result: { content: [{ type: "text", text: "拒绝" }], isError: true },
  });
  assert.equal(evidence.argsHash, sha256Hex(canonicalJson({})));
  assert.equal(evidence.isError, true);
  assert.equal(evidence.structuredHash, undefined);
  assert.equal(evidence.serverEvidence, undefined);
  const noEvidenceKey = buildMcpEvidence({
    server: "fs",
    tool: "t",
    args: {},
    result: { content: [], structuredContent: { total: 3 } },
  });
  assert.ok(noEvidenceKey.structuredHash !== undefined);
  assert.equal(noEvidenceKey.serverEvidence, undefined);
});

test("MCP 证据：返回文本超摘要上限截断并标记，全文哈希与字节数不受截断影响", () => {
  const long = "字".repeat(MCP_RESULT_SUMMARY_MAX_BYTES);
  const content = [{ type: "text", text: long }];
  const evidence = buildMcpEvidence({ server: "s", tool: "t", args: {}, result: { content } });
  assert.equal(evidence.truncated, true);
  assert.ok(Buffer.byteLength(evidence.resultSummary) <= MCP_RESULT_SUMMARY_MAX_BYTES);
  assert.ok(long.startsWith(evidence.resultSummary));
  assert.equal(evidence.resultHash, sha256Hex(canonicalJson(content)));
});

test("MCP 证据：server 证据超 16 KiB 截断并标记，哈希与字节数按整体算", () => {
  const big = { blob: "e".repeat(MCP_SERVER_EVIDENCE_MAX_BYTES + 100) };
  const evidence = buildMcpEvidence({
    server: "s",
    tool: "t",
    args: {},
    result: { content: [], structuredContent: { evidence: big } },
  });
  const whole = canonicalJson(big);
  const server = evidence.serverEvidence;
  assert.ok(server !== undefined);
  assert.equal(server.truncated, true);
  assert.equal(server.value, undefined);
  assert.ok(server.text !== undefined);
  assert.ok(Buffer.byteLength(server.text) <= MCP_SERVER_EVIDENCE_MAX_BYTES);
  assert.ok(whole.startsWith(server.text));
  assert.equal(server.bytes, Buffer.byteLength(whole));
  assert.equal(server.hash, sha256Hex(whole));
});
