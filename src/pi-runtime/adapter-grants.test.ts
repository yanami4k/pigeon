// M4 S6：Grant 体系治理接线测试——fake streamFn 驱动真实 pi-agent-core Agent，
// 验证排律（deny → 会话 grant → 配置 grant → yolo → read 自动 → prompt）中与 grant 相关的五条不变式：
// deny 压过 grant、approvedBy 扩展（human:grant / policy:config + grantRef 回指）、撤销立即生效、
// 崩溃恢复还原（授权条目落会话存储）；另测目录限定 grant 与会话 grant 优先于配置规则。
// 畸形配置、熔断、读调用自动放行见 grants-config.test.ts、adapter-tools.test.ts。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { test } from "vitest";
import { createToolGovernance } from "../application/governance.ts";
import { grantEventSink } from "../application/session-store.ts";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { appendGrantConfigRule, loadGrantConfig } from "../persistence/grants-config.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { asGrantId, asSessionId, type SessionId } from "../state/ids.ts";
import {
  type StoreSessionView,
  storeActiveGrants,
  toolResultMark,
} from "../state/session-judge.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn } from "./fixtures.ts";
import { openSessionStoreWriter, type SessionStoreWriter } from "./session-store.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

function makeWorkspace(files: Record<string, string> = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grant-gov-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// 真实会话存储写者（会话根 <root>/.pigeon/state/sessions）；existingPath 在场即续写已有文件（模拟冷重启后重新打开）
function openStore(root: string, sessionId: SessionId, existingPath?: string): SessionStoreWriter {
  return openSessionStoreWriter({
    sessionsRoot: join(root, ".pigeon", "state", "sessions"),
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
    ...(existingPath !== undefined ? { existingPath } : {}),
  });
}

// 读回会话存储里的视图（调用方已 close 写者）
function readStore(root: string, sessionId: SessionId): StoreSessionView {
  const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(loaded !== undefined, "会话存储里应有该会话的文件");
  return loaded.view;
}

// 视图里某个工具的全部工具结果消息上的标记
function marksOf(view: StoreSessionView, toolName: string) {
  return view.runs.flatMap((run) =>
    run.messages.flatMap(({ message }) =>
      message.role === "toolResult" && message.toolName === toolName
        ? [toolResultMark(message)]
        : []
    )
  );
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

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
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

function editCall(path: string, content: string, oldLine: string, newLine: string): EditFileParams {
  return {
    path,
    snapshot: snapshotTag(content),
    edits: [{ op: "replace", anchor: `1#${lineTag(oldLine)}`, lines: [newLine] }],
  };
}

test("不变式①deny 压过 grant：deny 清单在，grant 命中也一律拒绝（policy:deny）", async () => {
  const original = "alpha\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    store.create({ tool: "edit_file", firstCall: { toolCallId: "tc-seed", args: {} } });
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"], deny: ["edit_file"] }),
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "改",
            toolCalls: [{ name: "edit_file", args: editCall("a.ts", original, "alpha", "BETA") }],
          },
          { text: "好吧" },
        ],
      }),
      governance: createToolGovernance({
        registry: makeRegistry(),
        sessionGrants: store,
        workspaceRoot: root,
      }),
      tools: [createEditFileTool(root)],
    });
    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original, "deny 绝对：副作用未发生");
    const record = result.toolExecutions[0];
    assert.equal(record?.decision?.outcome, "rejected");
    assert.equal(record?.decision?.approvedBy, "policy:deny");
    assert.equal(record?.decision?.grantRef, undefined);
    // deny 压过 grant 不计命中
    assert.equal(store.list()[0]?.hitCount, 0);
    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("不变式②grant 命中：approvedBy=human:grant 带 grantRef 回指 grantId；授权条目与审批闸标记落会话存储", async () => {
  const original = "alpha\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const sessionId = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPQRV");
  try {
    const sessionStore = openStore(root, sessionId);
    const store = new SessionGrantStore({
      workspaceRoot: root,
      sink: grantEventSink(sessionStore),
    });
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "tc-seed", args: { path: "a.ts" } },
    });
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"] }),
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "改",
            toolCalls: [{ name: "edit_file", args: editCall("a.ts", original, "alpha", "BETA") }],
          },
          { text: "完成" },
        ],
      }),
      governance: createToolGovernance({
        registry: makeRegistry(),
        sessionGrants: store,
        workspaceRoot: root,
      }),
      tools: [createEditFileTool(root)],
      sessionStore,
      sessionId,
    });
    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "BETA\n");
    const record = result.toolExecutions[0];
    assert.equal(record?.decision?.approvedBy, "human:grant");
    assert.deepEqual(record?.decision?.grantRef, { kind: "session-grant", id: grant.grantId });
    await adapter.dispose();
    await sessionStore.close();

    // 会话存储：授权建立条目恰一条且就是这条 grant；工具结果消息上的审批闸标记记 human:grant
    const view = readStore(root, sessionId);
    assert.deepEqual(
      view.grants.map((record) => [record.data.event, record.data.grantId]),
      [["created", grant.grantId]]
    );
    assert.deepEqual(marksOf(view, "edit_file"), [
      { gate: { outcome: "approved", approvedBy: "human:grant" } },
    ]);
    // grant 放行照样计命中（/grants 展示面）
    assert.equal(store.list()[0]?.hitCount, 1);
  } finally {
    cleanup();
  }
});

