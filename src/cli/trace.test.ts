// M4 S3：CLI trace 命令（只读静态报告）测试——中文标签、id 短哈希、参数截断、
// 分类徽章（通俗措辞）、拒绝理由逐字、待对账/异常项可见、只读性（不触碰事件日志与工作区）。
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { createToolGovernance } from "../application/governance.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "../pi-runtime/snapshot.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import {
  newEntryId,
  newExecutionId,
  newGrantId,
  newRunId,
  newSessionId,
  type RunId,
  type SessionId,
} from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { runTraceCommand } from "./trace.ts";

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

async function scriptSession(root: string): Promise<{ sessionId: SessionId; runId: RunId }> {
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  const eventLog = new JsonlEventLog(sessionsDir, sessionId);
  let editApprovals = 0;
  const adapter = new PiRuntimeAdapter({
    snapshot: makeSnapshot(),
    streamFn: createFakeStreamFn({
      replies: [
        { text: "先读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
        {
          text: "再改",
          toolCalls: [{ name: "edit_file", args: editCall("alpha\nbeta\ngamma\n") }],
        },
        {
          text: "继续改",
          toolCalls: [{ name: "edit_file", args: editCall("alpha\nbeta\ngamma\n") }],
        },
        { text: "完成" },
      ],
    }),
    governance: createToolGovernance({
      registry: makeRegistry(),
      approvalHandler: async ({ toolName }) => {
        if (toolName === "edit_file") {
          editApprovals += 1;
          return editApprovals === 1
            ? { approved: true }
            : { approved: false, reason: "先别动这个文件" };
        }
        return { approved: true };
      },
    }),
    tools: [createReadFileTool(root), createEditFileTool(root)],
    sessionId,
    eventLog,
  });
  const result = await adapter.run("改文件");
  await adapter.dispose();
  eventLog.close();
  return { sessionId, runId: result.runId };
}

test("trace 报告：中文标签、id 短哈希、审批出处、逐字拒绝理由、哈希证据与分类徽章", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-cli-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
  try {
    const { sessionId } = await scriptSession(root);
    const output = runTraceCommand({ root, sessionId });

    // 审批出处三类齐备（决策 4 证据链）+ 读层事件级标注（决策 1）
    assert.ok(
      output.includes("审批：事件级记录（读调用按决策 1 只留事件级，不落治理族）"),
      "read 调用必须如实标注事件级（无治理行）"
    );
    assert.ok(output.includes("人工批准（human）"));
    assert.ok(output.includes("人工拒绝（human）"));
    // 拒绝理由逐字呈现
    assert.ok(output.includes("拒绝理由：先别动这个文件"));
    // 哈希证据与最终验证（实测改后与预期一致）
    assert.ok(output.includes("哈希证据：改前"), "写调用必须展示哈希证据");
    assert.ok(output.includes("实测改后"));
    assert.ok(output.includes("（与预期一致）"));
    // 分类徽章（通俗措辞）
    assert.ok(output.includes("分类：正常"));
    // id 短哈希：完整 ULID 不出现在报告里，短形在
    assert.ok(!output.includes(sessionId), "会话 id 必须短哈希");
    assert.ok(output.includes(`会话 ${sessionId.slice(0, 13)}…`));
    // 结构：轮次齐全（读/改/拒/收尾）
    assert.ok(output.includes("第 1 轮"));
    assert.ok(output.includes("第 4 轮"));
    assert.ok(output.includes("待对账 0 次"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace 报告：大参数截断，超长内容不完整外泄", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-cli-"));
  const longPath = `dir/${"x".repeat(400)}.ts`;
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot(),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "读", toolCalls: [{ name: "read_file", args: { path: longPath } }] },
          { text: "好" },
        ],
      }),
      governance: createToolGovernance({
        registry: makeRegistry(),
        approvalHandler: async () => ({ approved: true }),
      }),
      tools: [createReadFileTool(root), createEditFileTool(root)],
      sessionId,
      eventLog,
    });
    await adapter.run("读不存在的文件");
    await adapter.dispose();
    eventLog.close();

    const output = runTraceCommand({ root, sessionId });
    assert.ok(!output.includes(longPath), "超长参数不得完整外泄");
    assert.ok(output.includes("…（共"), "截断必须带长度标注");
    // 读不存在文件 → 域错误 → 业务失败徽章
    assert.ok(output.includes("分类：业务失败"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace 报告：崩溃残留会话展示待对账项与未知徽章", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-cli-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    const runId = newRunId();
    // 半态：只有 intent（崩溃于 dispatch/execute 窗口），无任何运行时事件
    eventLog.appendIntent({
      executionId: newExecutionId(),
      toolCallId: "toolu_crash",
      toolName: "edit_file",
      rawArgs: { path: "a.ts" },
      decision: { outcome: "approved", approvedBy: "human", decidedAt: 1_757_000_000_001 },
      contentHashes: {
        path: "a.ts",
        beforeHash: "aaaaaaaaaaaaaaaa",
        expectedAfterHash: "bbbbbbbbbbbbbbbb",
      },
      at: 1_757_000_000_000,
      runId,
    });
    eventLog.close();

    const output = runTraceCommand({ root, sessionId });
    assert.ok(output.includes("待对账 1 次"));
    assert.ok(output.includes("OutcomeUnknown"), "待对账项必须内联可见");
    assert.ok(output.includes("分类：未知"));
    assert.ok(!output.includes(runId), "Run id 同样短哈希");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace 命令只读：报告前后事件日志字节与会话目录清单不变", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-cli-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
  try {
    const { sessionId } = await scriptSession(root);
    const sessionsDir = join(root, ".pigeon", "sessions");
    const filesBefore = readdirSync(sessionsDir);
    const bytesBefore = filesBefore.map((f) => readFileSync(join(sessionsDir, f), "utf8"));
    const workspaceBefore = readFileSync(join(root, "a.ts"), "utf8");

    // 连跑两次：幂等且零副作用
    runTraceCommand({ root, sessionId });
    runTraceCommand({ root, sessionId });

    assert.deepEqual(readdirSync(sessionsDir), filesBefore, "不得新增/删除会话文件");
    assert.deepEqual(
      filesBefore.map((f) => readFileSync(join(sessionsDir, f), "utf8")),
      bytesBefore,
      "事件日志字节不得变化"
    );
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), workspaceBefore, "工作区不得变化");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace 命令：会话不存在时报错并列出已有会话；--run 过滤只渲染目标 Run", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-cli-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
  try {
    const { sessionId, runId } = await scriptSession(root);
    // 第二个 Run（同会话）
    const sessionsDir = join(root, ".pigeon", "sessions");
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot(),
      streamFn: createFakeStreamFn({ replies: [{ text: "嗯" }] }),
      governance: createToolGovernance({
        registry: makeRegistry(),
        approvalHandler: async () => ({ approved: true }),
      }),
      tools: [createReadFileTool(root), createEditFileTool(root)],
      sessionId,
      eventLog,
    });
    await adapter.run("随便聊聊");
    await adapter.dispose();
    eventLog.close();

    // 会话不存在：报错列出已有会话
    const missing = newSessionId();
    assert.throws(
      () => runTraceCommand({ root, sessionId: missing }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("会话不存在"));
        assert.ok(error.message.includes(sessionId), "必须列出已有会话帮助定位");
        return true;
      }
    );

    // --run 过滤：只渲染目标 Run（报告只出现一个 Run 头）
    const filtered = runTraceCommand({ root, sessionId, runId });
    const runHeaders = filtered.split("\n").filter((line) => line.startsWith("Run "));
    assert.equal(runHeaders.length, 1, "过滤后只渲染一个 Run");
    assert.ok(filtered.includes("edit_file"), "目标 Run 的内容在场");
    // 未过滤则两个 Run 都在
    const full = runTraceCommand({ root, sessionId });
    assert.equal(full.split("\n").filter((line) => line.startsWith("Run ")).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace 报告：撕裂尾巴与 entry 断号在 Run 头下如实标注（D2 冷侧可见化，M4 收口决策 ③）", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-cli-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const runId = newRunId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    eventLog.appendRuntimeEvent({
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_000,
      kind: "turn.started",
      payload: {},
    });
    eventLog.appendEntry({ runSeq: 1, role: "user", runId });
    eventLog.appendEntry({ runSeq: 3, role: "assistant", runId });
    eventLog.close();
    // 进程死于写盘中途：半截末行
    appendFileSync(eventLog.path, '{"version":5,"id":"entry_', "utf8");

    // 对照组：干净会话零缺口
    const other = new JsonlEventLog(sessionsDir, newSessionId());
    other.appendRuntimeEvent({
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId: other.sessionId,
      runId: newRunId(),
      timestamp: 1_757_000_000_000,
      kind: "turn.started",
      payload: {},
    });
    other.appendEntry({ runSeq: 1, role: "user", runId: newRunId() });
    other.close();
    const clean = runTraceCommand({ root, sessionId: other.sessionId });
    assert.ok(!clean.includes("撕裂写"), "干净会话不得出现撕裂标注");
    assert.ok(!clean.includes("断号"), "干净会话不得出现断号标注");
    assert.ok(clean.includes("落盘缺口 0 处"), clean);

    const output = runTraceCommand({ root, sessionId });
    assert.ok(output.includes("落盘缺口 2 处"), `会话头汇总缺口数\n${output}`);
    assert.ok(
      output.includes("缺口：会话文件末尾存在半截未写完的记录（撕裂写，已按未持久化丢弃）"),
      `撕裂尾巴在 Run 头下标注\n${output}`
    );
    assert.ok(output.includes("缺口：entry 映射断号，缺第 2 条（写盘失败留证缺口）"), output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace 报告：撕裂尾巴不归属任何 Run 时（末条是 REPL 期 grant 事件）在会话级标注", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-cli-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    eventLog.appendRuntimeEvent({
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId,
      runId: newRunId(),
      timestamp: 1_757_000_000_000,
      kind: "turn.started",
      payload: {},
    });
    eventLog.appendGrantRevoked({ grantId: newGrantId(), revokedAt: 1_757_000_000_001 });
    eventLog.close();
    appendFileSync(eventLog.path, '{"version":5,"id":"entry_', "utf8");

    const output = runTraceCommand({ root, sessionId });
    assert.ok(output.includes("落盘缺口 1 处"), output);
    assert.ok(output.includes("会话级缺口：会话文件末尾存在半截未写完的记录"), output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace 报告：turn.completed 在场但 run.ended 缺失的 Run 徽章为未知，会话头计崩溃残留（M4 验收 O-1）", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-cli-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const runId = newRunId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    const envelope = (kind: string, payload: unknown): EventEnvelope => ({
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_000,
      kind,
      payload,
    });
    eventLog.appendRuntimeEvent(envelope("turn.started", {}));
    eventLog.appendRuntimeEvent(
      envelope("turn.completed", { stopReason: "toolUse", syntheticFailure: false })
    );
    eventLog.close();

    const output = runTraceCommand({ root, sessionId });
    assert.ok(output.includes("崩溃残留 1 个 Run"), `会话头计数\n${output}`);
    const runHeader = output.split("\n").find((line) => line.startsWith("Run "));
    assert.ok(runHeader !== undefined);
    assert.ok(runHeader.includes("分类：未知"), `崩溃残留 Run 不得判正常\n${runHeader}`);
    assert.ok(runHeader.includes("run.ended 缺失（崩溃残留可能）"), runHeader);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
