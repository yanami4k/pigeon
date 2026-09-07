import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asEntryId,
  asExecutionId,
  asReceiptId,
  asRunId,
  asSessionId,
  newEntryId,
  newExecutionId,
  newReceiptId,
  newRunId,
  newSessionId,
} from "./ids.ts";

test("生成 1000 个 RunId 无重复", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    ids.add(newRunId());
  }
  assert.equal(ids.size, 1000);
});

test("五类标识各自生成且前缀互不相同", () => {
  assert.match(newRunId(), /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(newSessionId(), /^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(newEntryId(), /^entry_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(newExecutionId(), /^exec_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(newReceiptId(), /^rcpt_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("前缀错误时 as* 抛异常", () => {
  assert.throws(() => asRunId(newSessionId()));
  assert.throws(() => asSessionId(newRunId()));
  assert.throws(() => asEntryId(newExecutionId()));
  assert.throws(() => asExecutionId(newReceiptId()));
  assert.throws(() => asReceiptId(newEntryId()));
});

test("形态非法时 as* 抛异常", () => {
  assert.throws(() => asRunId(""));
  assert.throws(() => asRunId("run_short"));
  assert.throws(() => asRunId("run_O0ILUU")); // 含 Crockford 禁用字符且长度不足
  // @ts-expect-error 运行期防御：非字符串输入同样拒绝
  assert.throws(() => asRunId(42));
});

test("JSON 序列化往返后仍是合法 ID", () => {
  const id = newExecutionId();
  const revived = JSON.parse(JSON.stringify({ id })) as { id: string };
  assert.equal(asExecutionId(revived.id), id);
});

test("ULID 字典序与时间序一致", () => {
  const before = newRunId();
  const after = newRunId();
  // 同一毫秒内靠随机段区分；跨毫秒时时间前缀必须有序
  if (before.slice(4, 14) !== after.slice(4, 14)) {
    assert.ok(before < after);
  }
});
