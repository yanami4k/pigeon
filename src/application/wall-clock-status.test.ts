// 决策 418：墙钟预算对模型可见——开工状态写明总预算；分钟数变化不单独追加，剩余时间跌破档位才追加，别的节变化时随之带上
// 当前的已用与剩余；跌破 20% 时提醒恰好一次；pigeon run 设了预算才有这几节，run_command 的超时随之按剩余时间夹取。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { ExecEvidence } from "../tools/run-command.ts";
import { runHeadless } from "./headless-core.ts";
import { type StatusSectionName, StatusTracker } from "./status-block.ts";
import { statusTextOf } from "./status-fixtures.ts";
import { BUDGET_REMINDER_TEXT, budgetStatus, type WallClockBudget } from "./wall-clock-status.ts";

const MINUTE = 60_000;
const sections = (text: string | undefined) =>
  [...(text ?? "").matchAll(/<pigeon-section name="([^"]+)">/g)].map((match) => match[1]);

test("时间预算：同一档内不追加，跌破档位追加，别的节变化时带上当前值；跌破 20% 提醒恰好一次", () => {
  let now = 1_000_000;
  const budget: WallClockBudget = { totalMs: 10 * MINUTE, startedAt: now, now: () => now };
  const tracker = new StatusTracker();
  let git = "工作区没有未提交的改动";
  const sent: string[] = [];
  const step = (elapsed: number): string | undefined => {
    now = budget.startedAt + elapsed;
    const extra = budgetStatus(budget, { runCommand: true });
    const state = new Map<StatusSectionName, string>([["Git status", git], ...extra.sections]);
    const text = tracker.next(state, false, extra.keys);
    tracker.delivered();
    if (text !== undefined) sent.push(text);
    return text;
  };
  assert.match(step(0) ?? "", /wall-clock budget of 10 minutes/);
  assert.equal(step(1 * MINUTE), undefined, "同一档内分钟数变了不追加");
  const crossed = step(2.5 * MINUTE);
  // 决策 428：节名给模型看的是英文名
  assert.deepEqual(sections(crossed), ["Time budget"]);
  assert.match(crossed ?? "", /about 7 minutes is left/);
  git = "工作区有未提交的改动";
  const riding = step(3 * MINUTE);
  assert.deepEqual(sections(riding), ["Git status", "Time budget"]);
  assert.match(riding ?? "", /about 3 minutes has been used/);
  assert.equal(step(7.9 * MINUTE)?.includes(BUDGET_REMINDER_TEXT), false);
  assert.deepEqual(sections(step(8.5 * MINUTE)), ["Time budget", "Time reminder"]);
  assert.equal(step(9 * MINUTE), undefined);
  assert.equal(sent.filter((text) => text.includes(BUDGET_REMINDER_TEXT)).length, 1);
});

test("pigeon run：设了墙钟预算时开工状态带时间预算、run_command 的超时按剩余时间缩短；未设时都没有", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-wall-clock-"));
  try {
    for (const wallClockMs of [10 * MINUTE, undefined]) {
      const streamFn = createFakeStreamFn({
        replies: [
          {
            text: "跑",
            toolCalls: [
              {
                name: "run_command",
                args: { command: `"${process.execPath}" -e "1"`, timeout_seconds: 600 },
              },
            ],
          },
          { text: "好了" },
        ],
      });
      await runHeadless({
        task: "跑一条命令",
        governanceRoot: root,
        workspaceRoot: root,
        streamFn,
        yolo: true,
        homeDir: root,
        ...(wallClockMs !== undefined ? { wallClockMs } : {}),
      });
      const [first, second] = streamFn.calls;
      const result = second?.context.messages.find((message) => message.role === "toolResult");
      const evidence = (result as { details?: ExecEvidence } | undefined)?.details;
      assert.equal(evidence?.exitCode, 0, "命令照常执行、结果带执行证据");
      const shortened = evidence?.timeoutShortened;
      if (wallClockMs !== undefined) {
        assert.match(
          statusTextOf(first),
          /<pigeon-section name="Time budget">\n[^\n]*wall-clock budget of 10 minutes/
        );
        assert.ok(shortened !== undefined && shortened.appliedSeconds <= 570, String(shortened));
      } else {
        assert.doesNotMatch(statusTextOf(first), /Time budget/);
        assert.equal(shortened, undefined);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
