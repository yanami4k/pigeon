// M2 S3：TUI 审批面板离屏测试（与 shell.test.ts 同一 Mock Terminal + 虚拟屏幕路径）。
// 断言面：
//   - 审批块渲染：工具名 + pretty JSON 参数 + diff 预览 + 四键提示（措辞与 cli 版同口径，
//     [d] 仅在 args.path 可定位目录时提供，决策 3a）；
//   - 四键各自 resolve 的 ApprovalDecision 形状：[y] 批准一次 / [n] 拒绝（无理由输入通道，
//     决策 029）/ [a] 工具级会话 grant / [d] 目录限定会话 grant（pathPrefix=调用目录）；
//   - [d] 无 path 时不提供该键；仍按下与 cli 版同语义退化为工具级（同 [a]）；
//   - fail-closed：壳停止（理由逐字）、面板未装配；面板期间普通输入忽略（不提交不回显）；
//   - 集成：真实 PiRuntimeAdapter 审批闸挂起等按键，[y] 批准后写副作用真实发生。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler, ApprovalRequest } from "../approvals/handler.ts";
import { PiRuntimeAdapter, type RunResult, type StreamTextDelta } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import {
  APPROVAL_CANCEL_CLOSED,
  APPROVAL_CANCEL_DETACHED,
  createTuiApprovalHandler,
} from "./approval.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle } from "./testing.ts";

const SESSION_ID: SessionId = newSessionId();

// 最小 application 面：记录 run 提交（面板期间输入不得漏进 run）
class StubRuntime implements TuiRuntimeFace {
  readonly runs: string[] = [];

  run(input: string): Promise<RunResult> {
    this.runs.push(input);
    // 挂起不决议：面板测试只断言「提交未发生」，终态不消费
    const { promise } = Promise.withResolvers<RunResult>();
    return promise;
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
  diffPreview: "@@ -1 +1 @@ -alpha +STEP1",
  runId: newRunId(),
};

function makePanel(): {
  shell: PigeonTuiShell;
  term: MockTerminal;
  runtime: StubRuntime;
  store: SessionGrantStore;
  handler: ApprovalHandler;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-approval-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  const term = new MockTerminal(80, 24);
  const runtime = new StubRuntime();
  const store = new SessionGrantStore({ workspaceRoot: root });
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId: SESSION_ID, logDir });
  // 装配形态同 main.ts：face 晚绑定（handler 先于 shell 构造）
  const handler = createTuiApprovalHandler(store, () => shell);
  return {
    shell,
    term,
    runtime,
    store,
    handler,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("审批块渲染工具名/参数/diff/四键提示；[y] resolve 批准一次", async () => {
  const { shell, term, handler, cleanup } = makePanel();
  try {
    shell.start();
    await settle();
    const pending = handler(REQUEST);
    await settle();
    const text = screenText(term);
    assert.ok(text.includes("—— 人工审批 ——"), text);
    assert.ok(text.includes("工具：edit_file"), text);
    assert.ok(text.includes('"path": "src/a.ts"'), `pretty JSON 参数\n${text}`);
    assert.ok(text.includes("改动预览："), text);
    assert.ok(text.includes("@@ -1 +1 @@ -alpha +STEP1"), text);
    assert.ok(
      screenFlat(term).includes(
        "批准执行？[y] 批准一次 / [n] 拒绝 / [a] 本会话允许 / [d] 本会话允许(仅限当前调用所在目录)"
      ),
      `四键提示与 cli 版同口径（折行后拼接还原）\n${text}`
    );
    assert.ok(text.includes("state: approval"), `审批期间状态栏\n${text}`);

    term.input("y");
    assert.deepEqual(await pending, { approved: true });
    await settle();
    assert.ok(screenText(term).includes("审批结果：人工批准"));
    assert.ok(screenText(term).includes("state: idle"), "决议后状态栏复原");
  } finally {
    shell.stop();
    cleanup();
  }
});

test("[n] resolve 拒绝且无理由（四键面板无理由输入通道，决策 029）；大写键等效", async () => {
  const { shell, term, handler, cleanup } = makePanel();
  try {
    shell.start();
    await settle();
    const pending = handler(REQUEST);
    await settle();
    term.input("N");
    assert.deepEqual(await pending, { approved: false });
    await settle();
    assert.ok(screenText(term).includes("审批结果：人工拒绝"));
  } finally {
    shell.stop();
    cleanup();
  }
});

test("[a] resolve 批准并创建工具级会话 grant（pathPrefix 缺省），回显与 cli 同措辞", async () => {
  const { shell, term, store, handler, cleanup } = makePanel();
  try {
    shell.start();
    await settle();
    const pending = handler(REQUEST);
    await settle();
    term.input("a");
    assert.deepEqual(await pending, { approved: true });
    const grants = store.list();
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.tool, "edit_file");
    assert.equal(grants[0]?.pathPrefix, undefined);
    assert.equal(grants[0]?.firstCall.toolCallId, "tc-1");
    assert.equal(grants[0]?.hitCount, 0);
    await settle();
    const text = screenText(term);
    assert.ok(text.includes("审批结果：人工授权（会话 grant）"), text);
    assert.ok(text.includes(`已创建会话放权 ${grants[0]?.grantId}（edit_file）`), text);
  } finally {
    shell.stop();
    cleanup();
  }
});

