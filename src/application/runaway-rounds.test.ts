// 撞上限续跑（决策 367）的截断轮与续跑提示：打转检测不把截断轮算作一轮（不清零计数）；回看历史时续跑提示不显示成人输入的话
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnRoundNotice } from "../pi-runtime/adapter.ts";
import type { RunId } from "../state/ids.ts";
import { TRUNCATION_CONTINUE_PROMPT } from "../state/runaway-config.ts";
import type { ViewMessage } from "../state/session-view.ts";
import { messageLines } from "./history.ts";
import { attachLoopGuard } from "./loop-guard.ts";

test("打转检测：截断且没有工具调用的轮不算一轮，前后相同的工具调用照常连续计数", () => {
  let listener: ((round: TurnRoundNotice) => void) | undefined;
  const reminders: string[] = [];
  attachLoopGuard(
    {
      subscribeRounds: (next) => {
        listener = next;
        return () => {};
      },
      notify: (text) => reminders.push(text),
    },
    { enabled: true, remindAt: 2, warnAt: 3, stopAt: 4, exemptTools: [] },
    () => {}
  );
  const runId = "run-1" as RunId;
  const read: TurnRoundNotice = {
    runId,
    calls: [{ toolCallId: "c", toolName: "read_file", args: { path: "a.ts" } }],
    results: [{ toolCallId: "c", isError: false, text: "内容" }],
  };
  for (const round of [
    read,
    read,
    { runId, calls: [], results: [], truncated: true as const },
    read,
  ]) {
    listener?.(round);
  }
  assert.equal(reminders.length, 1);
});

test("回看历史：续跑提示显示成程序提示，不像人输入的话", () => {
  const lines = messageLines({
    role: "user",
    blocks: [{ type: "text", text: TRUNCATION_CONTINUE_PROMPT }],
  } as unknown as ViewMessage);
  assert.deepEqual(
    lines.map((line) => line.kind),
    ["notice"]
  );
  assert.ok(lines[0]?.text.startsWith("续跑提示"));
});
