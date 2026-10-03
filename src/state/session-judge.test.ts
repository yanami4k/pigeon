// 判定类读者的原生视图（账本重构第二段）：经真实写者造会话文件（测试夹具），读回后逐项现算——Run 级失败分类、成败标签、
// 运行指标与需审批次数、工具级失败分类、旧会话验证记录的标签现算（回炉已随决策 322 删除）、生效授权、worker 派出、
// 分叉点之前的快照、分支文件的复制段。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFixtureSession,
  type FixtureSession,
  forkFixture,
  spawnFixtureWorker,
} from "../application/session-store-fixtures.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import {
  FAIL_CLOSED_APPROVAL_REASON,
  INTERRUPTED_TOOL_RESULT_MARK,
  INTERRUPTED_TOOL_RESULT_TEXT,
  type StoreSessionView,
  storeActiveGrants,
  storeAttemptFacts,
  storeAttemptLabel,
  storeCheckpointBefore,
  storeRunFailure,
  storeRunMetrics,
  storeToolOutcomes,
  storeWorkerSpawned,
  TOOL_RESULT_MARK_KEY,
} from "./session-judge.ts";

async function withSessions(body: (sessionsDir: string, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-judge-"));
  try {
    await body(join(root, ".pigeon", "state", "sessions"), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function viewOf(session: FixtureSession, sessionsDir: string): Promise<StoreSessionView> {
  const { sessionId } = await session.close();
  const loaded = loadStoreSession(sessionsDir, sessionId);
  assert.ok(loaded !== undefined);
  return loaded.view;
}

// 上游合成的失败消息：带错误文本、正文只有一个空文本块、用量全零
const SYNTHETIC = { text: "", stopReason: "error", errorMessage: "provider 503" };

test("Run 级失败分类：正常完成、撞上限中止、熔断、中止、输出截断、上游合成失败、非合成出错、收尾条目的停止原因优先、没有助手消息、未收尾；会话视图逐 Run 一致", async () => {
  await withSessions(async (sessionsDir, root) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    const expected: unknown[] = [];
    const add = (
      write: () => void,
      ending: Parameters<FixtureSession["endRun"]>[0] | "none",
      want: unknown
    ) => {
      s.startRun({ task: "做" });
      write();
      if (ending !== "none") {
        s.endRun(ending);
      }
      expected.push(want);
    };
    const aborted = () => s.assistant({ text: "", stopReason: "aborted" });
    add(() => s.assistant({ text: "好了" }), {}, null);
    add(aborted, { ending: "turn-limit" }, { category: "cancelled", breaker: false });
    add(aborted, { ending: "breaker" }, { category: "cancelled", breaker: true });
    add(aborted, { ending: "aborted" }, { category: "cancelled", breaker: false });
    add(() => s.assistant({ text: "半截", stopReason: "length" }), {}, { category: "business" });
    add(() => s.assistant(SYNTHETIC), { ending: "error" }, { category: "infrastructure" });
    add(
      () => s.assistant({ text: "说了一半", stopReason: "error", errorMessage: "断了" }),
      { ending: "error" },
      { category: "unknown" }
    );
    // 收尾条目记的停止原因先于末条助手消息的（运行面写出的文件里两者相同，手写的会话文件可以不同）
    add(
      () => s.toolTurn({ name: "edit_file" }),
      { ending: "wall-clock-limit", stopReason: "aborted" },
      { category: "cancelled", breaker: false }
    );
    add(() => {}, {}, { category: "unknown" });
    add(() => s.assistant({ text: "好了" }), "none", { category: "unknown" });
    const view = await viewOf(s, sessionsDir);
    assert.deepEqual(
      view.runs.map((run) => storeRunFailure(run)),
      expected
    );
    // 显示类读者的会话视图（会话列表、检索、trace）用同一份 Run 级装配，逐 Run 结果一致
    const shown = loadSessionView(sessionsDir, view.sessionId);
    assert.ok(shown !== undefined);
    assert.deepEqual(
      shown.runs.map((run) => run.failure),
      expected
    );
  });
});

test("成败标签：验证结论压过终态；撞上限无验证判失败；悬账（含续跑补的“结果未知”）与未收尾判未知；以中止收尾的助手消息里的调用不算悬账", async () => {
  await withSessions(async (sessionsDir, root) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    const passed = s.startRun({ task: "改" });
    s.toolTurn({ name: "edit_file" });
    s.assistant({ text: "好了" });
    s.endRun();
    s.verification({ verdict: "pass" });

    const limited = s.startRun({ task: "改" });
    s.assistant({ text: "", stopReason: "aborted" });
    s.endRun({ ending: "wall-clock-limit" });

    const dangling = s.startRun({ task: "改" });
    s.assistant({ toolCalls: [{ name: "edit_file" }] });
    s.endRun();
    s.verification({ verdict: "pass" });

    const interrupted = s.startRun({ task: "改" });
    const [callId = ""] = s.assistant({ toolCalls: [{ name: "edit_file" }] });
    s.writer.appendMessage({
      role: "toolResult",
      toolCallId: callId,
      toolName: "edit_file",
      content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
      details: { [INTERRUPTED_TOOL_RESULT_MARK]: true },
      isError: true,
      timestamp: Date.now(),
    } as never);
    s.assistant({ text: "核对过了" });
    s.endRun();

    const abortedCall = s.startRun({ task: "改" });
    s.assistant({ toolCalls: [{ name: "edit_file" }], stopReason: "aborted" });
    s.endRun({ ending: "aborted" });

    // 进程死于中途（有开始无收尾）：验证通过也不下结论
    const unfinished = s.startRun({ task: "改" });
    s.toolTurn({ name: "edit_file" });
    s.assistant({ text: "好了" });
    s.verification({ verdict: "pass" });

    const view = await viewOf(s, sessionsDir);
    assert.equal(storeAttemptLabel(view, passed), "Passed");
    assert.equal(storeAttemptLabel(view, limited), "Failed");
    assert.equal(storeAttemptFacts(view, dangling).pendingCount, 1);
    assert.equal(storeAttemptLabel(view, dangling), "Unknown");
    assert.equal(storeAttemptFacts(view, interrupted).pendingCount, 1);
    assert.equal(storeAttemptFacts(view, abortedCall).pendingCount, 0);
    assert.equal(storeAttemptLabel(view, abortedCall), "Abandoned");
    assert.equal(storeAttemptFacts(view, unfinished).hasRunEnded, false);
    assert.equal(storeAttemptLabel(view, unfinished), "Unknown");
  });
});

test("旧会话的验证记录照常现算标签：同一 Run 的验证结论压过终态；回炉已删除，多个 Run 各自现算、不再整步归组", async () => {
  await withSessions(async (sessionsDir, root) => {
    // 旧回炉会话（322 之前写下）：首个 Run 验证未通过、第二个 Run 验证通过——删除回炉后不再有整步口径，
    // 各 Run 按自己的验证记录现算
    const s = createFixtureSession({ sessionsDir, cwd: root });
    const first = s.startRun({ task: "修" });
    s.assistant({ text: "修了" });
    s.endRun();
    s.verification({ verdict: "fail" });
    const second = s.startRun({ task: "反馈" });
    s.assistant({ text: "又修了" });
    s.endRun();
    s.verification({ verdict: "pass" });
    const view = await viewOf(s, sessionsDir);
    assert.equal(storeAttemptLabel(view, first), "Failed");
    assert.equal(storeAttemptLabel(view, second), "Passed");
  });
  await withSessions(async (sessionsDir, root) => {
    // 旧回炉会话里最后一个 Run 没有验证记录：该 Run 正常收尾、无验证结论，现算为未知（不向前找别的 Run 的记录）
    const s = createFixtureSession({ sessionsDir, cwd: root });
    const first = s.startRun({ task: "修" });
    s.assistant({ text: "修了" });
    s.endRun();
    s.verification({ verdict: "fail" });
    const second = s.startRun({ task: "反馈" });
    s.assistant({ text: "又修了" });
    s.endRun();
    const view = await viewOf(s, sessionsDir);
    assert.equal(storeAttemptLabel(view, first), "Failed");
    assert.equal(storeAttemptLabel(view, second), "Unknown");
  });
});

test("收尾钩子拦截到上限（stop-hook-limit）：不贴失败标签，现算为未知", async () => {
  await withSessions(async (sessionsDir, root) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    const run = s.startRun({ task: "做" });
    s.assistant({ text: "好了" });
    s.endRun({ ending: "stop-hook-limit" });
    const view = await viewOf(s, sessionsDir);
    assert.equal(storeAttemptFacts(view, run).limitHit, false);
    assert.equal(storeAttemptLabel(view, run), "Unknown");
  });
});

test("运行指标：轮次、工具调用、用量汇总；需审批次数只计 yolo 下写档与命令档、过了审批闸的调用", async () => {
  await withSessions(async (sessionsDir, root) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    s.startRun({
      task: "做",
      config: {
        policy: {
          allow: ["read_file", "edit_file", "run_command"],
          deny: ["run_command"],
          approvalMode: "yolo",
        },
      },
    });
    const usage = { input: 10, output: 5, totalTokens: 15 };
    s.assistant({ toolCalls: [{ name: "read_file" }, { name: "edit_file" }], usage });
    // read_file 成功（读档不计）；edit_file 执行出错（过了闸，计入）
    s.toolResult({ toolCallId: "tc-1", toolName: "read_file", text: "内容" });
    s.toolResult({ toolCallId: "tc-2", toolName: "edit_file", text: "锚不匹配", isError: true });
    // 参数校验失败（上游拦截，不计）
    s.assistant({ toolCalls: [{ name: "edit_file" }], usage });
    s.toolResult({
      toolCallId: "tc-3",
      toolName: "edit_file",
      text: 'Validation failed for tool "edit_file":\n  path: required',
      isError: true,
    });
    // deny 清单（策略拒绝，不计）
    s.assistant({ toolCalls: [{ name: "run_command" }], usage });
    s.toolResult({
      toolCallId: "tc-4",
      toolName: "run_command",
      text: "在 deny 清单上",
      isError: true,
    });
    s.assistant({ text: "完成", usage });
    s.endRun();
    const view = await viewOf(s, sessionsDir);
    const tiers = new Map([
      ["read_file", "read"],
      ["edit_file", "write"],
      ["run_command", "exec"],
    ]);
    const metrics = storeRunMetrics(view, { toolTiers: tiers });
    assert.equal(metrics.turns, 4);
    assert.equal(metrics.toolCalls, 4);
    assert.equal(metrics.usage.totalTokens, 60);
    assert.equal(metrics.usage.input, 40);
    assert.equal(metrics.approvalsNeeded, 1);
    assert.equal(metrics.failure, null);
    // 没给档位时不计
    assert.equal(storeRunMetrics(view).approvalsNeeded, 0);
  });
  await withSessions(async (sessionsDir, root) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    s.startRun({
      task: "做",
      config: { policy: { allow: ["edit_file"], deny: [], approvalMode: "prompt" } },
    });
    s.toolTurn({ name: "edit_file" });
    s.endRun();
    const view = await viewOf(s, sessionsDir);
    // prompt 档：有人在场时本就会问，不算"需审批"的 yolo 批发授权
    assert.equal(
      storeRunMetrics(view, { toolTiers: new Map([["edit_file", "write"]]) }).approvalsNeeded,
      0
    );
  });
});

