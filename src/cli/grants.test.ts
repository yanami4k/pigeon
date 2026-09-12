// M4 收口（决策 ①②）：/grants save 与 /revoke config#N 的账本留痕与身份稳定性——
// 升格先落 grant.promoted 事件再写配置（扩权先留证）；移除先改配置再落
// grant.config-removed 事件（缩权先生效）；重复升格响亮拒绝；配置规则的回指是
// promotedFrom.grantId，移除排在前面的规则后回指逐字不变。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { loadGrantConfig, matchConfigGrants, SessionGrantStore } from "../persistence/grants.ts";
import { asSessionId } from "../state/ids.ts";
import { type GrantsCommandContext, runGrantCommand } from "./grants.ts";

const SESSION = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPRCC");

function makeContext(): {
  root: string;
  sessionsDir: string;
  eventLog: JsonlEventLog;
  store: SessionGrantStore;
  outputs: string[];
  ctx: GrantsCommandContext;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-cmd-"));
  const sessionsDir = join(root, ".pigeon", "sessions");
  const eventLog = new JsonlEventLog(sessionsDir, SESSION);
  const store = new SessionGrantStore({ workspaceRoot: root, eventLog });
  const outputs: string[] = [];
  const ctx: GrantsCommandContext = {
    root,
    store,
    configRules: [],
    sessionId: SESSION,
    eventLog,
    write: (text) => outputs.push(text),
  };
  return {
    root,
    sessionsDir,
    eventLog,
    store,
    outputs,
    ctx,
    cleanup: () => {
      eventLog.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("/grants save：落 grant.promoted 事件（grantId = 规则的 promotedFrom.grantId），事件先于配置写入", () => {
  const { root, sessionsDir, store, ctx, cleanup } = makeContext();
  try {
    const grant = store.create({
      tool: "edit_file",
      pathPrefix: "src",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
    });
    assert.equal(runGrantCommand(["grants", "save", grant.grantId], ctx), true);

    const materialized = materializeSession(sessionsDir, SESSION);
    assert.equal(materialized.grantPromoteds.length, 1);
    const promoted = materialized.grantPromoteds[0];
    assert.ok(promoted !== undefined);
    assert.equal(promoted.grantId, grant.grantId);
    assert.equal(promoted.tool, "edit_file");
    assert.equal(promoted.pathPrefix, "src");
    assert.equal(promoted.runId, undefined, "REPL 时段升格无活动 Run");
    const rules = loadGrantConfig(root);
    assert.equal(rules[0]?.promotedFrom.grantId, promoted.grantId, "事件与配置同一稳定身份");
    assert.equal(rules[0]?.promotedFrom.promotedAt, promoted.promotedAt);
    // 文件顺序：grant.created → grant.promoted（升格是扩权动作，留证在先）
    assert.deepEqual(
      materialized.records.map((record) => record.kind),
      ["grant.created", "grant.promoted"]
    );
  } finally {
    cleanup();
  }
});

test("/grants save 重复升格：响亮报错指出已存在的 config#N，不落第二条事件、配置不变", () => {
  const { root, sessionsDir, store, ctx, cleanup } = makeContext();
  try {
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
    });
    runGrantCommand(["grants", "save", grant.grantId], ctx);
    assert.throws(
      () => runGrantCommand(["grants", "save", grant.grantId], ctx),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("config#0"), error.message);
        assert.ok(error.message.includes("已升格"), error.message);
        return true;
      }
    );
    assert.equal(loadGrantConfig(root).length, 1);
    assert.equal(materializeSession(sessionsDir, SESSION).grantPromoteds.length, 1);
  } finally {
    cleanup();
  }
});

