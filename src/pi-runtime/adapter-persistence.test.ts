// M4 S1：Event Log 持久化 + 崩溃对账测试（M3 切片 5 测试的 Event Log 改写——
// 账本已归并进 Event Log，对账改走冷物化 materializeSession，分类语义逐字不变）。
// 崩溃点模拟说明：上游保证 tool_execution_end 必到（spike S6），活进程内无法复现
// "死于 end 事件前"——按任务约定用"写一半的事件文件 + 冷物化对账"模拟：
//   ① intent 已写、execute 未跑 → 事件日志直写半态；
//   ② execute 已跑、receipt 未写 → 故障注入事件日志（appendReceipt 抛错）+ 完整真实 Run。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import {
  type DecisionRecord,
  type EventRecord,
  type IntentRecord,
  JsonlEventLog,
  materializeSession,
  recoverSession,
} from "../persistence/event-log.ts";
import {
  asExecutionId,
  newEntryId,
  newExecutionId,
  newRunId,
  newSessionId,
  type SessionId,
} from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import type { ToolSettledPayload } from "./events.ts";
import { createFakeStreamFn } from "./fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

function makeWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-persist-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// D1 布局下的 per-session 事件日志（<root>/.pigeon/sessions/sess_<ulid>.jsonl）
function makeEventLog(root: string): {
  eventLog: JsonlEventLog;
  sessionsDir: string;
  sessionId: SessionId;
} {
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  return { eventLog: new JsonlEventLog(sessionsDir, sessionId), sessionsDir, sessionId };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "读取工作区内文件内容",
    parameters: Type.Object({ path: Type.String() }),
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "parallel",
  });
  registry.register({
    name: "edit_file",
    description: "hashline 锚定稀疏编辑",
    parameters: Type.Object({}),
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  return registry;
}

function makeSnapshot(approvalMode: "prompt" | "yolo", deny: string[] = []): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: {
      policy: { allow: ["read_file", "edit_file"], deny, approvalMode },
      advertised: [],
    },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
}

function editCall(content: string): EditFileParams {
  return {
    path: "a.ts",
    snapshot: snapshotTag(content),
    edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
  };
}

