// M4 S4：CLI replay 命令（只读黑匣子时间线，D4 一次性渲染）测试——运行头终态+四分类、
// 逐条时间戳/kind/关键字段按落盘顺序、拒绝理由逐字、崩溃残留/待对账/孤儿/撕裂尾巴如实标注、
// 只读性（字节级零副作用证明）、响亮失败列出可选项。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { type BreakerInput, JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "../pi-runtime/snapshot.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import {
  newEntryId,
  newExecutionId,
  newReceiptId,
  newRunId,
  newSessionId,
  type RunId,
  type SessionId,
} from "../state/ids.ts";
import { RECEIPT_VERSION } from "../state/receipt.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { shortId } from "./format.ts";
import { runReplayCommand } from "./replay.ts";

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

// 脚本化会话：一次自动放行读 + 一次人工批准编辑 + 一次人工拒绝编辑 + 纯文本收尾
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
  const result = await adapter.run("改文件");
  await adapter.dispose();
  eventLog.close();
  return { sessionId, runId: result.runId };
}

// 手写崩溃残留会话：turn.started → tool.proposed → intent，然后进程死亡
function writeCrashResidue(root: string): { sessionId: SessionId; runId: RunId } {
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
    envelope("tool.proposed", { toolCallId: "tc-crash", toolName: "edit_file", args: {} })
  );
  eventLog.appendIntent({
    executionId: newExecutionId(),
    toolCallId: "tc-crash",
    toolName: "edit_file",
    rawArgs: {},
    decision: { outcome: "approved", approvedBy: "human", decidedAt: 1_757_000_000_001 },
    at: 1_757_000_000_000,
    runId,
  });
  eventLog.close();
  return { sessionId, runId };
}