test("/revoke config#N：先移除配置再落 grant.config-removed 事件（含被移除规则的 grantId 与当时序号）", () => {
  const { root, sessionsDir, store, ctx, cleanup } = makeContext();
  try {
    const first = store.create({
      tool: "edit_file",
      pathPrefix: "src",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
    });
    const second = store.create({
      tool: "read_file",
      firstCall: { toolCallId: "toolu_01DEF", args: { path: "b.ts" } },
    });
    runGrantCommand(["grants", "save", first.grantId], ctx);
    runGrantCommand(["grants", "save", second.grantId], ctx);

    // 移除前：第二条规则回指 second.grantId
    const before = matchConfigGrants(loadGrantConfig(root), root, "read_file", {});
    assert.equal(before?.refId, second.grantId);

    assert.equal(runGrantCommand(["revoke", "config#0"], ctx), true);
    const materialized = materializeSession(sessionsDir, SESSION);
    assert.equal(materialized.grantConfigRemoveds.length, 1);
    const removed = materialized.grantConfigRemoveds[0];
    assert.ok(removed !== undefined);
    assert.equal(removed.grantId, first.grantId, "留痕回指被移除规则的稳定身份");
    assert.equal(removed.tool, "edit_file");
    assert.equal(removed.pathPrefix, "src");
    assert.equal(removed.index, 0, "移除时刻的展示序号仅供人读对照");

    // 移除后：原第二条前移为 config#0，但回指逐字不变（P2-1 根因修复）
    const rules = loadGrantConfig(root);
    assert.equal(rules.length, 1);
    const after = matchConfigGrants(rules, root, "read_file", {});
    assert.equal(after?.refId, second.grantId, "位置序号前移，身份不变");
    // 事件序列：两条 created、两条 promoted、一条 config-removed
    assert.deepEqual(
      materialized.records.map((record) => record.kind),
      ["grant.created", "grant.created", "grant.promoted", "grant.promoted", "grant.config-removed"]
    );
  } finally {
    cleanup();
  }
});

test("/revoke config#N 越界：响亮报错且不落事件", () => {
  const { sessionsDir, ctx, cleanup } = makeContext();
  try {
    assert.throws(() => runGrantCommand(["revoke", "config#3"], ctx), /固化规则不存在/);
    assert.equal(materializeSession(sessionsDir, SESSION).grantConfigRemoveds.length, 0);
  } finally {
    cleanup();
  }
});

// 留痕顺序的不对称性（决策 ①）：扩权先留证——留证抛错则配置不写；缩权先生效——留证抛错
// 时规则已移除、错误照样上抛（少一条痕迹好过"账本说撤了、规则还活着"）
test("留痕顺序：升格留证失败 → 配置不写（扩权先留证）；移除留证失败 → 规则已移除且错误上抛（缩权先生效）", () => {
  const { root, store, cleanup } = makeContext();
  try {
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
    });
    const poison = {
      appendGrantPromoted: () => {
        throw new Error("模拟磁盘写失败：grant.promoted 未落盘");
      },
      appendGrantConfigRemoved: () => {
        throw new Error("模拟磁盘写失败：grant.config-removed 未落盘");
      },
    };
    const ctx: GrantsCommandContext = {
      root,
      store,
      configRules: [],
      sessionId: SESSION,
      eventLog: poison,
      write: () => {},
    };
    assert.throws(
      () => runGrantCommand(["grants", "save", grant.grantId], ctx),
      /grant\.promoted 未落盘/
    );
    assert.equal(loadGrantConfig(root).length, 0, "留证失败则不扩权：grants.json 不得出现该规则");

    // 用可用的落盘面先把规则升格上去，再用毒化落盘面移除
    const { eventLog: _poison, ...plainCtx } = ctx;
    runGrantCommand(["grants", "save", grant.grantId], plainCtx);
    assert.equal(loadGrantConfig(root).length, 1);
    assert.throws(() => runGrantCommand(["revoke", "config#0"], ctx), /config-removed 未落盘/);
    assert.equal(loadGrantConfig(root).length, 0, "缩权先生效：留证失败规则也已移除");
  } finally {
    cleanup();
  }
});
