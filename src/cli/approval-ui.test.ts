// M4 S6（决策 3）审批提示四键测试：[y] 批准一次 / [n] 拒绝 / [a] 本会话允许（工具级 grant）
// / [d] 本会话允许（仅限当前调用所在目录）——[d] 仅当调用带可解析 path 参数时提供。
// 创建 grant 必须先写成授权建立条目（落盘失败 = grant 不生效，fail-closed）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import type { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { asRunId } from "../state/ids.ts";
import { createCliApprovalHandler } from "./approval-ui.ts";
import { runRepl, sanitizedWriter } from "./repl.ts";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolName: "edit_file",
    toolCallId: "toolu_01ABC",
    args: { path: "src/a.ts" },
    runId: asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
    ...overrides,
  };
}

test("[a] 创建工具级 grant：批准本次调用，grant 入 store 且 firstCall 回指本次调用", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-"));
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    const outputs: string[] = [];
    const ask = async (prompt: string): Promise<string> => {
      outputs.push(prompt);
      return "a";
    };
    const handler = createCliApprovalHandler(ask, (text) => outputs.push(text), {
      grants: store,
    });
    const request = makeRequest();
    const decision = await handler(request);
    assert.deepEqual(decision, { approved: true });

    const grants = store.list();
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.tool, "edit_file");
    assert.equal(grants[0]?.pathPrefix, undefined, "[a] 工具级：不限目录");
    assert.equal(grants[0]?.firstCall.toolCallId, "toolu_01ABC");
    // 四键提示在场：[d] 因 path 参数可解析而提供
    const promptText = outputs.join("");
    assert.ok(promptText.includes("[y]"), promptText);
    assert.ok(promptText.includes("[n]"), promptText);
    assert.ok(promptText.includes("[a] 本会话允许"), promptText);
    assert.ok(promptText.includes("[d]"), promptText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[d] 创建目录限定 grant：pathPrefix = 调用所在目录；无 path 参数时不提供 [d]", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-"));
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    // 目录限定：src/deep/a.ts → 仅限 src/deep
    const outputs: string[] = [];
    const handler = createCliApprovalHandler(
      async () => "d",
      (text) => outputs.push(text),
      { grants: store }
    );
    const decision = await handler(makeRequest({ args: { path: "src/deep/a.ts" } }));
    assert.deepEqual(decision, { approved: true });
    assert.equal(store.list()[0]?.pathPrefix, "src/deep");

    // 根级文件：所在目录 = 工作区根（"."），依旧提供 [d]（与 [a] 语义不同：仅限根内）
    const first = store.list()[0];
    assert.ok(first);
    store.revoke(first.grantId);
    const outputs2: string[] = [];
    const handler2 = createCliApprovalHandler(
      async () => "d",
      (text) => outputs2.push(text),
      { grants: store }
    );
    await handler2(makeRequest({ args: { path: "a.ts" } }));
    assert.equal(store.list()[0]?.pathPrefix, ".");

    // 非路径调用（args 无 path）：不提供 [d]，输入 d 回落拒绝流程前的未知键处理
    const outputs3: string[] = [];
    const ask3 = async (): Promise<string> => "y";
    const handler3 = createCliApprovalHandler(ask3, (text) => outputs3.push(text), {
      grants: store,
    });
    const decision3 = await handler3(makeRequest({ args: { code: "x" } }));
    assert.deepEqual(decision3, { approved: true }, "未知键 y 语义不受影响");
    const prompt3 = outputs3.join("");
    assert.ok(!prompt3.includes("[d]"), "无 path 参数不得提供 [d]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("授权建立条目写盘失败 = grant 不生效（fail-closed：免审授权必须留证后才存在）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-"));
  try {
    const store = new SessionGrantStore({
      workspaceRoot: root,
      sink: {
        appendGrantCreated: () => {
          throw new Error("磁盘故障");
        },
        appendGrantRevoked: () => {},
      },
    });
    const handler = createCliApprovalHandler(
      async () => "a",
      () => {},
      { grants: store }
    );
    await assert.rejects(() => handler(makeRequest()), /磁盘故障/);
    assert.equal(store.list().length, 0, "未落盘的 grant 不得生效");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("无 grants 存储时保持 y/N 两键形态（缺省不弹 grant 键）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-"));
  try {
    const outputs: string[] = [];
    const handler = createCliApprovalHandler(
      async (prompt) => {
        outputs.push(prompt);
        return "n";
      },
      (text) => outputs.push(text)
    );
    const decision = await handler(makeRequest());
    assert.equal(decision.approved, false);
    const promptText = outputs.join("");
    assert.ok(!promptText.includes("[a]"), promptText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("拒绝理由来源（决策 066）：输入了理由标人写；留空不带理由（由治理层落默认文案并标系统默认）", async () => {
  const answers = ["n", "别动测试目录"];
  const withReason = createCliApprovalHandler(
    async () => answers.shift() ?? "",
    () => {}
  );
  assert.deepEqual(await withReason(makeRequest()), {
    approved: false,
    reason: "别动测试目录",
    reasonSource: "human",
  });

  const blank = ["n", "   "];
  const withoutReason = createCliApprovalHandler(
    async () => blank.shift() ?? "",
    () => {}
  );
  assert.deepEqual(await withoutReason(makeRequest()), { approved: false });
});

test("终端边界净化（决策 036）：审批块 diffPreview 携带 CSI 时输出可见化为 ␛，原始序列不落终端", async () => {
  const outputs: string[] = [];
  // 与 cli/index.ts 同一形态：write 出口经 sanitizedWriter 包装（终端边界唯一净化点）
  const write = sanitizedWriter((text: string) => outputs.push(text));
  const handler = createCliApprovalHandler(async () => "y", write);
  const decision = await handler(
    makeRequest({ diffPreview: "@@ -1 +1 @@\n-旧的\n\x1b[2J+伪造的审批屏" })
  );
  assert.equal(decision.approved, true);
  const out = outputs.join("");
  assert.ok(out.includes("␛[2J+伪造的审批屏"), `CSI 应可见化，实际：${JSON.stringify(out)}`);
  assert.ok(!out.includes("\x1b"), "原始 ESC 字节不得写出");
});

test("终端边界净化（决策 036）：REPL 终态摘要 errorMessage 携带 CSI 时同样可见化", async () => {
  const outputs: string[] = [];
  const script = ["跑一下", ":quit"];
  const write = sanitizedWriter((text: string) => outputs.push(text));
  // REPL 只消费 adapter.run、adapter.listenerErrors 与压缩提示订阅——结构替身即足（终态决议形状同
  // RunResult：errorMessage 是模型/上游错误文本，半信任）
  const stub = {
    listenerErrors: () => [],
    subscribeCompaction: () => () => {},
    run: async () => ({
      runId: asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
      status: "failed",
      stopReason: "error",
      syntheticFailure: false,
      failure: { category: "infrastructure" },
      advertisedTools: [],
      toolExecutions: [],
      errorMessage: "provider 炸了：\x1b[2J 屏幕已清",
    }),
  } as unknown as PiRuntimeAdapter;
  await runRepl({
    adapter: stub,
    ask: async () => script.shift() ?? null,
    write,
  });
  const out = outputs.join("");
  assert.ok(
    out.includes("␛[2J 屏幕已清"),
    `errorMessage 的 CSI 应可见化，实际：${JSON.stringify(out)}`
  );
  assert.ok(!out.includes("\x1b"), "原始 ESC 字节不得写出");
});

test("决策 326 ①：受保护路径的请示只问 [y/N]；答 a 不建放权、按拒绝处理", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-"));
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    const outputs: string[] = [];
    const answers = ["a", ""];
    const handler = createCliApprovalHandler(
      async (prompt) => {
        outputs.push(prompt);
        return answers.shift() ?? "";
      },
      (text) => outputs.push(text),
      { grants: store }
    );
    const decision = await handler(
      makeRequest({
        args: { path: ".pigeon/settings.json" },
        protectedPath: ".pigeon/settings.json",
      })
    );
    assert.deepEqual(decision, { approved: false });
    assert.equal(store.list().length, 0);
    const text = outputs.join("");
    assert.ok(text.includes("受保护路径：.pigeon/settings.json"), text);
    assert.ok(text.includes("批准执行？[y/N]"), text);
    assert.ok(!text.includes("[a] 本会话允许"), text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
