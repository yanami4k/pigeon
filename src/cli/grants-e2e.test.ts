// M4 S6 端到端验收：grant 生命周期走人机的真实 CLI 链路（fake streamFn 驱动真实
// pi-agent-core Agent；stdin 剧本走真实 createAsker/runRepl；命令走真实 runGrantCommand）。
// 测试一（会话生命周期）：审批 [a] 建 grant → 第二次调用免审（approvedBy=human:grant）→
//   /grants 列出 → /revoke 立即停免审（重新弹人工，拒绝理由逐字落盘）。
// 测试二（升格 + 冷恢复）：/grants save 写 .pigeon/grants.json（promotedFrom 出处）→
//   模拟新进程：事件日志种子还原会话 grant（决策 3b 静默续命）→ 撤销后配置规则命中
//   （approvedBy=policy:config）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { Type } from "typebox";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { type ConfigGrantRule, loadGrantConfig, SessionGrantStore } from "../persistence/grants.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import { asSessionId, type SessionId } from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createCliApprovalHandler } from "./approval-ui.ts";
import { type GrantsCommandContext, runGrantCommand } from "./grants.ts";
import { type AskFn, createAsker, runRepl } from "./repl.ts";

const SESSION_A = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPRAA");
const SESSION_B = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPRBB");

function editCall(content: string, oldLine: string, newLine: string): EditFileParams {
  return {
    path: "a.ts",
    snapshot: snapshotTag(content),
    edits: [{ op: "replace", anchor: `1#${lineTag(oldLine)}`, lines: [newLine] }],
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

interface TestAdapter {
  adapter: PiRuntimeAdapter;
  ask: AskFn;
  close: () => void;
}

function makeAdapter(
  input: Readable,
  outputs: string[],
  root: string,
  replies: unknown[],
  store: SessionGrantStore,
  configRules: readonly ConfigGrantRule[],
  sessionId: SessionId,
  eventLog: JsonlEventLog
): TestAdapter {
  const write = (text: string): void => {
    outputs.push(text);
  };
  const { ask, close } = createAsker(input, write);
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
    streamFn: createFakeStreamFn({ replies: replies as never }),
    registry: makeRegistry(),
    tools: [createReadFileTool(root), createEditFileTool(root)],
    approvalHandler: createCliApprovalHandler(ask, write, { grants: store }),
    sessionId,
    eventLog,
    sessionGrants: store,
    configGrants: configRules,
    workspaceRoot: root,
  });
  return { adapter, ask, close };
}

