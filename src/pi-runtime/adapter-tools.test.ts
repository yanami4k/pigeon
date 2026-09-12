// M3 切片 3：治理接线测试——fake streamFn 驱动真实 pi-agent-core Agent，
// 验证"模型工具请求 → 策略判定 → 人工审批/自动放行 → 执行 → ToolExecution 账本"闭环。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import type { ApprovalRequest } from "../approvals/handler.ts";
import type { ToolProposedPayload, ToolSettledPayload } from "../state/runtime-events.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn, createGate } from "./fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

function makeWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-gov-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeSnapshot(
  policy: Partial<InjectionSnapshot["tools"]["policy"]> = {}
): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: {
      policy: { allow: [], deny: [], approvalMode: "prompt", ...policy },
      advertised: [],
    },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
}

// 注册表：read_file(read) + edit_file(write)，与真实工厂工具的元数据一致
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

function editCall(content: string, oldLine: string, newLine: string, line = 1): EditFileParams {
  return {
    path: "a.ts",
    snapshot: snapshotTag(content),
    edits: [{ op: "replace", anchor: `${line}#${lineTag(oldLine)}`, lines: [newLine] }],
  };
}

// 等 Adapter 观察到指定 kind 的事件
function waitForEvent(adapter: PiRuntimeAdapter, kind: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = adapter.subscribe((event) => {
    if (event.kind === kind) {
      unsubscribe();
      resolve();
    }
  });
  return promise;
}

// 收集指定工具名在事件日志里的 proposed/settled payload。
// payload 由自家 normalizePiEvent 落日志（同进程可信形状），命名窄化后读字段
function phantomToolEvents(
  adapter: PiRuntimeAdapter,
  toolName: string
): { proposed: ToolProposedPayload[]; settled: ToolSettledPayload[] } {
  const proposed: ToolProposedPayload[] = [];
  const settled: ToolSettledPayload[] = [];
  for (const event of adapter.events()) {
    if (event.kind === "tool.proposed") {
      const payload = event.payload as ToolProposedPayload;
      if (payload.toolName === toolName) {
        proposed.push(payload);
      }
    } else if (event.kind === "tool.settled") {
      const payload = event.payload as ToolSettledPayload;
      if (payload.toolName === toolName) {
        settled.push(payload);
      }
    }
  }
  return { proposed, settled };
}

