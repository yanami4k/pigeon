// Reviewer 的两个只读工具（M6 S1，决策 064 子裁决 ⑤）：读被审那一次 Run 的冻结快照、
// 按条目号回查该 Run 内的原文。作用域绑定被审 Run——不接受会话参数，跨 Run 与跨会话一律读不到；
// 白名单之外的工具（终端、消息、浏览器、任何写工具）不在 reviewer 角色的广告集里。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveWorkerPolicy } from "../orchestration/roles.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { newEntryId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { REVIEW_ENTRY_TOOL, REVIEW_SNAPSHOT_TOOL } from "../state/review.ts";
import { createReviewTools, reviewToolRegistrations } from "./tools.ts";

function seed(options: { turns: number }): {
  sessionsDir: string;
  sessionId: SessionId;
  runId: RunId;
  otherRunId: RunId;
  otherSessionId: SessionId;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-review-tools-"));
  const sessionsDir = join(dir, "sessions");
  const sessionId = newSessionId();
  const runId = newRunId();
  const otherRunId = newRunId();
  const otherSessionId = newSessionId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  let timestamp = 1;
  let runSeq = 0;
  const entry = (run: RunId, role: "assistant" | "toolResult", text: string) => {
    log.appendEntry({
      runId: run,
      runSeq: ++runSeq,
      role,
      message:
        role === "assistant"
          ? { role: "assistant", content: [{ type: "text", text }] }
          : {
              role: "toolResult",
              toolCallId: `tc-${runSeq}`,
              toolName: "read_file",
              content: [{ type: "text", text }],
              isError: false,
            },
    });
  };
  log.appendRuntimeEvent({
    version: 1,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp: timestamp++,
    kind: "turn.started",
    payload: {},
  });
  for (let turn = 1; turn <= options.turns; turn += 1) {
    entry(runId, "assistant", `被审 Run 的第 ${turn} 段想法`);
    entry(runId, "toolResult", `被审 Run 的第 ${turn} 个工具结果`);
  }
  // 同一会话里的另一个 Run：不得出现在快照里，也不得被回查到
  runSeq = 0;
  entry(otherRunId, "assistant", "另一个 Run 的机密内容");
  log.close();

  // 另一个会话：跨会话一律读不到
  const otherLog = new JsonlEventLog(sessionsDir, otherSessionId);
  otherLog.appendEntry({
    runId: newRunId(),
    runSeq: 1,
    role: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "别的会话的机密内容" }] },
  });
  otherLog.close();

  return {
    sessionsDir,
    sessionId,
    runId,
    otherRunId,
    otherSessionId,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("reviewer 白名单：只有读快照与回查两个只读工具，写档与终端类工具一律不在其中", () => {
  const policy = deriveWorkerPolicy(
    {
      allow: [
        "read_file",
        "edit_file",
        "run_command",
        REVIEW_SNAPSHOT_TOOL,
        REVIEW_ENTRY_TOOL,
        "search_sessions",
      ],
      deny: [],
      approvalMode: "prompt",
    },
    "reviewer"
  );
  assert.deepEqual(policy.allow.sort(), [REVIEW_ENTRY_TOOL, REVIEW_SNAPSHOT_TOOL].sort());
  for (const forbidden of ["edit_file", "run_command", "read_file", "search_sessions"]) {
    assert.equal(policy.allow.includes(forbidden), false, `${forbidden} 不得在 reviewer 白名单里`);
  }
  const registrations = reviewToolRegistrations();
  assert.deepEqual(
    registrations.map((registration) => registration.name).sort(),
    [REVIEW_ENTRY_TOOL, REVIEW_SNAPSHOT_TOOL].sort()
  );
  for (const registration of registrations) {
    assert.equal(registration.tier, "read", "两个工具都是 read 档（自动放行、无写权）");
  }
});

test("读快照：给出被审 Run 的条目号与正文，另一个 Run 的内容不出现", async () => {
  const fixture = seed({ turns: 2 });
  try {
    const tools = createReviewTools({
      sessionsDir: fixture.sessionsDir,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
    });
    const snapshotTool = tools.find((tool) => tool.name === REVIEW_SNAPSHOT_TOOL);
    assert.ok(snapshotTool);
    const result = await snapshotTool.execute("tc-x", {});
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.ok(text.includes("被审 Run 的第 1 段想法"), text.slice(0, 300));
    assert.ok(text.includes("第 1 条"), "条目号可见，供回查定位");
    assert.equal(text.includes("另一个 Run 的机密内容"), false, "别的 Run 不得进快照");
    assert.equal(text.includes("别的会话的机密内容"), false, "别的会话不得进快照");
  } finally {
    fixture.cleanup();
  }
});

test("回查原文：按条目号读本 Run 的原文；越界与非本 Run 的条目号一律拒绝", async () => {
  const fixture = seed({ turns: 2 });
  try {
    const tools = createReviewTools({
      sessionsDir: fixture.sessionsDir,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
    });
    const entryTool = tools.find((tool) => tool.name === REVIEW_ENTRY_TOOL);
    assert.ok(entryTool);
    const ok = await entryTool.execute("tc-y", { runSeq: 3 });
    const text = ok.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.ok(text.includes("被审 Run 的第 2 段想法"), text.slice(0, 300));

    // 条目号 1 在另一个 Run 与另一个会话里同样存在：只能读到被审 Run 的那一条
    const first = await entryTool.execute("tc-w", { runSeq: 1 });
    const firstText = first.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    assert.ok(firstText.includes("被审 Run 的第 1 段想法"), firstText.slice(0, 300));
    assert.equal(firstText.includes("另一个 Run 的机密内容"), false, "不得读到别的 Run");
    assert.equal(firstText.includes("别的会话的机密内容"), false, "不得读到别的会话");

    await assert.rejects(
      () => entryTool.execute("tc-z", { runSeq: 99 }),
      /条目号/,
      "越界条目号响亮失败"
    );
    // 参数里没有会话或 Run 入口：作用域只由装配时绑定的被审 Run 决定
    const params = entryTool.parameters as { properties?: Record<string, unknown> };
    assert.deepEqual(Object.keys(params.properties ?? {}), ["runSeq"]);
  } finally {
    fixture.cleanup();
  }
});