test("[d] resolve 批准并创建目录限定会话 grant（pathPrefix=调用目录）", async () => {
  const { shell, term, store, handler, cleanup } = makePanel();
  try {
    shell.start();
    await settle();
    const pending = handler(REQUEST);
    await settle();
    term.input("d");
    assert.deepEqual(await pending, { approved: true });
    const grants = store.list();
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.pathPrefix, dirname("src/a.ts"), "pathPrefix=调用所在目录");
  } finally {
    shell.stop();
    cleanup();
  }
});

test("[d] 无 path 时不提供该键；仍按下与 cli 版同语义退化为工具级（同 [a]）", async () => {
  const { shell, term, store, handler, cleanup } = makePanel();
  try {
    shell.start();
    await settle();
    const pending = handler({
      toolName: "write_note",
      toolCallId: "tc-9",
      args: { text: "没有路径参数" },
    });
    await settle();
    const text = screenText(term);
    assert.ok(
      screenFlat(term).includes("批准执行？[y] 批准一次 / [n] 拒绝 / [a] 本会话允许"),
      `无 path 时提示不含 [d]\n${text}`
    );
    assert.ok(!text.includes("[d]"), text);
    term.input("d");
    assert.deepEqual(await pending, { approved: true });
    assert.equal(store.list()[0]?.pathPrefix, undefined, "退化为工具级放权");
  } finally {
    shell.stop();
    cleanup();
  }
});

test("fail-closed：壳停止时挂起的审批按拒绝处理，理由逐字（决策 029）", async () => {
  const { shell, handler, cleanup } = makePanel();
  try {
    shell.start();
    await settle();
    const pending = handler(REQUEST);
    await settle();
    shell.stop();
    assert.deepEqual(await pending, { approved: false, reason: APPROVAL_CANCEL_CLOSED });
  } finally {
    cleanup();
  }
});

test("fail-closed：面板未装配（face getter 返回 undefined）按拒绝处理，理由逐字", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-approval-"));
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    const detached = createTuiApprovalHandler(store, () => undefined);
    assert.deepEqual(await detached(REQUEST), {
      approved: false,
      reason: APPROVAL_CANCEL_DETACHED,
    });
    assert.equal(store.list().length, 0, "fail-closed 不得创建 grant");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("面板期间普通输入忽略：不提交 run、不回显、非四键吞掉（决策 029 简单语义）", async () => {
  const { shell, term, runtime, handler, cleanup } = makePanel();
  try {
    shell.start();
    await settle();
    const pending = handler(REQUEST);
    await settle();
    term.input("你好");
    term.input("\r");
    term.input("z");
    term.input("\x1b[A"); // 方向键等转义序列同样吞掉
    await settle();
    assert.deepEqual(runtime.runs, [], "面板期间不得提交 run");
    const text = screenText(term);
    assert.ok(!text.includes("> 你好"), "面板期间输入不回显");
    // 面板仍在等键：四键之一才决议
    term.input("y");
    assert.deepEqual(await pending, { approved: true });
  } finally {
    shell.stop();
    cleanup();
  }
});

test("集成：真实 adapter 审批闸挂起等按键——[y] 批准后写副作用真实发生", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-approval-e2e-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  writeFileSync(join(root, "a.ts"), "alpha\n");
  const term = new MockTerminal(80, 24);
  const store = new SessionGrantStore({ workspaceRoot: root });
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
  const editArgs: EditFileParams = {
    path: "a.ts",
    snapshot: snapshotTag("alpha\n"),
    edits: [{ op: "replace", anchor: `1#${lineTag("alpha")}`, lines: ["STEP1"] }],
  };
  // face 晚绑定：adapter 的 handler 先于 shell 构造（同 main.ts 装配序）
  const faceHolder: { current: PigeonTuiShell | undefined } = { current: undefined };
  const adapter = new PiRuntimeAdapter({
    snapshot: {
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
    },
    streamFn: createFakeStreamFn({
      replies: [
        { text: "改", toolCalls: [{ name: "edit_file", args: editArgs as never }] },
        { text: "完成" },
      ],
    }),
    registry,
    tools: [createReadFileTool(root), createEditFileTool(root)],
    approvalHandler: createTuiApprovalHandler(store, () => faceHolder.current),
    sessionGrants: store,
    workspaceRoot: root,
  });
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: adapter,
    sessionId: SESSION_ID,
    logDir,
  });
  faceHolder.current = shell;
  try {
    shell.start();
    await settle();
    term.input("把 alpha 改成 STEP1");
    term.input("\r");
    // 审批闸挂起：等审批块出现（真实 adapter 异步跑循环）
    let text = "";
    for (let waited = 0; waited < 5000 && !text.includes("—— 人工审批 ——"); waited += 50) {
      await settle(50);
      text = screenText(term);
    }
    assert.ok(text.includes("工具：edit_file"), `审批块\n${text}`);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\n", "批准前副作用不得发生");
    term.input("y");
    for (let waited = 0; waited < 5000 && !screenText(term).includes("== run:"); waited += 50) {
      await settle(50);
    }
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "STEP1\n", "批准后写副作用真实发生");
    const finalText = screenText(term);
    assert.ok(finalText.includes("审批结果：人工批准"), finalText);
    assert.ok(finalText.includes("== run: completed"), finalText);
  } finally {
    shell.stop();
    await adapter.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});