// 读事件文件的逐行 JSON
function readEventLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("批准执行路径：dispatch 前落 intent，end 后落 receipt，冷物化对账配对，账本回填 receiptId", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("prompt"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      approvalHandler: async () => ({ approved: true }),
      sessionId,
      eventLog,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");

    // 治理族各一行：intent 在 dispatch 前、receipt 在 end 后（文件内 intent 先于 receipt）
    const lines = readEventLines(eventLog.path);
    const intent = lines.find((line) => line.kind === "intent") as unknown as IntentRecord;
    const receiptLine = lines.find((line) => line.kind === "receipt");
    assert.ok(intent, "批准路径必须落 intent 记录");
    assert.ok(receiptLine, "批准路径必须落 receipt 记录");
    assert.ok(lines.indexOf(intent as never) < lines.indexOf(receiptLine as never));
    assert.equal(intent.executionId, (receiptLine as { receipt: Receipt }).receipt.executionId);
    // 信封：sessionId/runId 与本次 Run 一致
    assert.equal(intent.sessionId, sessionId);
    assert.equal(intent.runId, result.runId);
    assert.equal(receiptLine?.runId, result.runId);

    // intent 携带决定快照（approvedBy 证据链）与模型原始参数
    assert.equal(intent.decision.approvedBy, "human");
    assert.deepEqual(intent.rawArgs, editCall(original));

    // receipt：executed=true、approvedBy=human
    const receipt = (receiptLine as { receipt: Receipt }).receipt;
    assert.equal(receipt.version, RECEIPT_VERSION);
    assert.equal(receipt.executed, true);
    assert.equal(receipt.isError, false);
    assert.equal(receipt.approvedBy, "human");

    // ToolExecution 账本回填 receiptId（三层关联 executionId/toolCallId/receiptId）
    const record = result.toolExecutions[0];
    assert.ok(record);
    assert.equal(record.receiptId, receipt.id);

    // 冷物化对账：全量读事件文件，配对 settled
    const report = materializeSession(sessionsDir, sessionId).reconcile;
    assert.equal(report.settled.length, 1);
    assert.equal(report.unknown.length, 0);

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("人工拒绝路径：decision 落盘（理由逐字）+ receipt executed=false，对账归 rejected 非 unknown", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("prompt"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall("x\ny\n") }] },
          { text: "好吧" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      approvalHandler: async () => ({ approved: false, reason: "不准" }),
      sessionId,
      eventLog,
    });

    await adapter.run("改文件");
    const lines = readEventLines(eventLog.path);
    // 拒绝的调用：decision（拒绝理由逐字留证）+ receipt；intent 只在 dispatch 前写，拒绝路径没有
    const persisted = lines.find((line) => line.kind === "decision") as unknown as DecisionRecord;
    assert.ok(persisted, "拒绝路径必须落 decision 记录");
    assert.equal(
      lines.filter((line) => line.kind === "intent").length,
      0,
      "拒绝发生于 dispatch 前，不得有 intent"
    );
    const receiptLine = lines.find((line) => line.kind === "receipt");
    assert.ok(receiptLine, "拒绝路径必须落 receipt 记录（executed=false 闭环）");
    assert.equal(persisted.executionId, (receiptLine as { receipt: Receipt }).receipt.executionId);
    assert.equal(persisted.decision.outcome, "rejected");
    assert.equal(persisted.decision.approvedBy, "human");
    assert.equal(persisted.decision.reason, "不准");
    const receipt = (receiptLine as { receipt: Receipt }).receipt;
    assert.equal(receipt.executed, false);
    assert.equal(receipt.approvedBy, "human");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);

    // 冷物化对账：decision+receipt 配对归 rejected，无副作用可能，不落 OutcomeUnknown
    const report = materializeSession(sessionsDir, sessionId).reconcile;
    assert.equal(report.rejected.length, 1);
    assert.equal(report.unknown.length, 0);
    assert.equal(report.orphanReceipts.length, 0);

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("deny 清单路径：decision 落盘 approvedBy=policy:deny，理由逐字留证", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("prompt", ["edit_file"]),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall("x\ny\n") }] },
          { text: "好吧" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      approvalHandler: async () => ({ approved: true }),
      sessionId,
      eventLog,
    });

    await adapter.run("改文件");
    const lines = readEventLines(eventLog.path);
    const persisted = lines.find((line) => line.kind === "decision") as unknown as DecisionRecord;
    assert.ok(persisted, "deny 路径必须落 decision 记录");
    assert.equal(persisted.decision.outcome, "rejected");
    assert.equal(persisted.decision.approvedBy, "policy:deny");
    assert.equal(persisted.decision.reason, "deny 清单精确匹配，任何模式一律拒绝：edit_file");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
    // 阻断必须对模型可见：deny 理由逐字成为 error toolResult，而非执行输出（P2-3 闭环——
    // 若 deny 分支被改成放行，edit_file 真实执行（锚点失配预检失败），toolResult 文本变掉，此处变红）
    const toolResult = adapter.transcript().find((message) => message.role === "toolResult");
    assert.ok(toolResult && toolResult.role === "toolResult");
    assert.equal(toolResult.isError, true);
    const text = toolResult.content[0];
    assert.ok(
      text?.type === "text" && text.text === "deny 清单精确匹配，任何模式一律拒绝：edit_file",
      JSON.stringify(toolResult)
    );

    const report = materializeSession(sessionsDir, sessionId).reconcile;
    assert.equal(report.rejected.length, 1);
    assert.equal(report.unknown.length, 0);

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("未配置审批通道 fail-closed：decision 落盘 approvedBy=policy:deny", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionId } = makeEventLog(root);
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("prompt"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall("x\ny\n") }] },
          { text: "好吧" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      // 故意不传 approvalHandler：prompt 模式 fail-closed 拒绝
      sessionId,
      eventLog,
    });

    await adapter.run("改文件");
    const lines = readEventLines(eventLog.path);
    const persisted = lines.find((line) => line.kind === "decision") as unknown as DecisionRecord;
    assert.ok(persisted, "fail-closed 路径必须落 decision 记录");
    assert.equal(persisted.decision.outcome, "rejected");
    assert.equal(persisted.decision.approvedBy, "policy:deny");
    assert.equal(persisted.decision.reason, "策略要求人工审批但未配置审批通道（fail-closed）");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
    // 阻断必须对模型可见：fail-closed 理由逐字成为 error toolResult（P2-3 闭环）。
    // 模型可见理由无"（fail-closed）"后缀——落盘理由与回模型理由在 adapter.ts 是两处传参
    const toolResult = adapter.transcript().find((message) => message.role === "toolResult");
    assert.ok(toolResult && toolResult.role === "toolResult");
    assert.equal(toolResult.isError, true);
    const text = toolResult.content[0];
    assert.ok(
      text?.type === "text" && text.text === "策略要求人工审批但未配置审批通道",
      JSON.stringify(toolResult)
    );

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("decision 写盘失败不改变拒绝结果：理由逐字回模型，故障进 listenerErrors", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionId } = makeEventLog(root);
  try {
    const poison = {
      appendRuntimeEvent: eventLog.appendRuntimeEvent.bind(eventLog),
      appendIntent: eventLog.appendIntent.bind(eventLog),
      appendDecision: () => {
        throw new Error("模拟磁盘写失败：decision 未落盘");
      },
      appendReceipt: eventLog.appendReceipt.bind(eventLog),
      appendBreaker: eventLog.appendBreaker.bind(eventLog),
    };
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("prompt"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall("x\ny\n") }] },
          { text: "好吧" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      approvalHandler: async () => ({ approved: false, reason: "不准" }),
      sessionId,
      eventLog: poison,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    // 结果不变：仍按原理由阻断，文件零改动
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
    assert.equal(result.toolExecutions[0]?.decision?.outcome, "rejected");
    assert.equal(result.toolExecutions[0]?.decision?.reason, "不准");
    // 故障响亮记录（listenerErrors），不是静默吞掉
    assert.ok(adapter.listenerErrors().length > 0);

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("崩溃点①：intent 已写、execute 未跑（半态事件文件）→ 冷物化对账 OutcomeUnknown，无重放", () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "alpha\nbeta\n" });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    // 模拟进程死于 hook 放行后 / execute 前：事件日志里只有 intent
    eventLog.appendIntent({
      executionId: asExecutionId("exec_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
      toolCallId: "toolu_crash1",
      toolName: "edit_file",
      rawArgs: { path: "a.ts" },
      decision: { outcome: "approved", approvedBy: "human", decidedAt: 1_757_000_000_001 },
      at: 1_757_000_000_000,
      runId: newRunId(),
    });
    eventLog.close();

    // 冷物化对账（等价于新进程全量读）
    const report = materializeSession(sessionsDir, sessionId).reconcile;
    assert.equal(report.settled.length, 0);
    assert.equal(report.unknown.length, 1);
    assert.equal(report.unknown[0]?.intent.executionId, "exec_01J5Z7K8W9ABCDEFGHJKMNPQRS");
    assert.equal(report.unknown[0]?.receipt, undefined);
    // 无重放：对账只读报告，事件文件与文件系统均无变化
    assert.equal(readEventLines(eventLog.path).length, 1);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nbeta\n");
  } finally {
    cleanup();
  }
});

