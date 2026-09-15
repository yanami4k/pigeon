import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionId } from "./ids.ts";
import type { SessionSummary } from "./session-summary.ts";
import * as summaryModule from "./session-summary.ts";

interface DayGroup {
  day: string;
  sessionIds: string[];
  runCount: number;
  totalTokens: number;
  totalCost: number;
  pendingReconcile: number;
}

type GroupFn = (summaries: readonly SessionSummary[]) => DayGroup[];

function fn(): GroupFn {
  const candidate = (summaryModule as Record<string, unknown>).groupSessionsByDay;
  assert.equal(typeof candidate, "function", "session-summary.ts 应导出 groupSessionsByDay");
  return candidate as GroupFn;
}

function summary(
  id: string,
  iso: string,
  counts: Partial<
    Pick<SessionSummary, "runCount" | "totalTokens" | "totalCost" | "pendingReconcile">
  > = {}
): SessionSummary {
  return {
    sessionId: id as SessionId,
    createdAt: Date.parse(iso),
    runCount: counts.runCount ?? 1,
    toolNames: [],
    failureClasses: [],
    pendingReconcile: counts.pendingReconcile ?? 0,
    totalTokens: counts.totalTokens ?? 0,
    totalCost: counts.totalCost ?? 0,
  };
}

test("空输入返回空数组", () => {
  assert.deepEqual(fn()([]), []);
});

test("按 UTC 日期分组、组按日升序、组内按 createdAt 升序并汇总", () => {
  const input = [
    summary("s-late", "2026-09-02T08:00:00.000Z", {
      runCount: 2,
      totalTokens: 100,
      totalCost: 0.5,
    }),
    summary("s-first", "2026-09-01T23:59:59.999Z", {
      runCount: 1,
      totalTokens: 10,
      pendingReconcile: 1,
    }),
    summary("s-early", "2026-09-02T00:00:00.000Z", {
      runCount: 3,
      totalTokens: 5,
      totalCost: 0.25,
      pendingReconcile: 2,
    }),
    summary("s-dec", "2025-12-31T12:00:00.000Z", { runCount: 0 }),
  ];
  const snapshot = input.map((item) => item.sessionId);
  assert.deepEqual(fn()(input), [
    {
      day: "2025-12-31",
      sessionIds: ["s-dec"],
      runCount: 0,
      totalTokens: 0,
      totalCost: 0,
      pendingReconcile: 0,
    },
    {
      day: "2026-09-01",
      sessionIds: ["s-first"],
      runCount: 1,
      totalTokens: 10,
      totalCost: 0,
      pendingReconcile: 1,
    },
    {
      day: "2026-09-02",
      sessionIds: ["s-early", "s-late"],
      runCount: 5,
      totalTokens: 105,
      totalCost: 0.75,
      pendingReconcile: 2,
    },
  ]);
  assert.deepEqual(
    input.map((item) => item.sessionId),
    snapshot,
    "不得修改输入数组的顺序"
  );
});

test("createdAt 相同时保持输入相对顺序；月日补零", () => {
  const input = [
    summary("b", "2026-01-05T03:00:00.000Z"),
    summary("a", "2026-01-05T03:00:00.000Z"),
    summary("c", "2026-01-05T01:00:00.000Z"),
  ];
  const groups = fn()(input);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.day, "2026-01-05");
  assert.deepEqual(groups[0]?.sessionIds, ["c", "b", "a"]);
  assert.equal(groups[0]?.runCount, 3);
});
