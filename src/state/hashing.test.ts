// 哈希与文本小工具：规范序列化与字段顺序无关、sha256 十六进制串、UTF-8 字节上限截断不劈字符。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { test } from "vitest";
import { canonicalJson, Sha256HexSchema, sha256Hex, truncateUtf8 } from "./hashing.ts";

test("规范序列化：键序无关、数组保序、undefined 属性省略；sha256Hex 是 64 位小写十六进制", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson([undefined, null]), "[null,null]");
  const hash = sha256Hex("你好");
  assert.equal(hash, createHash("sha256").update("你好").digest("hex"));
  assert.ok(Value.Check(Sha256HexSchema, hash));
  assert.ok(!Value.Check(Sha256HexSchema, hash.toUpperCase()));
});

test("UTF-8 截断：取不超过上限的最长前缀，不劈开多字节字符与代理对", () => {
  const long = "汉".repeat(10); // 每字 3 字节，共 30 字节
  const cut = truncateUtf8(long, 10);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, "汉".repeat(3)); // 9 字节，第 4 字会越界，不劈开
  assert.deepEqual(truncateUtf8("abc", 10), { text: "abc", truncated: false });
  // 代理对不劈开：😀 占 4 字节（两个 UTF-16 码元）
  assert.equal(truncateUtf8("a😀b", 3).text, "a");
});