test("崩溃点②：execute 已跑、receipt 未写（故障注入事件日志）→ OutcomeUnknown，副作用已发生但不盲重放", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    // 故障注入：receipt 写盘即抛错，模拟进程死于 tool_execution_end 前
    const poison = {
      appendRuntimeEvent: eventLog.appendRuntimeEvent.bind(eventLog),
      appendIntent: eventLog.appendIntent.bind(eventLog),
      appendDecision: eventLog.appendDecision.bind(eventLog),
      appendBreaker: eventLog.appendBreaker.bind(eventLog),
      appendReceipt: () => {
        throw new Error("模拟进程崩溃：receipt 未落盘");
      },
    };
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("yolo"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog: poison,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    // 副作用真实发生了（文件已改），但 receipt 从未落盘
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");
    assert.equal(readEventLines(eventLog.path).filter((line) => line.kind === "receipt").length, 0);
    // 故障被响亮记录（listenerErrors），不是静默吞掉
    assert.ok(adapter.listenerErrors().length > 0);

    // 冷物化对账：intent 无 receipt → OutcomeUnknown（副作用是否发生日志无法确认）
    const report = materializeSession(sessionsDir, sessionId).reconcile;
    assert.equal(report.unknown.length, 1);
    assert.equal(report.settled.length, 0);
    // 无重放：对账后事件文件仍只有一条 intent，没有任何自动重试产生新记录
    assert.equal(readEventLines(eventLog.path).filter((line) => line.kind === "intent").length, 1);

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("账本写盘失败 = fail-closed：intent 写不进就不放行，execute 不发生", async () => {
  const original = "alpha\nbeta\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionId } = makeEventLog(root);
  try {
    const broken = {
      appendRuntimeEvent: eventLog.appendRuntimeEvent.bind(eventLog),
      appendIntent: () => {
        throw new Error("模拟磁盘写失败");
      },
      appendDecision: eventLog.appendDecision.bind(eventLog),
      appendBreaker: eventLog.appendBreaker.bind(eventLog),
      appendReceipt: eventLog.appendReceipt.bind(eventLog),
    };
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("yolo"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "明白" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog: broken,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    // 写盘失败 → 阻断，文件零改动
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
    // 事件文件无任何治理记录（intent 写失败），被拦调用也不产生 receipt（从未 dispatch）；
    // 观察族事件（turn/tool）照常落盘——它们不是副作用证据
    const lines = readEventLines(eventLog.path);
    assert.equal(lines.filter((line) => line.kind === "intent").length, 0);
    assert.equal(lines.filter((line) => line.kind === "receipt").length, 0);
    assert.ok(lines.some((line) => line.kind === "tool.proposed"));

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("闸内异常循环熔断：账本持续写失败 + 模型坚持重发，计数到阈值后 aborted", async () => {
  const original = "alpha\nbeta\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionId } = makeEventLog(root);
  try {
    const broken = {
      appendRuntimeEvent: eventLog.appendRuntimeEvent.bind(eventLog),
      appendIntent: () => {
        throw new Error("模拟磁盘持续写失败");
      },
      appendDecision: eventLog.appendDecision.bind(eventLog),
      appendBreaker: eventLog.appendBreaker.bind(eventLog),
      appendReceipt: eventLog.appendReceipt.bind(eventLog),
    };
    // 闸内异常 fail-closed 的阻断必须过熔断计数：否则磁盘满 + 顽固模型 = 无限阻断循环
    const stubbornReplies = Array.from({ length: 10 }, () => ({
      text: "再试",
      toolCalls: [{ name: "edit_file", args: editCall(original) }],
    }));
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("yolo"),
      streamFn: createFakeStreamFn({ replies: [...stubbornReplies, { text: "放弃" }] }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog: broken,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "aborted");
    assert.equal(result.toolExecutions.length, 3);
    // fail-closed 语义不变：intent 写不进就不放行，文件零改动
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("receipt 写盘失败不吞事件：tool.settled 照常入事件日志并转发，故障进 listenerErrors", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    const poison = {
      appendRuntimeEvent: eventLog.appendRuntimeEvent.bind(eventLog),
      appendIntent: eventLog.appendIntent.bind(eventLog),
      appendDecision: eventLog.appendDecision.bind(eventLog),
      appendBreaker: eventLog.appendBreaker.bind(eventLog),
      appendReceipt: () => {
        throw new Error("模拟磁盘写失败：receipt 未落盘");
      },
    };
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("yolo"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog: poison,
    });
    // 外部 listener：事件转发必须不受账本故障影响
    const forwarded: string[] = [];
    adapter.subscribe((event) => {
      forwarded.push(event.kind);
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    // 副作用已发生、receipt 未落盘：故障响亮记录，不是静默吞掉
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");
    assert.ok(adapter.listenerErrors().length > 0);
    // 事件日志是审计轨迹（决策 ①）：tool.settled 无条件在列（内存与落盘双侧），
    // 且与账本 toolCallId 对齐
    const record = result.toolExecutions[0];
    assert.ok(record);
    const settled = adapter.events().find((event) => event.kind === "tool.settled");
    assert.ok(settled, "receipt 写盘失败不得让 tool.settled 从事件日志丢失");
    const settledPayload = settled.payload as ToolSettledPayload;
    assert.equal(settledPayload.toolCallId, record.toolCallId);
    assert.ok(forwarded.includes("tool.settled"), "receipt 写盘失败不得拦截事件转发");
    const persisted = materializeSession(sessionsDir, sessionId);
    assert.ok(
      persisted.runtimeEvents.some((event) => event.kind === "tool.settled"),
      "receipt 写盘失败不得让 tool.settled 从事件文件丢失"
    );

    // 冷物化对账语义不变：intent 无 receipt → OutcomeUnknown，不盲重放
    assert.equal(persisted.reconcile.unknown.length, 1);
    assert.equal(persisted.reconcile.settled.length, 0);

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("冷物化 ≡ 活适配器状态：脚本化 Run 后事件序列与对账结果逐一相符", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("prompt"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      approvalHandler: async () => ({ approved: true }),
      sessionId,
      eventLog,
    });
    const result = await adapter.run("改文件");
    eventLog.close();

    const materialized = materializeSession(sessionsDir, sessionId);
    // 运行时事件序列 ≡ 活适配器内存事件日志（kind 与 EntryId 逐一对齐，顺序一致）
    const live = adapter.events();
    assert.deepEqual(
      materialized.runtimeEvents.map((event) => [event.kind, event.id]),
      live.map((event) => [event.kind, event.id])
    );
    // 治理族 ≡ 活适配器 ToolExecution 账本：settled 配对的 executionId/toolCallId/receiptId
    const record = result.toolExecutions[0];
    assert.ok(record);
    assert.equal(materialized.reconcile.settled.length, 1);
    const entry = materialized.reconcile.settled[0];
    assert.equal(entry?.intent.executionId, record.executionId);
    assert.equal(entry?.intent.toolCallId, record.toolCallId);
    assert.equal(entry?.receipt?.id, record.receiptId);
    assert.equal(materialized.reconcile.unknown.length, 0);
    // 全部记录都属于本 session 与本次 Run
    assert.ok(materialized.records.every((r: EventRecord) => r.sessionId === sessionId));
    assert.ok(materialized.records.every((r: EventRecord) => r.runId === result.runId));

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("哈希证据：intent 携带改前/预期改后哈希，receipt 携带实测改后哈希", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionId } = makeEventLog(root);
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("yolo"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");

    const lines = readEventLines(eventLog.path);
    const intent = lines.find((line) => line.kind === "intent");
    assert.ok(intent);
    // dispatch 准备期探针：改前实测 + 预期改后确定性推出（snapshotTag 16 位十六进制）
    assert.deepEqual(intent.contentHashes, {
      path: "a.ts",
      beforeHash: snapshotTag(original),
      expectedAfterHash: snapshotTag("alpha\nBETA\ngamma\n"),
    });
    const receipt = (lines.find((line) => line.kind === "receipt") as { receipt: Receipt }).receipt;
    assert.equal(receipt.contentAfterHash, snapshotTag("alpha\nBETA\ngamma\n"));

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("域错误分类：锚点不匹配 → settled 事件携带 errorKind=domain（内存与落盘一致）", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionId } = makeEventLog(root);
  try {
    // 锚点 tag 不匹配（合法格式、错误内容）→ EditFileError = 工具域错误
    const badCall: EditFileParams = {
      path: "a.ts",
      snapshot: snapshotTag(original),
      edits: [{ op: "replace", anchor: "2#0000", lines: ["BETA"] }],
    };
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("yolo"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: badCall }] },
          { text: "明白" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    // 域错误：文件零改动
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);

    const live = adapter.events().find((event) => event.kind === "tool.settled");
    assert.equal((live?.payload as ToolSettledPayload).errorKind, "domain");
    const persisted = readEventLines(eventLog.path).find((line) => line.kind === "tool.settled");
    assert.equal((persisted?.payload as ToolSettledPayload).errorKind, "domain");
    // receipt：isError=true 且副作用未发生；探针因锚点预检失败降级 → intent 无哈希
    const receipt = (readEventLines(eventLog.path).find((line) => line.kind === "receipt") as { receipt: Receipt }).receipt;
    assert.equal(receipt.isError, true);
    assert.equal(receipt.executed, false);
    const intent = readEventLines(eventLog.path).find((line) => line.kind === "intent");
    assert.equal(intent?.contentHashes, undefined);

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("环境异常分类：写工具抛 ErrnoException → settled 事件携带 errorKind=environment", async () => {
  const { root, cleanup } = makeWorkspace({});
  const { eventLog, sessionId } = makeEventLog(root);
  try {
    const registry = new ToolRegistry();
    registry.register({
      name: "broken_writer",
      description: "模拟环境异常的写工具",
      parameters: Type.Object({}),
      tier: "write",
      pathConfinement: { kind: "workspace" },
      executionMode: "sequential",
    });
    const brokenWriter = {
      name: "broken_writer",
      label: "broken_writer",
      description: "模拟环境异常的写工具",
      parameters: Type.Object({}),
      execute: async () => {
        throw Object.assign(new Error("只读文件系统"), { code: "EROFS" });
      },
    };
    const snapshot = makeSnapshot("yolo");
    snapshot.tools.policy.allow = ["broken_writer"];
    const adapter = new PiRuntimeAdapter({
      snapshot,
      streamFn: createFakeStreamFn({
        replies: [
          { text: "写", toolCalls: [{ name: "broken_writer", args: {} }] },
          { text: "明白" },
        ],
      }),
      registry,
      tools: [brokenWriter],
      sessionId,
      eventLog,
    });

    const result = await adapter.run("写文件");
    assert.equal(result.status, "completed");
    const persisted = readEventLines(eventLog.path).find((line) => line.kind === "tool.settled");
    assert.equal((persisted?.payload as ToolSettledPayload).errorKind, "environment");
    // 无探针能力的写工具：intent 无哈希字段（降级为人工对账，不阻断执行）
    const intent = readEventLines(eventLog.path).find((line) => line.kind === "intent");
    assert.equal(intent?.contentHashes, undefined);

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("熔断落闸留证：幽灵工具名循环 → breaker 记录落盘（scope=intercepted，计数与阈值在场）", async () => {
  const { root, cleanup } = makeWorkspace({});
  const { eventLog, sessionId } = makeEventLog(root);
  try {
    const phantomReplies = Array.from({ length: 10 }, () => ({
      text: "试",
      toolCalls: [{ name: "ghost_tool", args: {} }],
    }));
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("yolo"),
      streamFn: createFakeStreamFn({ replies: [...phantomReplies, { text: "放弃" }] }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog,
    });

    const result = await adapter.run("调用幽灵工具");
    assert.equal(result.status, "aborted");
    const breaker = readEventLines(eventLog.path).find((line) => line.kind === "breaker");
    assert.ok(breaker, "熔断落闸必须留证（D7 治理熔断判据行）");
    assert.equal(breaker.scope, "intercepted");
    assert.equal(breaker.toolName, "ghost_tool");
    assert.equal(breaker.count, 3);
    assert.equal(breaker.threshold, 3);
    assert.equal(breaker.runId, result.runId);

    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});

test("熔断落闸留证：deny 循环 → breaker 记录落盘（scope=tool）；人工拒绝循环 → scope=fingerprint", async () => {
  const original = "alpha\nbeta\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionId } = makeEventLog(root);
  try {
    const stubborn = Array.from({ length: 10 }, () => ({
      text: "再试",
      toolCalls: [{ name: "edit_file", args: editCall(original) }],
    }));
    const denyAdapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("yolo", ["edit_file"]),
      streamFn: createFakeStreamFn({ replies: [...stubborn, { text: "放弃" }] }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog,
    });
    const denyResult = await denyAdapter.run("改文件");
    assert.equal(denyResult.status, "aborted");
    // 活侧分类（D7）：与冷物化同一套判据——熔断落闸的 aborted Run 归治理熔断子类
    assert.deepEqual(denyResult.failure, { category: "cancelled", breaker: true });
    await denyAdapter.dispose();

    const breaker = readEventLines(eventLog.path).find((line) => line.kind === "breaker");
    assert.ok(breaker);
    assert.equal(breaker.scope, "tool");
    assert.equal(breaker.toolName, "edit_file");
    eventLog.close();

    // 人工拒绝保持指纹粒度：同一参数连拒三次 → scope=fingerprint
    const { eventLog: log2, sessionId: session2 } = makeEventLog(root);
    const rejectAdapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("prompt"),
      streamFn: createFakeStreamFn({ replies: [...stubborn, { text: "放弃" }] }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      approvalHandler: async () => ({ approved: false, reason: "不准改" }),
      sessionId: session2,
      eventLog: log2,
    });
    const rejectResult = await rejectAdapter.run("改文件");
    assert.equal(rejectResult.status, "aborted");
    assert.deepEqual(rejectResult.failure, { category: "cancelled", breaker: true });
    const breaker2 = readEventLines(log2.path).find((line) => line.kind === "breaker");
    assert.ok(breaker2);
    assert.equal(breaker2.scope, "fingerprint");
    await rejectAdapter.dispose();
    log2.close();
  } finally {
    cleanup();
  }
});

// ---------- M4 S2 崩溃测试矩阵 + 哈希自动确证（D5） ----------

// 半态事件文件的公共骨架：只有 intent（携带内容哈希三元组），无 receipt
function writeCrashIntent(
  eventLog: JsonlEventLog,
  runId: ReturnType<typeof newRunId>,
  hashes: { path: string; beforeHash: string; expectedAfterHash: string }
): void {
  eventLog.appendIntent({
    executionId: newExecutionId(),
    toolCallId: "toolu_crash",
    toolName: "edit_file",
    rawArgs: { path: hashes.path },
    decision: { outcome: "approved", approvedBy: "human", decidedAt: 1_757_000_000_001 },
    contentHashes: hashes,
    at: 1_757_000_000_000,
    runId,
  });
}

test("崩溃点⓪：进程死于 intent 之前 → 无任何治理记录，冷恢复零确证、零重放", () => {
  const original = "alpha\nbeta\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    // 只有观察族事件（turn.started），进程死于审批闸写 intent 之前
    eventLog.appendRuntimeEvent({
      version: 1,
      id: newEntryId(),
      sessionId,
      runId: newRunId(),
      timestamp: 1,
      kind: "turn.started",
      payload: {},
    });
    eventLog.close();

    const recovery = recoverSession(sessionsDir, sessionId, root);
    assert.equal(recovery.resolutions.length, 0);
    assert.equal(recovery.materialized.reconcile.unknown.length, 0);
    // 零重放：事件文件没有新增任何治理记录，文件逐字节不变
    assert.equal(readEventLines(eventLog.path).filter((l) => l.kind === "resolution").length, 0);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
  } finally {
    cleanup();
  }
});

test("崩溃点①b：intent 已写、dispatch 未发生（文件仍是改前哈希）→ 自动确证 not-executed", () => {
  const original = "alpha\nbeta\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    writeCrashIntent(eventLog, newRunId(), {
      path: "a.ts",
      beforeHash: snapshotTag(original),
      expectedAfterHash: snapshotTag("alpha\nBETA\n"),
    });
    eventLog.close();

    const recovery = recoverSession(sessionsDir, sessionId, root);
    assert.equal(recovery.resolutions.length, 1);
    assert.equal(recovery.resolutions[0]?.outcome, "not-executed");
    assert.equal(recovery.resolutions[0]?.method, "hash-auto");
    assert.equal(recovery.resolutions[0]?.evidence.observedHash, snapshotTag(original));
    // 销账后悬账清零；模型之后可正常重提，系统未重新执行（文件逐字节不变）
    assert.equal(recovery.materialized.reconcile.unknown.length, 0);
    assert.equal(recovery.materialized.reconcile.resolved.length, 1);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
    // 幂等：二次冷恢复不重复确证（resolution 已配对，无悬账可消）
    const again = recoverSession(sessionsDir, sessionId, root);
    assert.equal(again.resolutions.length, 0);
  } finally {
    cleanup();
  }
});

test("崩溃点②b：execute 已跑、receipt 未写（文件已是改后哈希）→ 自动确证 executed，零重放", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const after = "alpha\nBETA\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    // 故障注入：receipt 写盘即抛错，模拟进程死于 tool_execution_end 前；
    // 与 S1 崩溃点②的差别：S2 的 intent 携带哈希，冷恢复可自动确证
    const poison = {
      appendRuntimeEvent: eventLog.appendRuntimeEvent.bind(eventLog),
      appendIntent: eventLog.appendIntent.bind(eventLog),
      appendDecision: eventLog.appendDecision.bind(eventLog),
      appendReceipt: () => {
        throw new Error("模拟进程崩溃：receipt 未落盘");
      },
      appendBreaker: eventLog.appendBreaker.bind(eventLog),
    };
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot("yolo"),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog: poison,
    });
    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), after);
    await adapter.dispose();
    eventLog.close();

    // 冷恢复：现状哈希 == 预期改后 → 自动确证 executed（副作用确认已发生，不盲重放）
    const recovery = recoverSession(sessionsDir, sessionId, root);
    assert.equal(recovery.resolutions.length, 1);
    assert.equal(recovery.resolutions[0]?.outcome, "executed");
    assert.equal(recovery.materialized.reconcile.unknown.length, 0);
    // 零重放：确证后文件仍是被改后状态，事件日志只有 intent + resolution 两行治理记录
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), after);
    const governance = readEventLines(eventLog.path).filter(
      (l) => l.kind === "intent" || l.kind === "resolution" || l.kind === "receipt"
    );
    assert.deepEqual(governance.map((l) => l.kind), ["intent", "resolution"]);
  } finally {
    cleanup();
  }
});

