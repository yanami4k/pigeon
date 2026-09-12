// M4 S5：CLI session list / resume 命令测试（D5：列表默认安静、仅待对账突出；
// resume = 冷恢复对账报告 → 剩余悬账人工确认菜单 → 进入 REPL 续会话）。
// 覆盖：列表渲染（安静行 + 待对账突出行 + 过滤器）、resume 自动确证报告渲染、
// 菜单三个选择对事件文件的影响、[3] 与 EOF 留 pending、进入 REPL 的接线。
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, materializeSession, readEventLogFile } from "../persistence/event-log.ts";
import type { IntentInput } from "../state/event-log.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import {
  type ExecutionId,
  newEntryId,
  newExecutionId,
  newReceiptId,
  newRunId,
  newSessionId,
  type RunId,
  type SessionId,
} from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { snapshotTag } from "../tools/hashline.ts";
import type { AskFn, WriteFn } from "./repl.ts";
import { runResumeCommand, runSessionListCommand } from "./session.ts";

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-cmd-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runtimeEnvelope(
  sessionId: SessionId,
  runId: RunId,
  kind: EventEnvelope["kind"],
  payload: unknown
): EventEnvelope {
  return {
    version: EVENT_ENVELOPE_VERSION,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp: 1_757_000_000_000,
    kind,
    payload,
  };
}

function makeIntentInput(
  runId: RunId,
  toolName: string,
  executionId: ExecutionId,
  contentHashes?: IntentInput["contentHashes"]
): IntentInput {
  return {
    executionId,
    toolCallId: `toolu_${toolName}`,
    toolName,
    rawArgs: { path: "a.ts" },
    decision: { outcome: "approved", approvedBy: "policy:yolo", decidedAt: 1_757_000_000_001 },
    at: 1_757_000_000_000,
    runId,
    ...(contentHashes !== undefined ? { contentHashes } : {}),
  };
}

function makeReceipt(executionId: ExecutionId): Receipt {
  return {
    version: RECEIPT_VERSION,
    id: newReceiptId(),
    executionId,
    toolCallId: "toolu_x",
    approvedBy: "policy:yolo",
    executed: true,
    isError: false,
    startedAt: 1_757_000_000_001,
    finishedAt: 1_757_000_000_002,
    summary: "完成",
  };
}

// 健康会话：一轮正常工具调用（turn 起讫 + intent/receipt 配对 + run.ended）
function writeHealthySession(sessionsDir: string, toolName: string): SessionId {
  const sessionId = newSessionId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  const runId = newRunId();
  const executionId = newExecutionId();
  log.appendRuntimeEvent(runtimeEnvelope(sessionId, runId, RuntimeEventKind.TurnStarted, {}));
  log.appendRuntimeEvent(
    runtimeEnvelope(sessionId, runId, RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
    })
  );
  log.appendIntent(makeIntentInput(runId, toolName, executionId));
  log.appendReceipt({ receipt: makeReceipt(executionId), runId });
  log.appendRuntimeEvent(
    runtimeEnvelope(sessionId, runId, RuntimeEventKind.RunEnded, { messageCount: 0 })
  );
  log.close();
  return sessionId;
}

// 崩溃残留会话：intent 落盘后进程死亡（无 receipt）→ 待对账
function writeCrashedSession(
  sessionsDir: string,
  toolName: string,
  contentHashes?: IntentInput["contentHashes"]
): { sessionId: SessionId; executionId: ExecutionId } {
  const sessionId = newSessionId();
  const executionId = newExecutionId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  log.appendIntent(makeIntentInput(newRunId(), toolName, executionId, contentHashes));
  log.close();
  return { sessionId, executionId };
}

// 队列式问答：按序吐答案，取尽后返回 null（EOF 语义）
function queuedAsker(answers: Array<string | null>): { ask: AskFn; prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  const ask: AskFn = (prompt) => {
    prompts.push(prompt);
    const answer = index < answers.length ? answers[index] : null;
    index += 1;
    return Promise.resolve(answer ?? null);
  };
  return { ask, prompts };
}