test("不变式③撤销立即停免审：/revoke 后同工具调用重新弹人工审批", async () => {
  const original = "alpha\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "tc-seed", args: { path: "a.ts" } },
    });
    const approvals: ApprovalRequest[] = [];
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"] }),
      streamFn: createFakeStreamFn({
        replies: [
          // 第一次：grant 免审放行
          {
            text: "改1",
            toolCalls: [{ name: "edit_file", args: editCall("a.ts", "alpha\n", "alpha", "BETA") }],
          },
          { text: "好" },
          // 第二次：grant 已撤，必须人工
          {
            text: "改2",
            toolCalls: [{ name: "edit_file", args: editCall("a.ts", "BETA\n", "BETA", "GAMMA") }],
          },
          { text: "完" },
        ],
      }),
      governance: createToolGovernance({
        registry: makeRegistry(),
        sessionGrants: store,
        workspaceRoot: root,
        approvalHandler: async (request) => {
          approvals.push(request);
          return { approved: true };
        },
      }),
      tools: [createEditFileTool(root)],
    });
    const run1 = await adapter.run("第一轮");
    assert.equal(run1.toolExecutions[0]?.decision?.approvedBy, "human:grant");
    assert.equal(approvals.length, 0);

    // REPL 时段撤销（无活动 Run）：立即生效
    store.revoke(grant.grantId);
    assert.equal(store.match("edit_file", { path: "a.ts" }), null);

    const run2 = await adapter.run("第二轮");
    assert.equal(approvals.length, 1, "撤销后重新弹人工审批");
    assert.equal(run2.toolExecutions[0]?.decision?.approvedBy, "human");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "GAMMA\n");
    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("不变式④配置规则命中：approvedBy=policy:config，grantRef 回指规则的 promotedFrom.grantId（稳定身份）", async () => {
  const original = "alpha\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    // 人显式升格（/grants save 的写入面）：固化规则落 .pigeon/grants.json
    appendGrantConfigRule(root, {
      tool: "edit_file",
      promotedFrom: {
        grantId: asGrantId("grant_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
        sessionId: asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
        firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
        promotedAt: 1_757_000_000_000,
      },
    });
    const configGrants = loadGrantConfig(root);
    assert.equal(configGrants.length, 1);

    const approvals: ApprovalRequest[] = [];
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"] }),
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "改",
            toolCalls: [{ name: "edit_file", args: editCall("a.ts", original, "alpha", "BETA") }],
          },
          { text: "完成" },
        ],
      }),
      governance: createToolGovernance({
        registry: makeRegistry(),
        configGrants,
        workspaceRoot: root,
        approvalHandler: async (request) => {
          approvals.push(request);
          return { approved: true };
        },
      }),
      tools: [createEditFileTool(root)],
    });
    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.equal(approvals.length, 0, "配置规则免审");
    const record = result.toolExecutions[0];
    assert.equal(record?.decision?.approvedBy, "policy:config");
    // M4 收口决策 ①：回指稳定身份而非位置序号（序号随 /revoke config#N 前移，历史回指会漂移）
    assert.deepEqual(record?.decision?.grantRef, {
      kind: "config-rule",
      id: "grant_01J5Z7K8W9ABCDEFGHJKMNPQRS",
    });
    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("不变式⑤崩溃恢复：授权建立条目落会话存储 → 冷读还原 → 新进程静默继续免审（决策 3b）", async () => {
  const original = "alpha\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const sessionId = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPRSV");
  try {
    // 第一进程：人工批准后创建 grant（模拟 [a] 键），授权建立条目落会话存储
    const first = openStore(root, sessionId);
    const store = new SessionGrantStore({ workspaceRoot: root, sink: grantEventSink(first) });
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
    });
    const filePath = await first.filePath();
    await first.close();
    assert.ok(filePath !== undefined);

    // 崩溃 + 冷重启：从会话存储读回生效授权（静默恢复，无确认环节），注入新存储
    const active = storeActiveGrants(readStore(root, sessionId));
    assert.equal(active.length, 1);
    assert.equal(active[0]?.grantId, grant.grantId);
    assert.equal(active[0]?.tool, "edit_file");
    assert.deepEqual(active[0]?.firstCall, { toolCallId: "toolu_01ABC", args: { path: "a.ts" } });

    const second = openStore(root, sessionId, filePath);
    const restored = new SessionGrantStore({
      workspaceRoot: root,
      sink: grantEventSink(second),
      restored: active,
    });
    const approvals: ApprovalRequest[] = [];
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"] }),
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "改",
            toolCalls: [{ name: "edit_file", args: editCall("a.ts", original, "alpha", "BETA") }],
          },
          { text: "完成" },
        ],
      }),
      governance: createToolGovernance({
        registry: makeRegistry(),
        sessionGrants: restored,
        workspaceRoot: root,
        approvalHandler: async (request) => {
          approvals.push(request);
          return { approved: true };
        },
      }),
      tools: [createEditFileTool(root)],
      sessionId,
    });
    const result = await adapter.run("改文件");
    assert.equal(approvals.length, 0, "崩溃恢复后 grant 静默继续生效（无重复确认）");
    assert.equal(result.toolExecutions[0]?.decision?.approvedBy, "human:grant");
    assert.deepEqual(result.toolExecutions[0]?.decision?.grantRef, {
      kind: "session-grant",
      id: grant.grantId,
    });
    await adapter.dispose();
    await second.close();
  } finally {
    cleanup();
  }
});