test("工具级失败分类：成功、策略拒绝、中止、上游拦截与未广告工具、其余执行出错、悬空调用", async () => {
  await withSessions(async (sessionsDir, root) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    s.startRun({
      task: "做",
      config: {
        policy: {
          allow: ["read_file", "edit_file"],
          deny: ["run_command"],
          approvalMode: "prompt",
        },
        advertisedTools: ["read_file", "edit_file", "run_command"],
      },
    });
    const ok = s.toolTurn({ name: "read_file" });
    const denied = s.toolTurn({ name: "run_command", result: "在 deny 清单上", isError: true });
    const failClosed = s.toolTurn({
      name: "edit_file",
      result: FAIL_CLOSED_APPROVAL_REASON,
      isError: true,
    });
    const ghost = s.toolTurn({ name: "rm_rf", result: "Tool rm_rf not found", isError: true });
    const invalid = s.toolTurn({
      name: "edit_file",
      result: 'Validation failed for tool "edit_file":\n  path: required',
      isError: true,
    });
    const failed = s.toolTurn({ name: "edit_file", result: "锚不匹配", isError: true });
    const [dangling = ""] = s.assistant({ toolCalls: [{ name: "read_file" }] });
    s.endRun();
    s.startRun({ task: "再做" });
    const [cancelled = ""] = s.assistant({ toolCalls: [{ name: "edit_file" }] });
    s.toolResult({
      toolCallId: cancelled,
      toolName: "edit_file",
      text: "Operation aborted",
      isError: true,
    });
    s.assistant({ text: "", stopReason: "aborted" });
    s.endRun({ ending: "breaker" });
    const view = await viewOf(s, sessionsDir);
    const byCall = new Map(
      storeToolOutcomes(view).map((outcome) => [outcome.toolCallId, outcome.failure])
    );
    assert.equal(byCall.get(ok), null);
    assert.equal(byCall.get(denied), null);
    assert.equal(byCall.get(failClosed), null);
    assert.deepEqual(byCall.get(ghost), { category: "business" });
    assert.deepEqual(byCall.get(invalid), { category: "business" });
    assert.deepEqual(byCall.get(failed), { category: "unknown" });
    assert.deepEqual(byCall.get(dangling), { category: "unknown" });
    assert.deepEqual(byCall.get(cancelled), { category: "cancelled", breaker: true });
  });
});