test("yolo 模式：写工具自动放行并执行，账本 approvedBy=policy:yolo 且走到 settled", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"], approvalMode: "yolo" }),
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "改文件",
            toolCalls: [{ name: "edit_file", args: editCall(original, "beta", "BETA", 2) }],
          },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.deepEqual(result.advertisedTools, ["edit_file"]);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");

    assert.equal(result.toolExecutions.length, 1);
    const record = result.toolExecutions[0];
    assert.ok(record);
    assert.equal(record.state, "settled");
    assert.equal(record.toolName, "edit_file");
    assert.equal(record.decision?.outcome, "approved");
    assert.equal(record.decision?.approvedBy, "policy:yolo");
    // 账本留的是模型原始参数快照（spike S5）
    assert.deepEqual(record.rawArgs, editCall(original, "beta", "BETA", 2));
    // 事件流对齐：tool.proposed / tool.settled 与账本同一 toolCallId
    const kinds = adapter.events().map((event) => event.kind);
    assert.ok(kinds.includes("tool.proposed"));
    assert.ok(kinds.includes("tool.settled"));

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("prompt 模式：read 层自动放行（approvedBy=policy:auto），不弹审批", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "one\ntwo\n" });
  const approvalCalls: ApprovalRequest[] = [];
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["read_file"], approvalMode: "prompt" }),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "读文件", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
          { text: "读完了" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createReadFileTool(root)],
      approvalHandler: async (request) => {
        approvalCalls.push(request);
        return { approved: true };
      },
    });

    const result = await adapter.run("读文件");
    assert.equal(result.status, "completed");
    assert.equal(approvalCalls.length, 0, "read 层不应触发人工审批");
    const record = result.toolExecutions[0];
    assert.ok(record);
    assert.equal(record.decision?.approvedBy, "policy:auto");
    assert.equal(record.state, "settled");
    // 工具真实执行：toolResult 带回锚点输出
    const toolResult = adapter.transcript().find((message) => message.role === "toolResult");
    assert.ok(toolResult);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("prompt 模式：write 触发审批，批准后执行；handler 收到工具名/args/diff 预览", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const approvalCalls: ApprovalRequest[] = [];
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"], approvalMode: "prompt" }),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original, "y", "Y", 2) }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      approvalHandler: async (request) => {
        approvalCalls.push(request);
        return { approved: true };
      },
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "x\nY\n");

    assert.equal(approvalCalls.length, 1);
    const request = approvalCalls[0];
    assert.ok(request);
    assert.equal(request.toolName, "edit_file");
    assert.deepEqual(request.args, editCall(original, "y", "Y", 2));
    assert.ok(request.diffPreview?.includes("+Y"), String(request.diffPreview));

    const record = result.toolExecutions[0];
    assert.ok(record);
    assert.equal(record.decision?.approvedBy, "human");

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("prompt 模式：审批拒绝 → execute 未被调用，reason 逐字进 toolResult", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"], approvalMode: "prompt" }),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original, "y", "Y", 2) }] },
          { text: "好吧" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      approvalHandler: async () => ({ approved: false, reason: "不准改这个文件" }),
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    // 副作用未发生
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
    // reason 逐字成为模型可见的 error toolResult（spike S2a）
    const toolResult = adapter.transcript().find((message) => message.role === "toolResult");
    assert.ok(toolResult);
    const text = toolResult.content[0];
    assert.ok(text?.type === "text" && text.text === "不准改这个文件", JSON.stringify(toolResult));

    const record = result.toolExecutions[0];
    assert.ok(record);
    assert.equal(record.decision?.outcome, "rejected");
    assert.equal(record.decision?.approvedBy, "human");
    assert.equal(record.decision?.reason, "不准改这个文件");
    // 拒绝路径没有 dispatch/execution 时间戳，但经 tool_execution_end 落到 settled
    assert.equal(record.dispatchedAt, undefined);
    assert.equal(record.state, "settled");

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("deny 清单绝对：两种模式都拒，且不弹人工审批", async () => {
  for (const approvalMode of ["prompt", "yolo"] as const) {
    const { root, cleanup } = makeWorkspace({ "a.ts": "one\ntwo\n" });
    let handlerCalled = false;
    try {
      const adapter = new PiRuntimeAdapter({
        snapshot: makeSnapshot({ allow: ["read_file"], deny: ["read_file"], approvalMode }),
        streamFn: createFakeStreamFn({
          replies: [
            { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
            { text: "明白" },
          ],
        }),
        registry: makeRegistry(),
        tools: [createReadFileTool(root)],
        approvalHandler: async () => {
          handlerCalled = true;
          return { approved: true };
        },
      });

      const result = await adapter.run("读文件");
      assert.equal(result.status, "completed");
      assert.equal(handlerCalled, false, `${approvalMode} 模式下 deny 不应弹审批`);
      const record = result.toolExecutions[0];
      assert.ok(record);
      assert.equal(record.decision?.outcome, "rejected");
      assert.equal(record.decision?.approvedBy, "policy:deny");
      // deny 不影响广告（allow 决定广告集），deny 在审批闸逐调用绝对执行并留账
      assert.deepEqual(result.advertisedTools, ["read_file"]);
      // 阻断必须对模型可见：deny 理由逐字成为 error toolResult（P2-3 闭环——
      // 若 deny 分支被改成放行，read_file 真实执行，toolResult 变成文件内容，此处变红）
      const toolResult = adapter.transcript().find((message) => message.role === "toolResult");
      assert.ok(toolResult && toolResult.role === "toolResult");
      assert.equal(toolResult.isError, true);
      const text = toolResult.content[0];
      assert.ok(
        text?.type === "text" && text.text === "deny 清单精确匹配，任何模式一律拒绝：read_file",
        JSON.stringify(toolResult)
      );

      await adapter.dispose();
    } finally {
      cleanup();
    }
  }
});

test("未广告的工具名：上游 not found 兜底，账本零记录；广告未注册工具则构造期拒绝", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "one\n" });
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: [] }),
      streamFn: createFakeStreamFn({
        replies: [{ text: "调", toolCalls: [{ name: "ghost_tool", args: {} }] }, { text: "明白" }],
      }),
      registry: makeRegistry(),
      tools: [createReadFileTool(root)],
    });

    const result = await adapter.run("调用幽灵工具");
    assert.equal(result.status, "completed");
    assert.deepEqual(result.advertisedTools, []);
    assert.equal(result.toolExecutions.length, 0);
    const toolResult = adapter.transcript().find((message) => message.role === "toolResult");
    const text = toolResult?.content[0];
    assert.ok(text?.type === "text" && text.text.includes("not found"), JSON.stringify(toolResult));

    await adapter.dispose();

    // 广告了未在注册表登记的工具 = 配置错误，fail-fast
    assert.throws(
      () =>
        new PiRuntimeAdapter({
          snapshot: makeSnapshot({ allow: ["edit_file"] }),
          streamFn: createFakeStreamFn({ replies: [{ text: "x" }] }),
          registry: new ToolRegistry(),
          tools: [createEditFileTool(root)],
        }),
      /未在注册表登记/
    );
  } finally {
    cleanup();
  }
});

