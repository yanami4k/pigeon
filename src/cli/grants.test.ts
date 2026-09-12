// M4 S6（决策 3 + D6）：/grants、/revoke、/grants save 命令测试。
// 升格写 .pigeon/grants.json 带 promotedFrom 出处；撤销会话 grant 立即生效并留 grant.revoked；
// 配置规则撤销从文件移除（求值面会话内冻结，如实标注）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import {
  appendGrantConfigRule,
  grantsConfigPath,
  loadGrantConfig,
  SessionGrantStore,
} from "../persistence/grants.ts";
import { asGrantId, asSessionId, newSessionId } from "../state/ids.ts";
import { type GrantsCommandContext, runGrantCommand } from "./grants.ts";

function makeContext(
  root: string,
  sessionId = newSessionId()
): {
  ctx: GrantsCommandContext;
  outputs: string[];
  store: SessionGrantStore;
  close: () => void;
} {
  const outputs: string[] = [];
  const eventLog = new JsonlEventLog(join(root, "sessions"), sessionId);
  const store = new SessionGrantStore({ workspaceRoot: root, eventLog });
  return {
    ctx: {
      root,
      store,
      configRules: loadGrantConfig(root),
      sessionId,
      write: (text) => outputs.push(text),
    },
    outputs,
    store,
    close: () => eventLog.close(),
  };
}

test("/grants 列表：会话 grant（createdAt/命中/作用域/首调）与固化规则（出处）俱全", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-cmd-"));
  const sessionId = newSessionId();
  try {
    // 先落固化规则再建上下文：configRules 在上下文创建时载入（同会话启动的冻结语义）
    appendGrantConfigRule(root, {
      tool: "read_file",
      promotedFrom: {
        grantId: asGrantId("grant_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
        sessionId,
        firstCall: { toolCallId: "toolu_01DEF", args: { path: "b.ts" } },
        promotedAt: 1_757_000_000_000,
      },
    });
    const { ctx, outputs, store, close } = makeContext(root, sessionId);
    store.create({
      tool: "edit_file",
      pathPrefix: "src",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
    });
    store.noteEffectiveHit({ source: "session-grant", refId: store.list()[0]?.grantId ?? "" });

    assert.equal(runGrantCommand(["grants"], ctx), true);
    const text = outputs.join("");
    assert.ok(text.includes("会话放权（1）"), text);
    assert.ok(text.includes("edit_file"), text);
    assert.ok(text.includes("仅限目录 src"), text);
    assert.ok(text.includes("命中 1 次"), text);
    assert.ok(text.includes("toolu_01ABC"), text);
    assert.ok(text.includes("固化规则（1"), text);
    assert.ok(text.includes("config#0"), text);
    assert.ok(text.includes("工具级（不限目录）"), text);
    assert.ok(text.includes("升格 2025-"), text);
    assert.ok(text.includes("出处 会话"), text);
    close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/grants 空列表如实说明；非 grant 命令返回 false（REPL 继续其他分发）", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-cmd-"));
  try {
    const { ctx, outputs, close } = makeContext(root);
    assert.equal(runGrantCommand(["grants"], ctx), true);
    assert.ok(outputs.join("").includes("无"), "空列表有说明");
    assert.equal(runGrantCommand(["unknown"], ctx), false);
    close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/grants save <id>：升格写 .pigeon/grants.json，promotedFrom 出处逐字在场", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-cmd-"));
  const sessionId = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPRSW");
  try {
    const { ctx, outputs, store, close } = makeContext(root, sessionId);
    const grant = store.create({
      tool: "edit_file",
      pathPrefix: "src",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
    });
    assert.equal(runGrantCommand(["grants", "save", grant.grantId], ctx), true);
    assert.ok(outputs.join("").includes("已升格"), outputs.join(""));

    const rules = loadGrantConfig(root);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.tool, "edit_file");
    assert.equal(rules[0]?.pathPrefix, "src");
    const promotedFrom = rules[0]?.promotedFrom;
    assert.ok(promotedFrom);
    assert.equal(promotedFrom.grantId, grant.grantId);
    assert.equal(promotedFrom.sessionId, sessionId);
    assert.deepEqual(promotedFrom.firstCall, {
      toolCallId: "toolu_01ABC",
      args: { path: "src/a.ts" },
    });
    assert.ok(promotedFrom.promotedAt > 0);
    // 文件人可读 + version 字段在场
    const onDisk = JSON.parse(readFileSync(grantsConfigPath(root), "utf8")) as { version: number };
    assert.equal(onDisk.version, 1);

    // 未知 id / 坏形态响亮报错
    assert.throws(() =>
      runGrantCommand(["grants", "save", "grant_01J5Z7K8W9ABCDEFGHJKMNPQRX"], ctx)
    );
    assert.throws(() => runGrantCommand(["grants", "save", "config#0"], ctx));
    assert.throws(() => runGrantCommand(["grants", "save"], ctx), /用法/);
    close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/revoke <grantId>：立即停免审并写 grant.revoked 事件（崩溃后仍撤销）", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-cmd-"));
  const sessionId = newSessionId();
  try {
    const { ctx, outputs, store, close } = makeContext(root, sessionId);
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
    });
    assert.equal(runGrantCommand(["revoke", grant.grantId], ctx), true);
    assert.equal(store.list().length, 0);
    assert.ok(outputs.join("").includes("已撤销"), outputs.join(""));

    // 持久痕迹：冷物化后该 grant 不在生效集（created − revoked）
    const materialized = materializeSession(join(root, "sessions"), sessionId);
    assert.equal(materialized.grants.length, 0);
    assert.equal(materialized.grantRevokeds.length, 1);

    assert.throws(() => runGrantCommand(["revoke", grant.grantId], ctx), /不存在/);
    close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/revoke config#N：从 grants.json 移除并标注会话内冻结", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-cmd-"));
  const sessionId = newSessionId();
  try {
    appendGrantConfigRule(root, {
      tool: "edit_file",
      promotedFrom: {
        grantId: asGrantId("grant_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
        sessionId,
        firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
        promotedAt: 1_757_000_000_000,
      },
    });
    writeFileSync(join(root, ".pigeon", "grants.json.bak"), "sentinel");
    const { ctx, outputs, close } = makeContext(root, sessionId);
    assert.equal(runGrantCommand(["revoke", "config#0"], ctx), true);
    assert.equal(loadGrantConfig(root).length, 0);
    const text = outputs.join("");
    assert.ok(text.includes("已移除"), text);
    assert.ok(text.includes("冻结"), text);
    assert.throws(() => runGrantCommand(["revoke", "config#7"], ctx), /不存在/);
    close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