test("旧会话的验证记录：worker 尝试的验证记录落在父会话，经额外来源现算标签", async () => {
  await withSessions(async (sessionsDir, root) => {
    const host = createFixtureSession({ sessionsDir, cwd: root });
    host.startRun({ task: "派" });
    const worker = spawnFixtureWorker(host, { sessionsDir, name: "fix-a", task: "改" });
    const workerRun = worker.startRun({ task: "改" });
    worker.toolTurn({ name: "edit_file" });
    worker.assistant({ text: "好了" });
    worker.endRun();
    const workerView = await viewOf(worker, sessionsDir);
    host.verification({
      verdict: "pass",
      target: { sessionId: worker.sessionId, runId: workerRun },
    });
    host.endRun();
    const hostView = await viewOf(host, sessionsDir);
    // 没有额外来源读不到父会话里的验证记录：现算为未知
    assert.equal(storeAttemptLabel(workerView, workerRun), "Unknown");
    assert.equal(
      storeAttemptLabel(workerView, workerRun, { verificationSources: [hostView] }),
      "Passed"
    );
    // 父会话里派出这个 worker 的记录（委派策略从这里还原）
    assert.equal(storeWorkerSpawned(hostView, worker.sessionId)?.name, "fix-a");
    assert.equal(workerView.metadata?.worker?.name, "fix-a");
    assert.equal(workerView.parentSessionId, host.sessionId);
  });
});