test("session list：安静行（时间 + Run 数 + 会话 id），仅待对账会话有突出行，无徽章图标", () => {
  const { root, cleanup } = makeRoot();
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const healthy = writeHealthySession(sessionsDir, "edit_file");
    const crashed = writeCrashedSession(sessionsDir, "read_file");

    const output = runSessionListCommand({ root });
    // 两个会话各一行安静行（UTC 时间 + Run 数 + 短会话 id 不强制——完整 id 便于 resume 取用）
    assert.ok(output.includes(healthy));
    assert.ok(output.includes(crashed.sessionId));
    assert.match(output, /1 个 Run/);
    // 待对账突出行：逐字措辞（D5 人话 + 动作提示），且只出现在崩溃会话那一行附近
    assert.ok(output.includes("1 条待对账（上次会话异常中断，用 resume 处理）"));
    const pendingLine = output.split("\n").find((line) => line.includes("条待对账"));
    assert.ok(pendingLine !== undefined);
    assert.ok(
      !pendingLine.includes("✔") && !pendingLine.includes("⚠") && !pendingLine.includes("✖")
    );
    // 健康会话行不带待对账措辞
    const healthyLine = output.split("\n").find((line) => line.includes(healthy));
    assert.ok(healthyLine !== undefined && !healthyLine.includes("待对账"));
  } finally {
    cleanup();
  }
});

test("session list：过滤器透传（tool / class / since / until）与空目录文案", () => {
  const { root, cleanup } = makeRoot();
  try {
    const empty = runSessionListCommand({ root });
    assert.ok(empty.includes("尚无会话记录"));

    const sessionsDir = join(root, ".pigeon", "sessions");
    const healthy = writeHealthySession(sessionsDir, "edit_file");
    const crashed = writeCrashedSession(sessionsDir, "read_file");

    const byTool = runSessionListCommand({ root, filters: { tool: "read_file" } });
    assert.ok(byTool.includes(crashed.sessionId) && !byTool.includes(healthy));
    const byClass = runSessionListCommand({ root, filters: { class: "unknown" } });
    assert.ok(byClass.includes(crashed.sessionId));
    assert.ok(byClass.includes("1 条待对账"));
    const sinceFuture = runSessionListCommand({
      root,
      filters: { since: Date.now() + 86_400_000 },
    });
    assert.ok(sinceFuture.includes("尚无会话记录"));
  } finally {
    cleanup();
  }
});

test("resume：自动确证报告渲染（哈希比对 executed / not-executed）+ 菜单 [1] 写 human-confirmed executed", async () => {
  const { root, cleanup } = makeRoot();
  try {
    // 工作区文件现状 = 预期改后态 → 悬账 1 自动确证 executed；悬账 2 无哈希 → 留人确认
    writeFileSync(join(root, "a.ts"), "beta\n");
    const sessionsDir = join(root, ".pigeon", "sessions");
    const auto = writeCrashedSession(sessionsDir, "edit_file", {
      path: "a.ts",
      beforeHash: snapshotTag("alpha\n"),
      expectedAfterHash: snapshotTag("beta\n"),
    });
    const manual = writeCrashedSession(sessionsDir, "edit_file");

    const outputs: string[] = [];
    const write: WriteFn = (text) => outputs.push(text);
    const { ask, prompts } = queuedAsker(["1"]);
    let replEntered = 0;
    await runResumeCommand({
      root,
      sessionId: manual.sessionId,
      ask,
      write,
      enterRepl: async () => {
        replEntered += 1;
      },
    });

    const output = outputs.join("");
    // 报告：本次自动确证 1 条（executed），剩余 1 条进入菜单
    assert.ok(output.includes("自动确证"));
    assert.ok(output.includes("已执行"));
    assert.ok(output.includes("待对账 1/1"));
    // 菜单提示注入的问答
    assert.ok(prompts.some((prompt) => prompt.includes("[1/2/3]")));
    // 事件文件：manual 会话新增 human-confirmed executed 确证记录
    const records = readEventLogFile(JsonlEventLog.filePathFor(sessionsDir, manual.sessionId));
    const resolutions = records.flatMap((record) => (record.kind === "resolution" ? [record] : []));
    assert.equal(resolutions.length, 1);
    const [resolution] = resolutions;
    assert.ok(resolution !== undefined);
    assert.equal(resolution.executionId, manual.executionId);
    assert.equal(resolution.outcome, "executed");
    assert.equal(resolution.method, "human-confirmed");
    assert.equal(resolution.evidence, undefined);
    // 重新物化：悬账已销，不再滞留 unknown
    const after = materializeSession(sessionsDir, manual.sessionId);
    assert.equal(after.reconcile.unknown.length, 0);
    assert.equal(after.reconcile.resolved.length, 1);
    // 收尾提示 + 进入 REPL
    assert.ok(output.includes("模型对话上下文重新建立（Pi transcript 不恢复）"));
    assert.equal(replEntered, 1);
    // auto 会话不被本次 resume 触碰：哈希确证只发生在它自己被恢复时，悬账原样保留
    assert.equal(
      materializeSession(sessionsDir, auto.sessionId).reconcile.unknown.length,
      1,
      "未被 resume 的会话保持原状"
    );
  } finally {
    cleanup();
  }
});