test("端到端（会话生命周期）：[a] 建 grant → human:grant 免审 → /grants → /revoke 立即停免审", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-e2e-a-"));
  writeFileSync(join(root, "a.ts"), "alpha\n");
  const eventLog = new JsonlEventLog(join(root, ".pigeon", "sessions"), SESSION_A);
  try {
    const store = new SessionGrantStore({ workspaceRoot: root, eventLog });
    const commands: GrantsCommandContext = {
      root,
      store,
      configRules: [],
      sessionId: SESSION_A,
      write: () => {},
    };

    // REPL #1：任务一审批 [a] 建 grant；任务二免审；/grants 列出
    const outputs1: string[] = [];
    const input1 = Readable.from(["任务一\n", "a\n", "任务二\n", "/grants\n", ":quit\n"], {
      objectMode: false,
    });
    const r1 = makeAdapter(
      input1,
      outputs1,
      root,
      [
        {
          text: "改1",
          toolCalls: [{ name: "edit_file", args: editCall("alpha\n", "alpha", "STEP1") }],
        },
        { text: "好" },
        {
          text: "改2",
          toolCalls: [{ name: "edit_file", args: editCall("STEP1\n", "STEP1", "STEP2") }],
        },
        { text: "完成" },
      ],
      store,
      [],
      SESSION_A,
      eventLog
    );
    await runRepl({
      adapter: r1.adapter,
      ask: r1.ask,
      write: (t) => outputs1.push(t),
      grants: { ...commands, write: (t) => outputs1.push(t) },
    });
    r1.close();
    await r1.adapter.dispose();

    const terminal1 = outputs1.join("");
    assert.ok(terminal1.includes("已创建会话放权"), terminal1);
    assert.ok(terminal1.includes("[a] 本会话允许"), `四键提示在场\n${terminal1}`);
    assert.ok(terminal1.includes("（human:grant）"), `第二次调用免记 human:grant\n${terminal1}`);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "STEP2\n");
    const grant = store.list()[0];
    assert.ok(grant);
    assert.ok(terminal1.includes(grant.grantId), "/grants 列出 grant id");
    assert.ok(terminal1.includes("命中 1 次"), terminal1);

    // /revoke：立即停免审——下一任务重新弹人工（剧本给 n + 逐字理由）
    const outputs2: string[] = [];
    assert.equal(
      runGrantCommand(["revoke", grant.grantId], { ...commands, write: (t) => outputs2.push(t) }),
      true
    );
    assert.ok(outputs2.join("").includes("已撤销"));
    assert.equal(store.list().length, 0);

    const input2 = Readable.from(["任务三\n", "n\n", "先别动这个文件\n", ":quit\n"], {
      objectMode: false,
    });
    const r2 = makeAdapter(
      input2,
      outputs2,
      root,
      [
        {
          text: "改3",
          toolCalls: [{ name: "edit_file", args: editCall("STEP2\n", "STEP2", "STEP3") }],
        },
        { text: "被拒绝了" },
      ],
      store,
      [],
      SESSION_A,
      eventLog
    );
    await runRepl({
      adapter: r2.adapter,
      ask: r2.ask,
      write: (t) => outputs2.push(t),
      grants: { ...commands, write: (t) => outputs2.push(t) },
    });
    r2.close();
    await r2.adapter.dispose();
    const terminal2 = outputs2.join("");
    assert.ok(
      terminal2.includes("（human）"),
      `撤销后重新弹人工，批准来源回到 human\n${terminal2}`
    );
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "STEP2\n", "拒绝后副作用未发生");
  } finally {
    eventLog.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("端到端（升格 + 冷恢复）：/grants save 写配置 → 新进程会话 grant 静默续命 → 撤销后 policy:config", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-e2e-b-"));
  writeFileSync(join(root, "a.ts"), "alpha\n");
  const sessionsDir = join(root, ".pigeon", "sessions");
  const eventLog = new JsonlEventLog(sessionsDir, SESSION_B);
  try {
    const store = new SessionGrantStore({ workspaceRoot: root, eventLog });

    // REPL #1：审批 [a] 建 grant；第二次调用免审
    const outputs1: string[] = [];
    const input1 = Readable.from(["任务一\n", "a\n", "任务二\n", ":quit\n"], { objectMode: false });
    const r1 = makeAdapter(
      input1,
      outputs1,
      root,
      [
        {
          text: "改1",
          toolCalls: [{ name: "edit_file", args: editCall("alpha\n", "alpha", "STEP1") }],
        },
        { text: "好" },
        {
          text: "改2",
          toolCalls: [{ name: "edit_file", args: editCall("STEP1\n", "STEP1", "STEP2") }],
        },
        { text: "完成" },
      ],
      store,
      [],
      SESSION_B,
      eventLog
    );
    await runRepl({
      adapter: r1.adapter,
      ask: r1.ask,
      write: (t) => outputs1.push(t),
      grants: {
        root,
        store,
        configRules: [],
        sessionId: SESSION_B,
        write: (t) => outputs1.push(t),
      },
    });
    r1.close();
    await r1.adapter.dispose();
    assert.ok(outputs1.join("").includes("（human:grant）"), "第二次调用免记 human:grant");
    const grant = store.list()[0];
    assert.ok(grant);

    // /grants save：升格写 .pigeon/grants.json（promotedFrom 出处）
    const outputs2: string[] = [];
    const commands: GrantsCommandContext = {
      root,
      store,
      configRules: [],
      sessionId: SESSION_B,
      write: (t) => outputs2.push(t),
    };
    assert.equal(runGrantCommand(["grants", "save", grant.grantId], commands), true);
    const configRules = loadGrantConfig(root);
    assert.equal(configRules.length, 1);
    assert.equal(configRules[0]?.tool, "edit_file");
    assert.equal(configRules[0]?.promotedFrom.grantId, grant.grantId);
    assert.equal(configRules[0]?.promotedFrom.sessionId, SESSION_B);

    // 模拟新进程：事件日志种子还原生效 grant（决策 3b：静默续命，无重复确认）
    const restoredGrants = materializeSession(sessionsDir, SESSION_B).grants;
    assert.equal(restoredGrants.length, 1, "升格前的会话 grant 在冷恢复生效集内");
    const freshStore = new SessionGrantStore({ workspaceRoot: root, restored: restoredGrants });
    const outputs3: string[] = [];
    const input3 = Readable.from(["任务三\n", ":quit\n"], { objectMode: false });
    const r3 = makeAdapter(
      input3,
      outputs3,
      root,
      [
        {
          text: "改3",
          toolCalls: [{ name: "edit_file", args: editCall("STEP2\n", "STEP2", "STEP3") }],
        },
        { text: "完成" },
      ],
      freshStore,
      loadGrantConfig(root),
      SESSION_B,
      eventLog
    );
    await runRepl({
      adapter: r3.adapter,
      ask: r3.ask,
      write: (t) => outputs3.push(t),
      grants: {
        root,
        store: freshStore,
        configRules: loadGrantConfig(root),
        sessionId: SESSION_B,
        write: (t) => outputs3.push(t),
      },
    });
    r3.close();
    await r3.adapter.dispose();
    assert.ok(
      outputs3.join("").includes("（human:grant）"),
      "冷恢复后会话 grant 继续免记 human:grant"
    );

    // 撤销会话 grant（在续命的 freshStore 上撤）：配置规则接管，命中记 policy:config
    const outputs4: string[] = [];
    assert.equal(
      runGrantCommand(["revoke", grant.grantId], {
        root,
        store: freshStore,
        configRules: [],
        sessionId: SESSION_B,
        write: (t) => outputs4.push(t),
      }),
      true
    );
    assert.equal(freshStore.list().length, 0);
    const input4 = Readable.from(["任务四\n", ":quit\n"], { objectMode: false });
    const r4 = makeAdapter(
      input4,
      outputs4,
      root,
      [
        {
          text: "改4",
          toolCalls: [{ name: "edit_file", args: editCall("STEP3\n", "STEP3", "STEP4") }],
        },
        { text: "完成" },
      ],
      freshStore,
      loadGrantConfig(root),
      SESSION_B,
      eventLog
    );
    await runRepl({
      adapter: r4.adapter,
      ask: r4.ask,
      write: (t) => outputs4.push(t),
      grants: {
        root,
        store: freshStore,
        configRules: loadGrantConfig(root),
        sessionId: SESSION_B,
        write: (t) => outputs4.push(t),
      },
    });
    r4.close();
    await r4.adapter.dispose();
    assert.ok(outputs4.join("").includes("（policy:config）"), "固化规则命中记 policy:config");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "STEP4\n");
    // M4 收口决策 ①：配置命中的账本回指 = 规则的 promotedFrom.grantId（稳定身份，不是位置序号）
    const configIntent = materializeSession(sessionsDir, SESSION_B).intents.find(
      (intent) => intent.decision.approvedBy === "policy:config"
    );
    assert.deepEqual(configIntent?.decision.grantRef, { kind: "config-rule", id: grant.grantId });
  } finally {
    eventLog.close();
    rmSync(root, { recursive: true, force: true });
  }
});
