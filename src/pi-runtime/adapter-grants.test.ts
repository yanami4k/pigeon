// M4 S6：Grant 体系治理接线测试——fake streamFn 驱动真实 pi-agent-core Agent，
// 验证排律（deny → 会话 grant → 配置 grant → yolo → read 自动 → prompt）、approvedBy
// 扩展（human:grant / policy:config + grantRef 回指）、撤销立即生效、崩溃恢复还原、
// 熔断独立性与读层事件级裁剪（决策 1）八条不变式。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import {
  appendGrantConfigRule,
  loadGrantConfig,
  SessionGrantStore,
} from "../persistence/grants.ts";
import { asGrantId, asSessionId } from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn } from "./fixtures.ts";
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
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionGrants: store,
      workspaceRoot: root,
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

test("不变式②grant 命中：approvedBy=human:grant，intent 携带 grantRef 回指 grantId", async () => {
  const original = "alpha\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original, "sessions/.keep": "" });
  const sessionsDir = join(root, "sessions");
  const sessionId = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPQRV");
  try {
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    const store = new SessionGrantStore({ workspaceRoot: root, eventLog });
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
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionGrants: store,
      workspaceRoot: root,
      eventLog,
      sessionId,
    });
    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "BETA\n");
    const record = result.toolExecutions[0];
    assert.equal(record?.decision?.approvedBy, "human:grant");
    assert.deepEqual(record?.decision?.grantRef, { kind: "session-grant", id: grant.grantId });
    await adapter.dispose();
    eventLog.close();

    // intent 落盘同载 grantRef（账本回指出处，决策 3）
    const lines = readFileSync(eventLog.path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, never>);
    const intent = lines.find((line) => line.kind === "intent") as unknown as {
      decision: { approvedBy: string; grantRef: { kind: string; id: string } };
    };
    assert.equal(intent.decision.approvedBy, "human:grant");
    assert.deepEqual(intent.decision.grantRef, { kind: "session-grant", id: grant.grantId });
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
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionGrants: store,
      workspaceRoot: root,
      approvalHandler: async (request) => {
        approvals.push(request);
        return { approved: true };
      },
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
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      configGrants,
      workspaceRoot: root,
      approvalHandler: async (request) => {
        approvals.push(request);
        return { approved: true };
      },
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

test("不变式⑤崩溃恢复：grant.created 落盘 → 冷物化还原 → 新会话静默继续免审（决策 3b）", async () => {
  const original = "alpha\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original, "sessions/.keep": "" });
  const sessionsDir = join(root, "sessions");
  const sessionId = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPRSV");
  try {
    // 第一进程：人工批准后创建 grant（模拟 [a] 键），事件落盘
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    const store = new SessionGrantStore({ workspaceRoot: root, eventLog });
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
    });
    eventLog.close();

    // 崩溃 + 冷重启：从事件文件物化 grant（静默恢复，无确认环节），注入新存储
    const materialized = materializeSession(sessionsDir, sessionId);
    assert.equal(materialized.grants.length, 1);
    assert.equal(materialized.grants[0]?.grantId, grant.grantId);

    const restored = new SessionGrantStore({
      workspaceRoot: root,
      eventLog: new JsonlEventLog(sessionsDir, sessionId),
      restored: materialized.grants,
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
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionGrants: restored,
      workspaceRoot: root,
      approvalHandler: async (request) => {
        approvals.push(request);
        return { approved: true };
      },
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
  } finally {
    cleanup();
  }
});

test("不变式⑥ malformed grants.json 响亮失败（治理配置 fail-closed，不静默忽略）", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(join(root, ".pigeon", "grants.json"), "{ 坏", "utf8");
    assert.throws(() => loadGrantConfig(root), /不是合法 JSON/);
  } finally {
    cleanup();
  }
});

test("不变式⑦熔断独立于授权：grant 生效期间幽灵工具名连击照样落闸 abort", async () => {
  const original = "alpha\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    store.create({ tool: "edit_file", firstCall: { toolCallId: "tc-seed", args: {} } });
    const phantomReplies = Array.from({ length: 4 }, () => ({
      text: "",
      toolCalls: [{ name: "delete_everything", args: {} }],
    }));
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["edit_file"] }),
      streamFn: createFakeStreamFn({ replies: [...phantomReplies, { text: "放弃" }] }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionGrants: store,
      workspaceRoot: root,
    });
    const result = await adapter.run("胡闹");
    // 事件级熔断（上游拦截连击）与 grant 授权无关——照样落闸
    assert.equal(result.status, "aborted");
    assert.equal(result.failure?.category, "cancelled");
    assert.equal(result.failure?.breaker, true);
    const breaker = adapter.events().find((event) => event.kind === "run.ended");
    assert.ok(breaker);
    await adapter.dispose();
  } finally {
    cleanup();
  }
});

test("不变式⑧读层事件级裁剪（决策 1）：read_file 调用零 intent / receipt 治理行，内存账本仍完整", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "one\ntwo\n", "sessions/.keep": "" });
  const sessionsDir = join(root, "sessions");
  const sessionId = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPRTV");
  try {
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot({ allow: ["read_file", "edit_file"] }),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
          { text: "完" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createReadFileTool(root)],
      eventLog,
      sessionId,
    });
    const result = await adapter.run("读文件");
    assert.equal(result.status, "completed");
    // 内存账本不受裁剪影响（RunResult 照常报告）
    assert.equal(result.toolExecutions.length, 1);
    assert.equal(result.toolExecutions[0]?.toolName, "read_file");
    assert.equal(result.toolExecutions[0]?.decision?.approvedBy, "policy:auto");
    await adapter.dispose();
    eventLog.close();

    const lines = readFileSync(eventLog.path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    assert.ok(lines.includes("tool.proposed"));
    assert.ok(lines.includes("tool.settled"));
    assert.ok(!lines.includes("intent"), "读调用不得落 intent");
    assert.ok(!lines.includes("receipt"), "读调用不得落 receipt");

    // 冷物化对账零悬账：没有 intent 就没有 OutcomeUnknown（决策 1：对账对读层无意义）
    const materialized = materializeSession(sessionsDir, sessionId);
    assert.equal(materialized.intents.length, 0);
    assert.equal(materialized.receipts.length, 0);
    assert.equal(materialized.reconcile.unknown.length, 0);
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
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionGrants: store,
      workspaceRoot: root,
      approvalHandler: async (request) => {
        approvals.push(request);
        return { approved: true };
      },
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
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionGrants: store,
      configGrants: loadGrantConfig(root),
      workspaceRoot: root,
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