test("生效授权：建立减撤销、按建立时间排序", async () => {
  await withSessions(async (sessionsDir, root) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    const kept = s.grantCreated({ tool: "edit_file", pathPrefix: "src" });
    const dropped = s.grantCreated({ tool: "run_command" });
    s.grantRevoked(dropped);
    const view = await viewOf(s, sessionsDir);
    const grants = storeActiveGrants(view);
    assert.deepEqual(
      grants.map((grant) => [grant.grantId, grant.tool, grant.pathPrefix]),
      [[kept, "edit_file", "src"]]
    );
  });
});

test("分叉点之前的快照：同 Run 里归属条目号不大于分叉点的最后一个，其次更早 Run 的，都没有取首个快照的改前基线；分支文件的复制段不算分支自己的 Run", async () => {
  await withSessions(async (sessionsDir, root) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    const first = s.startRun({ task: "改" });
    const [c1 = ""] = s.assistant({ toolCalls: [{ name: "edit_file" }] });
    s.checkpoint({ toolCallId: c1, commit: "1".repeat(40), baseCommit: "0".repeat(40) });
    s.toolResult({ toolCallId: c1, toolName: "edit_file", text: "ok" });
    s.assistant({ text: "好" });
    s.endRun();
    const second = s.startRun({ task: "再改" });
    const [c2 = ""] = s.assistant({ toolCalls: [{ name: "edit_file" }] });
    s.checkpoint({ toolCallId: c2, commit: "2".repeat(40) });
    s.toolResult({ toolCallId: c2, toolName: "edit_file", text: "ok" });
    s.endRun();
    const view = await viewOf(s, sessionsDir);
    // 快照打在第 2 条（助手消息）之后、归到第 3 条（工具结果）：第 1、2 条分叉点在它之前，取改前基线
    assert.deepEqual(storeCheckpointBefore(view, { runId: first, runSeq: 1 }), {
      commit: "0".repeat(40),
    });
    assert.deepEqual(storeCheckpointBefore(view, { runId: first, runSeq: 2 }), {
      commit: "0".repeat(40),
    });
    assert.equal(storeCheckpointBefore(view, { runId: first, runSeq: 3 })?.commit, "1".repeat(40));
    assert.equal(storeCheckpointBefore(view, { runId: second, runSeq: 1 })?.commit, "1".repeat(40));
    assert.equal(storeCheckpointBefore(view, { runId: second, runSeq: 2 })?.commit, "1".repeat(40));
    assert.equal(storeCheckpointBefore(view, { runId: second, runSeq: 3 })?.commit, "2".repeat(40));

    const branch = await forkFixture({
      sessionsDir,
      sourceSessionId: s.sessionId,
      runId: second,
      runSeq: 1,
    });
    const own = branch.startRun({ task: "分支" });
    branch.assistant({ text: "分支完成" });
    branch.endRun();
    const branchView = await viewOf(branch, sessionsDir);
    assert.deepEqual(
      branchView.runs.map((run) => run.runId),
      [own]
    );
    assert.equal(branchView.metadata?.branch?.sourceSessionId, s.sessionId);
  });
});