test("目录限定 grant：目录内免审、目录外弹审批、非路径参数不命中（决策 3a）", async () => {
  const src = "alpha\n";
  const lib = "beta\n";
  const { root, cleanup } = makeWorkspace({ "src/a.ts": src, "lib/b.ts": lib });
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    store.create({
      tool: "edit_file",
      pathPrefix: "src",
      firstCall: { toolCallId: "tc-seed", args: { path: "src/a.ts" } },
    });
    const approvals: ApprovalRequest[] = [];
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"] }),
      streamFn: createFakeStreamFn({
        replies: [
          // 目录内：grant 免审
          {
            text: "改src",
            toolCalls: [{ name: "edit_file", args: editCall("src/a.ts", src, "alpha", "A") }],
          },
          // 目录外：弹人工（同一 Run 的第二次调用）
          {
            text: "改lib",
            toolCalls: [{ name: "edit_file", args: editCall("lib/b.ts", lib, "beta", "B") }],
          },
          { text: "完" },
        ],
      }),
      governance: createToolGovernance({
        registry: makeRegistry(),
        sessionGrants: store,
        workspaceRoot: root,
        approvalHandler: async (request) => {
          approvals.push(request);
          return { approved: true };
        },
      }),
      tools: [createEditFileTool(root)],
    });
    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.equal(result.toolExecutions.length, 2);
    assert.equal(result.toolExecutions[0]?.decision?.approvedBy, "human:grant");
    assert.equal(result.toolExecutions[1]?.decision?.approvedBy, "human");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.toolName, "edit_file");
    assert.deepEqual(approvals[0]?.args, editCall("lib/b.ts", lib, "beta", "B"));
    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("会话 grant 优先于配置规则：同一调用两处都命中时记 human:grant", async () => {
  const original = "alpha\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    appendGrantConfigRule(root, {
      tool: "edit_file",
      promotedFrom: {
        grantId: asGrantId("grant_01J5Z7K8W9ABCDEFGHJKMNPQRV"),
        sessionId: asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
        firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
        promotedAt: 1_757_000_000_000,
      },
    });
    const store = new SessionGrantStore({ workspaceRoot: root });
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "tc-seed", args: { path: "a.ts" } },
    });
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"] }),
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "改",
            toolCalls: [{ name: "edit_file", args: editCall("a.ts", original, "alpha", "BETA") }],
          },
          { text: "完成" },
        ],
      }),
      governance: createToolGovernance({
        registry: makeRegistry(),
        sessionGrants: store,
        configGrants: loadGrantConfig(root),
        workspaceRoot: root,
      }),
      tools: [createEditFileTool(root)],
    });
    const result = await adapter.run("改文件");
    assert.equal(result.toolExecutions[0]?.decision?.approvedBy, "human:grant");
    assert.deepEqual(result.toolExecutions[0]?.decision?.grantRef, {
      kind: "session-grant",
      id: grant.grantId,
    });
    await adapter.dispose();
  } finally {
    cleanup();
  }
});