test("run() 互斥：已有在途 Run 时第二个 run 直接抛错（决策 2）", async () => {
  const gate = createGate();
  const adapter = new PiRuntimeAdapter({
    snapshot: makeSnapshot(),
    streamFn: createFakeStreamFn({
      replies: [{ text: "足够长的流式回复以支撑门闩。", chunkSize: 2, chunkGate: gate }],
    }),
  });
  const turnStarted = waitForEvent(adapter, "turn.started");
  const first = adapter.run("你好");
  await turnStarted;

  await assert.rejects(() => adapter.run("第二个"), /互斥/);

  gate.open();
  const result = await first;
  assert.equal(result.status, "completed");
  await adapter.dispose();
});

test("熔断：模型坚持重发同一被拦调用，计数到阈值后 Run 以 aborted 收尾（不悬挂）", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"], deny: ["edit_file"], approvalMode: "yolo" }),
      // 回复队列只有一条工具调用，耗尽后无限重复 → 模型永不放弃
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "再试",
            toolCalls: [{ name: "edit_file", args: editCall(original, "y", "Y", 2) }],
          },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
    });

    const result = await adapter.run("改文件");
    // 默认阈值 3：阻断 3 次后 abort
    assert.equal(result.status, "aborted");
    assert.equal(result.toolExecutions.length, 3);
    for (const record of result.toolExecutions) {
      assert.equal(record.decision?.outcome, "rejected");
      assert.equal(record.state, "settled");
    }
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("账本与事件对齐：完整 Run 后时间戳逐阶段盖章，toolCallId 贯穿事件与账本", async () => {
  const original = "alpha\nbeta\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"], approvalMode: "yolo" }),
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "改",
            toolCalls: [{ name: "edit_file", args: editCall(original, "beta", "B", 2) }],
          },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
    });

    const result = await adapter.run("改文件");
    const record = result.toolExecutions[0];
    assert.ok(record);
    // 时间戳链路：proposed ≤ decided ≤ dispatched ≤ executionStarted ≤ settled
    assert.ok(record.decision);
    assert.ok(record.proposedAt <= record.decision.decidedAt);
    assert.ok(
      record.dispatchedAt !== undefined && record.decision.decidedAt <= record.dispatchedAt
    );
    assert.ok(
      record.executionStartedAt !== undefined && record.dispatchedAt <= record.executionStartedAt
    );
    assert.ok(record.settledAt !== undefined && record.executionStartedAt <= record.settledAt);

    const proposed = adapter.events().find((event) => event.kind === "tool.proposed");
    const settled = adapter.events().find((event) => event.kind === "tool.settled");
    assert.ok(proposed && settled);
    assert.equal((proposed.payload as { toolCallId: string }).toolCallId, record.toolCallId);
    assert.equal((settled.payload as { toolCallId: string }).toolCallId, record.toolCallId);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("幽灵工具名熔断：模型循环请求从未广告的工具名，事件级计数到阈值后 Run 以 aborted 收尾", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "x\n" });
  try {
    // 模型连续 10 轮请求 delete_everything 才肯收尾——确定性定界（不用定时器）：
    // 熔断失效时 Run 会带着 10 次幽灵调用 completed，与熔断开火的 aborted 明确可区分
    const phantomReplies = Array.from({ length: 10 }, () => ({
      text: "",
      toolCalls: [{ name: "delete_everything", args: { target: "/" } }],
    }));
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["read_file"], approvalMode: "yolo" }),
      // delete_everything 从未广告：上游在 hook 前以 not-found 拦截，
      // 审批闸/账本/hook 级熔断全部不可见（spike tmp/notfound-spike.mjs）
      streamFn: createFakeStreamFn({ replies: [...phantomReplies, { text: "放弃" }] }),
      registry: makeRegistry(),
      tools: [createReadFileTool(root)],
    });

    const result = await adapter.run("删掉一切");
    assert.equal(result.status, "aborted");
    // 事件级熔断在默认阈值 3 处开火：恰好 3 组幽灵 proposed/settled，多一组都说明熔断迟到
    const phantom = phantomToolEvents(adapter, "delete_everything");
    assert.equal(phantom.proposed.length, 3);
    assert.equal(phantom.settled.length, 3);
    assert.ok(phantom.settled.every((payload) => payload.isError));
    // hook 从未运行：账本零记录，事件日志是幽灵循环的唯一审计轨迹
    assert.equal(result.toolExecutions.length, 0);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("幽灵调用不干扰正常治理：幽灵一次后 read_file 照常放行执行，Run 完成", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "alpha\n" });
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["read_file"], approvalMode: "yolo" }),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "试试幽灵", toolCalls: [{ name: "delete_everything", args: {} }] },
          { text: "读文件", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createReadFileTool(root)],
    });

    const result = await adapter.run("走一遍");
    assert.equal(result.status, "completed");
    // 正常工具治理不受影响：read_file 有完整账本且走到 settled
    assert.equal(result.toolExecutions.length, 1);
    assert.equal(result.toolExecutions[0]?.toolName, "read_file");
    assert.equal(result.toolExecutions[0]?.state, "settled");
    // 幽灵调用只在事件日志留痕，不进账本
    assert.equal(phantomToolEvents(adapter, "delete_everything").settled.length, 1);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("幽灵熔断是连续语义：正常工具调用重置连击，未连续达阈值不中止", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "alpha\n" });
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["read_file"], approvalMode: "yolo" }),
      // 幽灵×2 → 正常 read_file（重置）→ 幽灵×2 → 收尾：默认阈值 3 下任何一段都不到 3
      streamFn: createFakeStreamFn({
        replies: [
          { text: "", toolCalls: [{ name: "delete_everything", args: {} }] },
          { text: "", toolCalls: [{ name: "delete_everything", args: {} }] },
          { text: "", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
          { text: "", toolCalls: [{ name: "delete_everything", args: {} }] },
          { text: "", toolCalls: [{ name: "delete_everything", args: {} }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createReadFileTool(root)],
    });

    const result = await adapter.run("走一遍");
    assert.equal(result.status, "completed");
    assert.equal(phantomToolEvents(adapter, "delete_everything").settled.length, 4);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("参数校验失败循环熔断：模型持续给已广告工具发畸形参数，事件级计数到阈值后 aborted", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "x\n" });
  try {
    // edit_file 缺 snapshot/edits：上游 validateToolArguments 在 beforeToolCall 之前拦截
    // （agent-loop.js:399-448），审批闸/账本不可见，但 tool_execution_end 照常到达——
    // 与幽灵工具名同属"上游拦截"路径，必须由事件级熔断收口
    const malformedReplies = Array.from({ length: 10 }, () => ({
      text: "",
      toolCalls: [{ name: "edit_file", args: { path: "a.ts" } }],
    }));
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"], approvalMode: "yolo" }),
      streamFn: createFakeStreamFn({ replies: [...malformedReplies, { text: "放弃" }] }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "aborted");
    // 事件级熔断在默认阈值 3 处开火：恰好 3 组 settled，多一组都说明熔断迟到
    const { settled } = phantomToolEvents(adapter, "edit_file");
    assert.equal(settled.length, 3);
    assert.ok(settled.every((payload) => payload.isError));
    // hook 从未运行：账本零记录，事件日志是唯一审计轨迹
    assert.equal(result.toolExecutions.length, 0);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("deny 熔断按工具名计数：模型每轮微调参数绕行指纹，仍计数到阈值 aborted", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "x\n" });
  try {
    // deny 是绝对拒绝：参数改不改都照样拒，任何重试皆徒劳——故按工具名计数，
    // 模型微调字段不能重置连击（人工拒绝相反：保留指纹计数，鼓励改参重提，见下个测试）
    const evadingReplies = Array.from({ length: 10 }, (_, index) => ({
      text: "",
      toolCalls: [{ name: "read_file", args: { path: `f${index}.ts` } }],
    }));
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({
        allow: ["read_file"],
        deny: ["read_file"],
        approvalMode: "yolo",
      }),
      streamFn: createFakeStreamFn({ replies: [...evadingReplies, { text: "放弃" }] }),
      registry: makeRegistry(),
      tools: [createReadFileTool(root)],
    });

    const result = await adapter.run("读文件");
    assert.equal(result.status, "aborted");
    assert.equal(result.toolExecutions.length, 3);
    for (const record of result.toolExecutions) {
      assert.equal(record.decision?.outcome, "rejected");
      assert.equal(record.decision?.approvedBy, "policy:deny");
    }

    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("人工拒绝保留指纹计数：模型改参重提是期望的修订循环，不触发熔断", async () => {
  const original = "x\ny\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    // 决策 1 鼓励模型在人工拒绝后改参数重提：5 次提案参数互异、都被人拒绝，
    // 指纹计数不累积——若误用工具名级计数，第 3 次就会被熔断中止（阈值 3 < 5）
    const revisedReplies = Array.from({ length: 5 }, (_, index) => ({
      text: "再改",
      toolCalls: [{ name: "edit_file", args: editCall(original, "y", `Y${index}`, 2) }],
    }));
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"], approvalMode: "prompt" }),
      streamFn: createFakeStreamFn({ replies: [...revisedReplies, { text: "放弃" }] }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      approvalHandler: async () => ({ approved: false, reason: "再想想" }),
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.equal(result.toolExecutions.length, 5);
    for (const record of result.toolExecutions) {
      assert.equal(record.decision?.outcome, "rejected");
      assert.equal(record.decision?.approvedBy, "human");
    }
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);

    await adapter.dispose();
  } finally {
    cleanup();
  }
});