test("resume：菜单 [2] 写 human-confirmed not-executed；[3] 留 pending 不写记录", async () => {
  const { root, cleanup } = makeRoot();
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const first = writeCrashedSession(sessionsDir, "edit_file");
    const second = writeCrashedSession(sessionsDir, "read_file");

    const outputs: string[] = [];
    const { ask } = queuedAsker(["2", "3"]);
    await runResumeCommand({
      root,
      sessionId: first.sessionId,
      ask,
      write: (text) => outputs.push(text),
      enterRepl: async () => {},
    });
    let records = readEventLogFile(JsonlEventLog.filePathFor(sessionsDir, first.sessionId));
    let resolutions = records.flatMap((record) => (record.kind === "resolution" ? [record] : []));
    assert.equal(resolutions.length, 1);
    const [resolution] = resolutions;
    assert.ok(resolution !== undefined);
    assert.equal(resolution.outcome, "not-executed");
    assert.equal(resolution.method, "human-confirmed");

    await runResumeCommand({
      root,
      sessionId: second.sessionId,
      ask: queuedAsker(["3"]).ask,
      write: (text) => outputs.push(text),
      enterRepl: async () => {},
    });
    records = readEventLogFile(JsonlEventLog.filePathFor(sessionsDir, second.sessionId));
    resolutions = records.filter((record) => record.kind === "resolution");
    assert.equal(resolutions.length, 0, "[3] 先不管：不写确证记录");
    // 重新物化：悬账原样滞留 OutcomeUnknown（§3.2 只留证不重放）
    const materialized = materializeSession(sessionsDir, second.sessionId);
    assert.equal(materialized.reconcile.unknown.length, 1);
    assert.equal(materialized.reconcile.unknown[0]?.intent.executionId, second.executionId);
  } finally {
    cleanup();
  }
});

test("resume：非法输入重问、EOF 视为先不管，仍进入 REPL；会话不存在响亮报错", async () => {
  const { root, cleanup } = makeRoot();
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const crashed = writeCrashedSession(sessionsDir, "edit_file");

    // 非法输入 "x" 重问，随后 "1" 确认已执行
    const outputs: string[] = [];
    const { ask, prompts } = queuedAsker(["x", "1"]);
    let entered = 0;
    await runResumeCommand({
      root,
      sessionId: crashed.sessionId,
      ask,
      write: (text) => outputs.push(text),
      enterRepl: async () => {
        entered += 1;
      },
    });
    assert.equal(
      prompts.filter((prompt) => prompt.includes("[1/2/3]")).length,
      2,
      "非法输入不消费悬账，重问一次"
    );
    assert.equal(entered, 1);
    assert.equal(
      readEventLogFile(JsonlEventLog.filePathFor(sessionsDir, crashed.sessionId)).filter(
        (record) => record.kind === "resolution"
      ).length,
      1
    );

    // 另一个会话：EOF（无答案）→ 留 pending，仍进入 REPL
    const quiet = writeCrashedSession(sessionsDir, "read_file");
    let enteredQuiet = 0;
    await runResumeCommand({
      root,
      sessionId: quiet.sessionId,
      ask: queuedAsker([]).ask,
      write: (text) => outputs.push(text),
      enterRepl: async () => {
        enteredQuiet += 1;
      },
    });
    assert.equal(enteredQuiet, 1, "EOF 不阻塞进入 REPL");
    assert.equal(materializeSession(sessionsDir, quiet.sessionId).reconcile.unknown.length, 1);

    // 不存在的会话：响亮报错并给出可选项
    await assert.rejects(
      runResumeCommand({
        root,
        sessionId: `sess_${"Z".repeat(26)}`,
        ask: queuedAsker([]).ask,
        write: () => {},
        enterRepl: async () => {},
      }),
      /会话不存在/
    );
  } finally {
    cleanup();
  }
});

