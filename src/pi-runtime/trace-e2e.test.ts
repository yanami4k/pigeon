// M4 S3 完成证据：脚本化多轮会话（fake streamFn：一次自动放行读、一次人工批准编辑、
// 一次人工拒绝）→ 冷物化 → Trace 关联视图。断言全链路可遍历且每一跳 id 相等：
// 用户轮次 → tool.proposed（原始参数）→ 治理记录（approvedBy / 逐字拒绝理由）→
// Receipt（executed / contentAfterHash）→ 最终分类；跨 Run 同 toolCallId 不串线。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { buildSessionTrace } from "../persistence/trace.ts";
import { newSessionId } from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn } from "./fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

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

function makeSnapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: {
      policy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" },
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

test("完成证据：用户请求 → 工具参数 → 审批 → Receipt → 最终验证，全链路逐跳 id 相等", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const edited = "alpha\nBETA\ngamma\n";
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-e2e-"));
  writeFileSync(join(root, "a.ts"), original);
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  const eventLog = new JsonlEventLog(sessionsDir, sessionId);
  try {
    // 第一个 edit_file 批准，第二个以「先别动这个文件」拒绝；read_file 走 policy:auto 自动放行
    let editApprovals = 0;
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot(),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "先读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
          { text: "再改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "继续改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "完成" },
          // Run 2：故意复用 Run 1 首个调用的 toolCallId（tc-1-1），验证 runId 域隔离
          {
            text: "再读",
            toolCalls: [{ name: "read_file", args: { path: "a.ts" }, id: "tc-1-1" }],
          },
          { text: "好" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createReadFileTool(root), createEditFileTool(root)],
      approvalHandler: async ({ toolName }) => {
        if (toolName === "edit_file") {
          editApprovals += 1;
          return editApprovals === 1
            ? { approved: true }
            : { approved: false, reason: "先别动这个文件" };
        }
        return { approved: true };
      },
      sessionId,
      eventLog,
    });

    const run1 = await adapter.run("改文件");
    assert.equal(run1.status, "completed");
    const run2 = await adapter.run("再读一次");
    assert.equal(run2.status, "completed");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), edited);
    await adapter.dispose();
    eventLog.close();

    // 冷物化 → 关联投影（trace 是只读视图，不触碰事件日志）
    const trace = buildSessionTrace(materializeSession(sessionsDir, sessionId));
    assert.equal(trace.sessionId, sessionId);
    assert.equal(trace.runs.length, 2);
    assert.equal(trace.orphanReceipts.length, 0);
    assert.equal(trace.orphanResolutions.length, 0);

    // ---- Run 1：四轮（读 / 批准的改 / 拒绝的改 / 纯文本收尾）----
    const t1 = trace.runs[0];
    assert.ok(t1);
    assert.equal(t1.runId, run1.runId);
    assert.equal(t1.ended, true);
    assert.deepEqual(
      t1.turns.map((turn) => turn.toolCalls.length),
      [1, 1, 1, 0],
      "工具调用归属到发起它的助手轮次"
    );
    assert.deepEqual(t1.classification?.failure, null, "正常收尾的 Run 不是失败");

    // 第 1 轮：read_file 自动放行——事件级 + 治理族全链
    const readCall = t1.turns[0]?.toolCalls[0];
    assert.ok(readCall);
    assert.equal(readCall.toolName, "read_file");
    assert.equal(readCall.intent?.decision.approvedBy, "policy:auto");
    assert.equal(readCall.proposed?.payload.toolCallId, readCall.intent?.toolCallId);
    assert.equal(readCall.receipt?.executionId, readCall.intent?.executionId);
    assert.equal(readCall.receipt?.executed, true);
    assert.deepEqual(readCall.classification?.failure, null);
    assert.equal(readCall.pendingReconcile, false);

    // 第 2 轮：edit_file 人工批准——提议参数 ≡ 落账参数，Receipt 实测哈希 ≡ intent 预期改后
    const approved = t1.turns[1]?.toolCalls[0];
    assert.ok(approved);
    assert.equal(approved.toolName, "edit_file");
    assert.ok(approved.proposed);
    assert.ok(approved.intent);
    assert.ok(approved.receipt);
    assert.ok(approved.settled);
    // 每一跳 id 相等（runId 域 + toolCallId + executionId）
    assert.equal(approved.proposed.runId, run1.runId);
    assert.equal(approved.proposed.payload.toolCallId, approved.intent.toolCallId);
    assert.equal(approved.settled.payload.toolCallId, approved.intent.toolCallId);
    assert.equal(approved.receipt.toolCallId, approved.intent.toolCallId);
    assert.equal(approved.receipt.executionId, approved.intent.executionId);
    // 模型原始参数在提议事件与 intent 快照间逐字节一致
    assert.deepEqual(approved.proposed.payload.args, approved.intent.rawArgs);
    assert.deepEqual(approved.intent.rawArgs, editCall(original));
    // 审批出处：人工批准
    assert.equal(approved.intent.decision.outcome, "approved");
    assert.equal(approved.intent.decision.approvedBy, "human");
    // 最终验证：哈希三方证据闭环（改前实测 → 预期改后 → Receipt 实测改后）
    assert.equal(approved.intent.contentHashes?.beforeHash, snapshotTag(original));
    assert.equal(approved.intent.contentHashes?.expectedAfterHash, snapshotTag(edited));
    assert.equal(approved.receipt.contentAfterHash, snapshotTag(edited));
    assert.equal(approved.receipt.executed, true);
    assert.equal(approved.receipt.isError, false);
    assert.deepEqual(approved.classification?.failure, null);
    assert.deepEqual(approved.anomalies, []);

    // 第 3 轮：edit_file 人工拒绝——拒绝理由逐字留证，治理闭环非失败
    const denied = t1.turns[2]?.toolCalls[0];
    assert.ok(denied);
    assert.ok(denied.decision);
    assert.equal(denied.decision.decision.outcome, "rejected");
    assert.equal(denied.decision.decision.approvedBy, "human");
    assert.equal(denied.decision.decision.reason, "先别动这个文件");
    assert.equal(denied.decision.toolCallId, denied.proposed?.payload.toolCallId);
    assert.equal(denied.receipt?.executed, false, "拒绝的调用副作用从未发生");
    assert.deepEqual(denied.classification?.failure, null, "拒绝是治理闭环，不是失败");
    assert.equal(denied.pendingReconcile, false);

    // ---- Run 2：toolCallId 与 Run 1 相撞（tc-1-1），关联绝不跨 Run 串线 ----
    const t2 = trace.runs[1];
    assert.ok(t2);
    assert.equal(t2.runId, run2.runId);
    const reread = t2.toolCalls[0];
    assert.ok(reread);
    assert.equal(reread.toolCallId, "tc-1-1");
    assert.notEqual(reread.intent?.executionId, readCall.intent?.executionId);
    assert.equal(reread.intent?.runId, run2.runId);
    assert.equal(reread.receipt?.executionId, reread.intent?.executionId);
    // Run 1 的同名调用不被污染
    assert.equal(readCall.intent?.runId, run1.runId);
    assert.deepEqual(reread.anomalies, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
