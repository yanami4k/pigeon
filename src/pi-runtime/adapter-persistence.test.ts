// M3 切片 5：账本持久化 + 崩溃对账测试。
// 崩溃点模拟说明：上游保证 tool_execution_end 必到（spike S6），活进程内无法复现
// "死于 end 事件前"——按任务约定用"写一半的状态目录 + 新 Store 实例对账"模拟：
//   ① intent 已写、execute 未跑 → Store 级直接构造半态目录；
//   ② execute 已跑、receipt 未写 → 故障注入账本（appendReceipt 抛错）+ 完整真实 Run。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import {
  JsonlLedger,
  LEDGER_INTENT_VERSION,
  type LedgerDecision,
  type LedgerIntent,
} from "../persistence/ledger.ts";
import { asExecutionId } from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn } from "./fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

function makeWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-persist-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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

// 读账本文件的逐行 JSON
function readLedgerLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("批准执行路径：dispatch 前落 intent，end 后落 receipt，冷启动对账配对，账本回填 receiptId", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const ledgerPath = join(root, ".pigeon", "ledger.jsonl");
  try {
    const ledger = new JsonlLedger(ledgerPath);
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
      ledger,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");

    // 账本两行：intent 在 dispatch 前、receipt 在 end 后
    const lines = readLedgerLines(ledgerPath);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.kind, "intent");
    assert.equal(lines[1]?.kind, "receipt");
    assert.equal(lines[0]?.executionId, lines[1]?.executionId);

    // intent 携带决定快照（approvedBy 证据链）与模型原始参数
    const intent = lines[0] as unknown as LedgerIntent;
    assert.equal(intent.decision.approvedBy, "human");
    assert.deepEqual(intent.rawArgs, editCall(original));

    // receipt：executed=true、approvedBy=human
    const receipt = lines[1] as unknown as Receipt;
    assert.equal(receipt.version, RECEIPT_VERSION);
    assert.equal(receipt.executed, true);
    assert.equal(receipt.isError, false);
    assert.equal(receipt.approvedBy, "human");

    // ToolExecution 账本回填 receiptId（三层关联 executionId/toolCallId/receiptId）
    const record = result.toolExecutions[0];
    assert.ok(record);
    assert.equal(record.receiptId, receipt.id);

    // 冷启动对账：新实例全量读，配对 settled
    const report = new JsonlLedger(ledgerPath).reconcile();
    assert.equal(report.settled.length, 1);
    assert.equal(report.unknown.length, 0);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("人工拒绝路径：decision 落盘（理由逐字）+ receipt executed=false，对账归 rejected 非 unknown", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const ledgerPath = join(root, "ledger.jsonl");
  try {
    const ledger = new JsonlLedger(ledgerPath);
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
      ledger,
    });

    await adapter.run("改文件");
    const lines = readLedgerLines(ledgerPath);
    // 拒绝的调用：decision（拒绝理由逐字留证）+ receipt；intent 只在 dispatch 前写，拒绝路径没有
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.kind, "decision");
    assert.equal(lines[1]?.kind, "receipt");
    assert.equal(lines[0]?.executionId, lines[1]?.executionId);
    const persisted = lines[0] as unknown as LedgerDecision;
    assert.equal(persisted.decision.outcome, "rejected");
    assert.equal(persisted.decision.approvedBy, "human");
    assert.equal(persisted.decision.reason, "不准");
    const receipt = lines[1] as unknown as Receipt;
    assert.equal(receipt.executed, false);
    assert.equal(receipt.approvedBy, "human");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);

    // 冷启动对账：decision+receipt 配对归 rejected，无副作用可能，不落 OutcomeUnknown
    const report = new JsonlLedger(ledgerPath).reconcile();
    assert.equal(report.rejected.length, 1);
    assert.equal(report.unknown.length, 0);
    assert.equal(report.orphanReceipts.length, 0);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("deny 清单路径：decision 落盘 approvedBy=policy:deny，理由逐字留证", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const ledgerPath = join(root, "ledger.jsonl");
  try {
    const ledger = new JsonlLedger(ledgerPath);
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
      ledger,
    });

    await adapter.run("改文件");
    const lines = readLedgerLines(ledgerPath);
    const persisted = lines.find((line) => line.kind === "decision") as unknown as LedgerDecision;
    assert.ok(persisted, "deny 路径必须落 decision 行");
    assert.equal(persisted.decision.outcome, "rejected");
    assert.equal(persisted.decision.approvedBy, "policy:deny");
    assert.equal(persisted.decision.reason, "deny 清单精确匹配，任何模式一律拒绝：edit_file");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);

    const report = new JsonlLedger(ledgerPath).reconcile();
    assert.equal(report.rejected.length, 1);
    assert.equal(report.unknown.length, 0);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("未配置审批通道 fail-closed：decision 落盘 approvedBy=policy:deny", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const ledgerPath = join(root, "ledger.jsonl");
  try {
    const ledger = new JsonlLedger(ledgerPath);
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
      ledger,
    });

    await adapter.run("改文件");
    const lines = readLedgerLines(ledgerPath);
    const persisted = lines.find((line) => line.kind === "decision") as unknown as LedgerDecision;
    assert.ok(persisted, "fail-closed 路径必须落 decision 行");
    assert.equal(persisted.decision.outcome, "rejected");
    assert.equal(persisted.decision.approvedBy, "policy:deny");
    assert.equal(persisted.decision.reason, "策略要求人工审批但未配置审批通道（fail-closed）");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("decision 写盘失败不改变拒绝结果：理由逐字回模型，故障进 listenerErrors", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const ledgerPath = join(root, "ledger.jsonl");
  try {
    const real = new JsonlLedger(ledgerPath);
    const poison = {
      appendIntent: real.appendIntent.bind(real),
      appendDecision: () => {
        throw new Error("模拟磁盘写失败：decision 未落盘");
      },
      appendReceipt: real.appendReceipt.bind(real),
      reconcile: real.reconcile.bind(real),
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
      ledger: poison,
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
  } finally {
    cleanup();
  }
});

