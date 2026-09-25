import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asEntryId,
  asExecutionId,
  asReceiptId,
  asRunId,
  asSessionId,
  monotonicUlid,
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

test("ULID 单调：同一毫秒内连续生成 1000 个严格递增；时钟回拨仍递增；随机部分加到溢出时毫秒进 1、仍递增", () => {
  // 同一毫秒
  const sameMs = monotonicUlid(() => 1_700_000_000_000);
  const ids = Array.from({ length: 1000 }, () => sameMs());
  for (let i = 1; i < ids.length; i++) {
    assert.ok((ids[i] ?? "") > (ids[i - 1] ?? ""), `第 ${i} 个不大于前一个`);
  }
  assert.ok(
    ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)),
    "26 位 Crockford"
  );
  assert.ok(
    ids.every((id) => id.slice(0, 10) === ids[0]?.slice(0, 10)),
    "毫秒部分不变"
  );
  // 时钟回拨
  let now = 2_000_000_000_000;
  const rollback = monotonicUlid(() => now);
  const before = rollback();
  now -= 5_000;
  const after = rollback();
  assert.ok(after > before, "回拨后仍递增");
  // 随机部分溢出：随机源给出 80 位全 1，下一次加 1 即溢出
  const overflow = monotonicUlid(
    () => 3_000,
    (n) => Buffer.alloc(n, 0xff)
  );
  const max = overflow();
  const carried = overflow();
  assert.ok(carried > max, "溢出后仍递增");
  assert.equal(max.slice(10), "ZZZZZZZZZZZZZZZZ");
  assert.equal(carried.slice(10), "0000000000000000", "随机部分归零");
  assert.ok(carried.slice(0, 10) > max.slice(0, 10), "毫秒进 1");
});