test("撕裂写 / 第三方改动 / 文件消失：现状哈希两头都不匹配 → 滞留 unknown 留人确认，不写确证记录", () => {
  const original = "alpha\nbeta\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    writeCrashIntent(eventLog, newRunId(), {
      path: "a.ts",
      beforeHash: snapshotTag(original),
      expectedAfterHash: snapshotTag("alpha\nBETA\n"),
    });
    eventLog.close();

    // 撕裂写：文件只有一半新内容（既不是改前也不是改后）
    writeFileSync(join(root, "a.ts"), "alpha\nBET", "utf8");
    let recovery = recoverSession(sessionsDir, sessionId, root);
    assert.equal(recovery.resolutions.length, 0);
    assert.equal(recovery.materialized.reconcile.unknown.length, 1);
    // 撕裂写的悬账分类 = 未知（D7 默认桶）
    assert.deepEqual(recovery.materialized.classification.toolExecutions[0]?.failure, {
      category: "unknown",
    });

    // 第三方改动：崩溃窗口内有人把文件改成了别的东西
    writeFileSync(join(root, "a.ts"), "human\nedit\n", "utf8");
    recovery = recoverSession(sessionsDir, sessionId, root);
    assert.equal(recovery.resolutions.length, 0);
    assert.equal(recovery.materialized.reconcile.unknown.length, 1);

    // 目标文件消失：同样滞留 unknown
    rmSync(join(root, "a.ts"));
    recovery = recoverSession(sessionsDir, sessionId, root);
    assert.equal(recovery.resolutions.length, 0);
    assert.equal(recovery.materialized.reconcile.unknown.length, 1);
  } finally {
    cleanup();
  }
});

test("哈希缺省的悬账不自动确证：intent 无 contentHashes → 滞留 unknown（降级人工对账）", () => {
  const original = "alpha\nbeta\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    eventLog.appendIntent({
      executionId: newExecutionId(),
      toolCallId: "toolu_nohash",
      toolName: "edit_file",
      rawArgs: { path: "a.ts" },
      decision: { outcome: "approved", approvedBy: "human", decidedAt: 1_757_000_000_001 },
      at: 1_757_000_000_000,
      runId: newRunId(),
    });
    eventLog.close();

    const recovery = recoverSession(sessionsDir, sessionId, root);
    assert.equal(recovery.resolutions.length, 0);
    assert.equal(recovery.materialized.reconcile.unknown.length, 1);
  } finally {
    cleanup();
  }
});
