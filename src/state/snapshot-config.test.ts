// 快照里跳过哪些未跟踪文件（决策 381）：单个超限的跳过；其余合计超限时从大到小跳过，直到不超过上限
import assert from "node:assert/strict";
import { test } from "vitest";
import { pickOversized } from "./snapshot-config.ts";

test("单个超限的跳过；其余合计超限时从大到小继续跳过，刚好不超过即停", () => {
  const files = [
    { path: "a", bytes: 40 },
    { path: "big", bytes: 200 },
    { path: "b", bytes: 60 },
    { path: "c", bytes: 30 },
  ];
  assert.deepEqual(pickOversized(files, { fileMaxBytes: 100, totalMaxBytes: 70 }), [
    { path: "big", bytes: 200 },
    { path: "b", bytes: 60 },
  ]);
  assert.deepEqual(pickOversized(files, { fileMaxBytes: 1000, totalMaxBytes: 330 }), []);
});