test("replay 报告：运行头终态+分类，时间线严格按落盘顺序，治理族穿插原位", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replay-cli-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
  try {
    const { sessionId, runId } = await scriptSession(root);
    const output = runReplayCommand({ root, runId });

    // 运行头：终态 + 四分类徽章
    const header = output.split("\n")[0] ?? "";
    assert.ok(header.includes(`回放 Run ${shortId(runId)}`), "运行头含 Run 短哈希");
    assert.ok(header.includes("终态"), "运行头含终态");
    assert.ok(header.includes("分类：正常"), "正常收尾的 Run 分类为正常");

    // 时间线：逐条 时间戳 + kind + 关键字段，按落盘顺序
    const lines = output.split("\n").filter((line) => /^\d{2}:\d{2}:\d{2}\.\d{3} /.test(line));
    assert.ok(lines.length > 0, "时间线条目带毫秒时间戳");
    const kinds = lines.map((line) => line.split(" ")[1]);
    // 上游时序：turn.completed（toolUse 轮末）先于该轮工具事件；
    // Receipt 落盘先于 tool.settled 事件（adapter 在 settled 状态推进时先落账再发事件）
    assert.deepEqual(
      [...new Set(kinds)],
      [
        "turn.started",
        "turn.completed",
        "tool.proposed",
        "intent",
        "receipt",
        "tool.settled",
        "decision",
        "run.ended",
      ],
      "kind 首见顺序 = 落盘顺序（与 trace 的分组视图相区别）"
    );
    // 批准的编辑：以 toolCallId 为关联键过滤时间线（时间线原位，
    // 与 trace 把全链证据聚合到一个「工具调用」块下的分组视图相区别）
    const sessionsDir = join(root, ".pigeon", "sessions");
    const settledEdit = materializeSession(sessionsDir, sessionId).reconcile.settled.find(
      (entry) => entry.intent.toolName === "edit_file"
    );
    assert.ok(settledEdit);
    const callKinds = lines
      .filter((line) => line.includes(settledEdit.intent.toolCallId))
      .map((line) => line.split(" ")[1]);
    assert.deepEqual(
      callKinds,
      ["tool.proposed", "intent", "receipt", "tool.settled"],
      "同一次调用的记录按真实落盘时序呈现"
    );
    assert.ok(output.includes("理由：先别动这个文件"), "拒绝理由逐字在场");
    assert.ok(output.includes("已执行，无错误"), "Receipt 结果在场");
    assert.ok(output.includes("参数 {"), "提议参数摘要在场");
    // 拒绝发生在 dispatch 前：被拒绝的调用没有 Receipt
    assert.ok(output.includes("decision"), "拒绝落账在时间线中");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay 报告：崩溃残留 Run 标注「记录到此中断」+ 待对账 + 未知分类", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replay-cli-"));
  try {
    const { sessionId, runId } = writeCrashResidue(root);
    const output = runReplayCommand({ root, runId, sessionId });
    assert.ok(output.includes("分类：未知"), "崩溃残留落未知桶");
    assert.ok(output.includes("记录到此中断（崩溃可能）"), "崩溃残留人话标注");
    assert.ok(output.includes("待对账"), "悬账 intent 标注待对账");
    assert.ok(output.includes("OutcomeUnknown"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay 报告：孤儿记录与撕裂尾巴如实标注", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replay-cli-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const runId = newRunId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    // 孤儿 Receipt（executionId 无对应 intent/decision）
    eventLog.appendReceipt({
      receipt: {
        version: RECEIPT_VERSION,
        id: newReceiptId(),
        executionId: newExecutionId(),
        toolCallId: "tc-orphan",
        approvedBy: "human",
        executed: true,
        isError: false,
        startedAt: 1_757_000_000_000,
        finishedAt: 1_757_000_000_001,
        summary: "孤儿",
      },
      runId,
    });
    // 熔断落闸记录（breaker 族也在时间线上）
    const breaker: BreakerInput = {
      toolName: "edit_file",
      toolCallId: "tc-orphan",
      scope: "fingerprint",
      count: 3,
      threshold: 3,
      at: 1_757_000_000_002,
      runId,
    };
    eventLog.appendBreaker(breaker);
    eventLog.appendRuntimeEvent({
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_003,
      kind: "run.ended",
      payload: { messageCount: 1 },
    });
    eventLog.close();
    // 模拟进程死于写盘中途：半截末行
    appendFileSync(eventLog.path, '{"version":2,"id":"entry_', "utf8");

    const output = runReplayCommand({ root, runId, sessionId });
    assert.ok(output.includes("孤儿记录"), "孤儿 Receipt 标注在场");
    assert.ok(output.includes("撕裂写"), "撕裂尾巴标注在场");
    assert.ok(output.includes("熔断落闸"), "熔断记录在场");
    assert.ok(output.includes("按参数指纹计数"), "熔断计数粒度人话");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay 命令只读：报告前后事件日志字节、会话目录清单与工作区均不变", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replay-cli-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
  try {
    const { sessionId, runId } = await scriptSession(root);
    const sessionsDir = join(root, ".pigeon", "sessions");
    const filesBefore = readdirSync(sessionsDir);
    const bytesBefore = filesBefore.map((f) => readFileSync(join(sessionsDir, f), "utf8"));
    const workspaceBefore = readFileSync(join(root, "a.ts"), "utf8");

    // 连跑两次（指定会话与跨会话扫描两条路径）：幂等且零副作用
    runReplayCommand({ root, runId, sessionId });
    runReplayCommand({ root, runId });

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

test("replay 命令：未知 Run/会话响亮失败并列出可选项；--session 定位与跨会话扫描", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replay-cli-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
  try {
    const { sessionId, runId } = await scriptSession(root);
    const sessionsDir = join(root, ".pigeon", "sessions");

    // 未知会话：报错列出已有会话
    assert.throws(
      () => runReplayCommand({ root, runId, sessionId: newSessionId() }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("会话不存在"));
        assert.ok(error.message.includes(sessionId), "必须列出已有会话帮助定位");
        return true;
      }
    );

    // 未知 Run（指定会话）：报错列出该会话已有 Run
    assert.throws(
      () => runReplayCommand({ root, runId: newRunId(), sessionId }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(runId), "必须列出已有 Run 帮助定位");
        return true;
      }
    );

    // 未知 Run（跨会话扫描）：报错列出全部已有 Run
    assert.throws(
      () => runReplayCommand({ root, runId: newRunId() }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("Run 不存在"));
        assert.ok(error.message.includes(runId));
        return true;
      }
    );

    // 不指定 --session：跨会话扫描命中唯一 Run 并渲染
    const scanned = runReplayCommand({ root, runId });
    assert.ok(scanned.includes("回放 Run"), "跨会话扫描必须能定位并渲染");

    // 同一 runId 出现在两个会话 → 响亮失败要求 --session 消歧
    const other = new JsonlEventLog(sessionsDir, newSessionId());
    other.appendRuntimeEvent({
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId: other.sessionId,
      runId,
      timestamp: 1_757_000_000_000,
      kind: "turn.started",
      payload: {},
    });
    other.close();
    assert.throws(
      () => runReplayCommand({ root, runId }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("多个会话"), "跨会话歧义必须响亮失败");
        assert.ok(error.message.includes("--session"), "必须提示消歧手段");
        return true;
      }
    );
    // 歧义下 --session 仍可各自渲染
    assert.ok(runReplayCommand({ root, runId, sessionId: other.sessionId }).includes("回放 Run"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay 投影来源：与冷物化同一事实源（materializeSession），不产生第二套事实", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replay-cli-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
  try {
    const { sessionId, runId } = await scriptSession(root);
    const sessionsDir = join(root, ".pigeon", "sessions");
    const materialized = materializeSession(sessionsDir, sessionId);
    const runRecords = materialized.records.filter((record) => record.runId === runId);
    const output = runReplayCommand({ root, runId, sessionId });
    // 时间线条目数 = 该 Run 的记录数（一条记录一行，无增无减）
    const timelineLines = output
      .split("\n")
      .filter((line) => /^\d{2}:\d{2}:\d{2}\.\d{3} /.test(line));
    assert.equal(timelineLines.length, runRecords.length, "每条落盘记录恰好在时间线出现一次");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay 子进程端到端：无 streamFn 也能回放（分流在模型接入检查之前）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replay-cli-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
  try {
    const { sessionId, runId } = await scriptSession(root);
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    // 环境剥离 PIGEON_STREAM_FN 且不传 --stream-fn：replay 不得触碰模型接入
    const env = { ...process.env };
    delete env.PIGEON_STREAM_FN;
    const ok = spawnSync(process.execPath, ["src/cli/index.ts", "replay", runId, "--root", root], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(ok.status, 0, `回放应成功退出：${ok.stderr}`);
    assert.ok(ok.stdout.includes("回放 Run"), "子进程输出时间线报告");
    assert.ok(ok.stdout.includes(shortId(sessionId)), "报告含会话短哈希");

    // 未知 Run：非零退出 + 响亮报错列出可选项
    const missing = spawnSync(
      process.execPath,
      ["src/cli/index.ts", "replay", newRunId(), "--root", root],
      { cwd: repoRoot, env, encoding: "utf8", timeout: 30_000 }
    );
    assert.notEqual(missing.status, 0, "未知 Run 必须失败退出");
    assert.ok(missing.stderr.includes("Run 不存在"));
    assert.ok(missing.stderr.includes(runId), "报错列出已有 Run 帮助定位");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
