import assert from "node:assert/strict";
import { test } from "node:test";
import { CALIBRATION_SEED, PythonRandom } from "./stream-sample.ts";

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

// 对照值均由 CPython 3.13 的 random 模块算出
test("与 Python 的 random 逐位一致：播种后的 getrandbits 序列", () => {
  const r = new PythonRandom(20260927);
  assert.deepEqual(
    [r.getrandbits(32), r.getrandbits(32), r.getrandbits(32)],
    [3891703431, 1026030233, 2089554918]
  );
});

test("与 Python 的 random.sample 逐位一致：总体大于集合开销走已选集合分支、不大于走池子分支，以及小样本、多块种子与非数字总体", () => {
  // 89 道题里抽 15 道：n = 89 > 85，已选集合分支
  assert.deepEqual(
    new PythonRandom(CALIBRATION_SEED).sample(range(1, 89), 15),
    [31, 63, 41, 16, 10, 64, 52, 47, 88, 14, 40, 24, 86, 60, 38]
  );
  // n = 80、85 走池子分支，n = 86 走已选集合分支
  assert.deepEqual(
    new PythonRandom(CALIBRATION_SEED).sample(range(1, 80), 15),
    [31, 63, 41, 16, 10, 76, 64, 52, 47, 14, 40, 75, 24, 60, 38]
  );
  assert.deepEqual(
    new PythonRandom(CALIBRATION_SEED).sample(range(1, 85), 15),
    [31, 63, 41, 16, 10, 81, 64, 52, 47, 14, 40, 80, 24, 60, 38]
  );
  assert.deepEqual(
    new PythonRandom(CALIBRATION_SEED).sample(range(1, 86), 15),
    [31, 63, 41, 16, 10, 64, 52, 47, 14, 40, 24, 86, 60, 38, 33]
  );
  assert.deepEqual(new PythonRandom(1).sample(range(0, 9), 3), [2, 1, 4]);
  assert.deepEqual(new PythonRandom(7).sample(["a", "b", "c", "d", "e"], 5), [
    "c",
    "b",
    "d",
    "a",
    "e",
  ]);
  assert.deepEqual(new PythonRandom(2n ** 40n + 5n).sample(range(0, 99), 4), [64, 66, 34, 84]);
});

test("抽题可重复：同一种子同一总体两次结果相同；样本数超出总体即报错", () => {
  const a = new PythonRandom(CALIBRATION_SEED).sample(range(1, 60), 15);
  const b = new PythonRandom(CALIBRATION_SEED).sample(range(1, 60), 15);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 15);
  assert.throws(() => new PythonRandom(1).sample([1, 2], 3), /超出总体/);
});