test("崩溃点①：intent 已写、execute 未跑（半态目录）→ 冷启动对账 OutcomeUnknown，无重放", () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "alpha\nbeta\n" });
  const ledgerPath = join(root, "ledger.jsonl");
  try {
    // 模拟进程死于 hook 放行后 / execute 前：账本里只有 intent
    const crashed = new JsonlLedger(ledgerPath);
    crashed.appendIntent({
      kind: "intent",
      version: LEDGER_INTENT_VERSION,
      executionId: asExecutionId("exec_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
      toolCallId: "toolu_crash1",
      toolName: "edit_file",
      rawArgs: { path: "a.ts" },
      decision: { outcome: "approved", approvedBy: "human", decidedAt: 1_757_000_000_001 },
      at: 1_757_000_000_000,
    });

    // 新实例冷启动对账（等价于新进程）
    const report = new JsonlLedger(ledgerPath).reconcile();
    assert.equal(report.settled.length, 0);
    assert.equal(report.unknown.length, 1);
    assert.equal(report.unknown[0]?.intent.executionId, "exec_01J5Z7K8W9ABCDEFGHJKMNPQRS");
    assert.equal(report.unknown[0]?.receipt, undefined);
    // 无重放：对账只读报告，账本与文件系统均无变化
    assert.equal(readLedgerLines(ledgerPath).length, 1);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nbeta\n");
  } finally {
    cleanup();
  }
});

test("崩溃点②：execute 已跑、receipt 未写（故障注入账本）→ OutcomeUnknown，副作用已发生但不盲重放", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const ledgerPath = join(root, "ledger.jsonl");
  try {
    // 故障注入：receipt 写盘即抛错，模拟进程死于 tool_execution_end 前
    const poisoned = new JsonlLedger(ledgerPath);
    const poison = {
      appendIntent: poisoned.appendIntent.bind(poisoned),
      appendDecision: poisoned.appendDecision.bind(poisoned),
      appendReceipt: () => {
        throw new Error("模拟进程崩溃：receipt 未落盘");
      },
      reconcile: poisoned.reconcile.bind(poisoned),
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
      ledger: poison,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    // 副作用真实发生了（文件已改），但 receipt 从未落盘
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");
    assert.equal(readLedgerLines(ledgerPath).length, 1);
    // 故障被响亮记录（listenerErrors），不是静默吞掉
    assert.ok(adapter.listenerErrors().length > 0);

    // 冷启动对账：intent 无 receipt → OutcomeUnknown（副作用是否发生账本无法确认）
    const report = new JsonlLedger(ledgerPath).reconcile();
    assert.equal(report.unknown.length, 1);
    assert.equal(report.settled.length, 0);
    // 无重放：对账后账本仍只有一条 intent，没有任何自动重试产生新记录
    assert.equal(readLedgerLines(ledgerPath).length, 1);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("账本写盘失败 = fail-closed：intent 写不进就不放行，execute 不发生", async () => {
  const original = "alpha\nbeta\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const ledgerPath = join(root, "ledger.jsonl");
  try {
    const real = new JsonlLedger(ledgerPath);
    const broken = {
      appendIntent: () => {
        throw new Error("模拟磁盘写失败");
      },
      appendDecision: real.appendDecision.bind(real),
      appendReceipt: real.appendReceipt.bind(real),
      reconcile: real.reconcile.bind(real),
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
      ledger: broken,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    // 写盘失败 → 阻断，文件零改动
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
    // 账本文件无任何记录（intent 写失败），被拦调用也不产生 receipt（从未 dispatch）
    assert.equal(readLedgerLines(ledgerPath).length, 0);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("闸内异常循环熔断：账本持续写失败 + 模型坚持重发，计数到阈值后 aborted", async () => {
  const original = "alpha\nbeta\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const ledgerPath = join(root, "ledger.jsonl");
  try {
    const real = new JsonlLedger(ledgerPath);
    const broken = {
      appendIntent: () => {
        throw new Error("模拟磁盘持续写失败");
      },
      appendDecision: real.appendDecision.bind(real),
      appendReceipt: real.appendReceipt.bind(real),
      reconcile: real.reconcile.bind(real),
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
      ledger: broken,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "aborted");
    assert.equal(result.toolExecutions.length, 3);
    // fail-closed 语义不变：intent 写不进就不放行，文件零改动
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});