test("resume：冷恢复屏汇总既往落盘缺口（撕裂尾巴 / entry 断号 / 孤儿记录）；无缺口才说证据链完整", async () => {
  const { root, cleanup } = makeRoot();
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    // 对照组：健康会话 → 证据链完整
    const healthy = writeHealthySession(sessionsDir, "edit_file");
    const healthyOutputs: string[] = [];
    await runResumeCommand({
      root,
      sessionId: healthy,
      ask: queuedAsker([]).ask,
      write: (text) => healthyOutputs.push(text),
      enterRepl: async () => {},
    });
    const healthyOutput = healthyOutputs.join("");
    assert.ok(healthyOutput.includes("剩余待对账：无，证据链完整。"), healthyOutput);
    assert.ok(!healthyOutput.includes("既往缺口"), healthyOutput);

    // 缺口会话：entry 断号 ×2（缺 2；run.ended 报 4 条缺 4）+ 孤儿 Receipt ×1 + 撕裂尾巴
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(sessionsDir, sessionId);
    log.appendEntry({ runSeq: 1, role: "user", runId });
    log.appendEntry({ runSeq: 3, role: "assistant", runId });
    log.appendReceipt({ receipt: makeReceipt(newExecutionId()), runId });
    log.appendRuntimeEvent(
      runtimeEnvelope(sessionId, runId, RuntimeEventKind.RunEnded, { messageCount: 4 })
    );
    log.close();
    appendFileSync(
      JsonlEventLog.filePathFor(sessionsDir, sessionId),
      '{"version":5,"id":"entry_',
      "utf8"
    );

    const outputs: string[] = [];
    await runResumeCommand({
      root,
      sessionId,
      ask: queuedAsker([]).ask,
      write: (text) => outputs.push(text),
      enterRepl: async () => {},
    });
    const output = outputs.join("");
    assert.ok(!output.includes("证据链完整"), `有缺口不得声称证据链完整\n${output}`);
    assert.ok(output.includes("剩余待对账：无。"), output);
    assert.ok(output.includes("既往缺口（文件形态派生）："), output);
    assert.ok(output.includes("会话文件末尾撕裂写：1 处（半截记录已按未持久化丢弃）"), output);
    assert.ok(output.includes("entry 映射断号：2 条（写盘失败留证缺口）"), output);
    assert.ok(output.includes("孤儿记录：1 条（Receipt/Resolution 无对应 intent）"), output);
    // 缺口只呈现不修补：resume 后文件仍是撕裂形态之外零新增记录（无悬账 → 无 resolution）
    const after = materializeSession(sessionsDir, sessionId);
    assert.equal(after.tornTail, true);
    assert.equal(after.resolutions.length, 0);
  } finally {
    cleanup();
  }
});

test("resume：run.ended 缺失的崩溃残留 Run 计入既往缺口汇总，不说证据链完整（M4 验收 O-3）", async () => {
  const { root, cleanup } = makeRoot();
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(sessionsDir, sessionId);
    log.appendRuntimeEvent(runtimeEnvelope(sessionId, runId, RuntimeEventKind.TurnStarted, {}));
    log.appendRuntimeEvent(
      runtimeEnvelope(sessionId, runId, RuntimeEventKind.TurnCompleted, {
        stopReason: "toolUse",
        syntheticFailure: false,
      })
    );
    log.close();

    const outputs: string[] = [];
    await runResumeCommand({
      root,
      sessionId,
      ask: queuedAsker([]).ask,
      write: (text) => outputs.push(text),
      enterRepl: async () => {},
    });
    const output = outputs.join("");
    assert.ok(!output.includes("证据链完整"), `崩溃残留不得声称证据链完整\n${output}`);
    assert.ok(output.includes("既往缺口（文件形态派生）："), output);
    assert.ok(
      output.includes("崩溃残留：1 个 Run 无 run.ended（用 trace 或 replay 查看中断位置）"),
      output
    );
  } finally {
    cleanup();
  }
});
