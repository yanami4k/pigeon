// TUI 拒绝理由通道（决策 066）：面板保留 [n] 单按拒绝，新增 [r] 拒绝并说明——打开理由行，
// Esc 回面板不算拒绝，回车提交，理由逐字回模型；双击 Ctrl+C 的退出布防在理由行期间照旧生效。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler, ApprovalRequest } from "../approvals/handler.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { createTuiApprovalHandler } from "./approval.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle } from "./testing.ts";

const SESSION_ID: SessionId = newSessionId();

class StubRuntime implements TuiRuntimeFace {
  readonly runs: string[] = [];

  run(input: string): Promise<RunResult> {
    this.runs.push(input);
    const { promise } = Promise.withResolvers<RunResult>();
    return promise;
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  listenerErrors(): unknown[] {
    return [];
  }

  subscribe(_listener: (event: EventEnvelope) => void): () => void {
    return () => {};
  }

  subscribeStream(_listener: (delta: StreamTextDelta) => void): () => void {
    return () => {};
  }
}

const REQUEST: ApprovalRequest = {
  toolName: "edit_file",
  toolCallId: "tc-1",
  args: { path: "src/a.ts", edits: [{ op: "replace" }] },
  runId: newRunId(),
};

function makePanel(options: { onExit?: () => void; exitWindowMs?: number } = {}): {
  shell: PigeonTuiShell;
  term: MockTerminal;
  runtime: StubRuntime;
  handler: ApprovalHandler;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-reason-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-reason-log-"));
  const term = new MockTerminal(80, 24);
  const runtime = new StubRuntime();
  const store = new SessionGrantStore({ workspaceRoot: root });
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId: SESSION_ID,
    logDir,
    ...(options.onExit !== undefined ? { onExit: options.onExit } : {}),
    ...(options.exitWindowMs !== undefined ? { exitWindowMs: options.exitWindowMs } : {}),
  });
  const handler = createTuiApprovalHandler(store, () => shell);
  return {
    shell,
    term,
    runtime,
    handler,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("面板提示含 [r] 拒绝并说明；[r] 打开理由行，回车提交后理由逐字回模型并标为人写", async () => {
  const { shell, term, runtime, handler, cleanup } = makePanel();
  try {
    shell.start();
    await settle();
    const pending = handler(REQUEST);
    await settle();
    assert.ok(screenFlat(term).includes("[r] 拒绝并说明"), `面板提示应含 [r]\n${screenText(term)}`);

    term.input("r");
    await settle();
    assert.ok(screenText(term).includes("拒绝理由"), `[r] 应打开理由行\n${screenText(term)}`);

    term.input("这个文件不该动");
    term.input("\r");
    assert.deepEqual(await pending, {
      approved: false,
      reason: "这个文件不该动",
      reasonSource: "human",
    });
    await settle();
    assert.equal(runtime.runs.length, 0, "理由行的回车不得当作任务提交");
    assert.ok(screenText(term).includes("审批结果：人工拒绝"), screenText(term));
  } finally {
    shell.stop();
    cleanup();
  }
});

test("理由行按 Esc 回到面板：不算拒绝，审批仍挂起，随后 [n] 照常单按决议", async () => {
  const { shell, term, handler, cleanup } = makePanel();
  try {
    shell.start();
    await settle();
    const pending = handler(REQUEST);
    await settle();
    term.input("r");
    await settle();
    term.input("\x1b");
    await settle();
    assert.ok(
      screenText(term).includes("state: approval"),
      `Esc 后仍在审批面板\n${screenText(term)}`
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await settle();
    assert.equal(settled, false, "Esc 不得决议为拒绝");

    term.input("n");
    assert.deepEqual(await pending, { approved: false });
  } finally {
    shell.stop();
    cleanup();
  }
});

test("理由行期间双击 Ctrl+C 照常优雅退出（退出布防不受输入模式影响）", async () => {
  let exited = 0;
  const { shell, term, handler, cleanup } = makePanel({
    onExit: () => {
      exited += 1;
    },
  });
  try {
    shell.start();
    await settle();
    const pending = handler(REQUEST);
    await settle();
    term.input("r");
    await settle();
    term.input("\x03");
    term.input("\x03");
    await settle();
    assert.equal(exited, 1, "双击 Ctrl+C 应触发优雅退出");
    // 壳停止时挂起的审批 fail-closed 按拒绝处理（理由逐字，决策 029）
    const decision = await pending;
    assert.equal(decision.approved, false);
  } finally {
    shell.stop();
    cleanup();
  }
});