// 带运行面标记的工具结果（details.pigeon：错误归类与审批闸决定），同生产的形状
function markedResult(
  s: FixtureSession,
  input: {
    toolCallId: string;
    toolName: string;
    text?: string;
    isError?: boolean;
    errorKind?: "domain" | "environment";
    gate?: { outcome: "approved" | "rejected"; approvedBy: string };
  }
): void {
  s.writer.appendMessage({
    role: "toolResult",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    content: [{ type: "text", text: input.text ?? "ok" }],
    details: {
      [TOOL_RESULT_MARK_KEY]: {
        ...(input.errorKind !== undefined ? { errorKind: input.errorKind } : {}),
        ...(input.gate !== undefined ? { gate: input.gate } : {}),
      },
    },
    isError: input.isError ?? false,
    timestamp: Date.now(),
  } as never);
}

test("工具级失败分类（带运行面标记）：域错误为业务失败、环境异常为基础设施错误、判不出为未知；审批闸拒绝（含人工拒绝）为非失败；上游拦截为业务失败", async () => {
  await withSessions(async (sessionsDir, root) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    s.startRun({
      task: "做",
      config: { policy: { allow: ["edit_file"], deny: [], approvalMode: "prompt" } },
    });
    const approved = { outcome: "approved", approvedBy: "human" } as const;
    const cases: Array<[Parameters<typeof markedResult>[1], unknown]> = [];
    const call = (
      mark: Omit<Parameters<typeof markedResult>[1], "toolCallId" | "toolName">,
      want: unknown
    ) => {
      const [toolCallId = ""] = s.assistant({ toolCalls: [{ name: "edit_file" }] });
      const input = { toolCallId, toolName: "edit_file", ...mark };
      markedResult(s, input);
      cases.push([input, want]);
    };
    call({ isError: true, errorKind: "domain", gate: approved }, { category: "business" });
    call(
      { isError: true, errorKind: "environment", gate: approved },
      { category: "infrastructure" }
    );
    call({ isError: true, gate: approved }, { category: "unknown" });
    call(
      { isError: true, text: "不准改", gate: { outcome: "rejected", approvedBy: "human" } },
      null
    );
    call({ isError: true, text: "参数不对", errorKind: "domain" }, { category: "business" });
    call({ gate: approved }, null);
    s.assistant({ text: "完成" });
    s.endRun();
    const view = await viewOf(s, sessionsDir);
    const byCall = new Map(
      storeToolOutcomes(view).map((outcome) => [outcome.toolCallId, outcome.failure])
    );
    assert.deepEqual(
      cases.map(([input]) => byCall.get(input.toolCallId)),
      cases.map(([, want]) => want)
    );
  });
});

test("需审批次数（带运行面标记）：计 yolo 批发授权、人工批准或拒绝、无审批通道的拒绝；固化规则、会话放权、deny 清单与读档不计", async () => {
  await withSessions(async (sessionsDir, root) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    s.startRun({ task: "做" });
    const gated = (
      name: string,
      gate: { outcome: "approved" | "rejected"; approvedBy: string },
      text?: string
    ) => {
      const [toolCallId = ""] = s.assistant({ toolCalls: [{ name }] });
      markedResult(s, {
        toolCallId,
        toolName: name,
        gate,
        ...(text !== undefined ? { text, isError: true } : {}),
      });
    };
    gated("edit_file", { outcome: "approved", approvedBy: "policy:yolo" });
    gated("run_command", { outcome: "approved", approvedBy: "human" });
    gated("edit_file", { outcome: "rejected", approvedBy: "human" }, "不准改");
    gated(
      "edit_file",
      { outcome: "rejected", approvedBy: "policy:deny" },
      FAIL_CLOSED_APPROVAL_REASON
    );
    gated("edit_file", { outcome: "approved", approvedBy: "policy:config" });
    gated("edit_file", { outcome: "approved", approvedBy: "human:grant" });
    gated(
      "run_command",
      { outcome: "rejected", approvedBy: "policy:deny" },
      "run_command 在 deny 清单上"
    );
    gated("read_file", { outcome: "approved", approvedBy: "policy:yolo" });
    s.assistant({ text: "完成" });
    s.endRun();
    const view = await viewOf(s, sessionsDir);
    const tiers = new Map([
      ["read_file", "read"],
      ["edit_file", "write"],
      ["run_command", "exec"],
    ]);
    assert.equal(storeRunMetrics(view, { toolTiers: tiers }).approvalsNeeded, 4);
  });
});
