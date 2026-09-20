// 行级 diff 的算法直测（随该算法下沉到 state 补齐）：此前它只被候选详情那条视图用例间接覆盖，
// 两侧长度不等时的尾部收尾分支没有任何断言。
import assert from "node:assert/strict";
import { test } from "node:test";
import { lineDiff } from "./line-diff.ts";

test("行级 diff：完全相同时逐行都是未变", () => {
  assert.deepEqual(lineDiff(["a", "b"], ["a", "b"]), [" a", " b"]);
});

test("行级 diff：旧的比新的长，尾部多出来的行要逐行记删", () => {
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a"]), [" a", "-b", "-c"]);
});

test("行级 diff：新的比旧的长，尾部多出来的行要逐行记加", () => {
  assert.deepEqual(lineDiff(["a"], ["a", "b", "c"]), [" a", "+b", "+c"]);
});

test("行级 diff：中间一行被换掉，只动那一行", () => {
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a", "x", "c"]), [" a", "-b", "+x", " c"]);
});

test("行级 diff：空的一侧", () => {
  assert.deepEqual(lineDiff([], ["a"]), ["+a"]);
  assert.deepEqual(lineDiff(["a"], []), ["-a"]);
});

test("行级 diff：取的是最长公共子序列，不是逐行对齐", () => {
  // 在开头插一行：公共部分应当整段保留，而不是把每一行都算成改动
  assert.deepEqual(lineDiff(["a", "b", "c"], ["x", "a", "b", "c"]), ["+x", " a", " b", " c"]);
});
