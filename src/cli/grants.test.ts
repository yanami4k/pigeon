// M4 收口（决策 ①②）：/grants save 与 /revoke config#N 的配置写入与身份稳定性——
// 升格与移除只操作放权配置文件（决策 128 退役了两种留痕）；重复升格响亮拒绝；
// 配置规则的回指是 promotedFrom.grantId，移除排在前面的规则后回指逐字不变。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { type GrantsCommandContext, runGrantCommand } from "../application/grants.ts";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { loadGrantConfig } from "../persistence/grants-config.ts";
import { asSessionId } from "../state/ids.ts";
import { matchConfigGrants } from "../tools/grants.ts";

const SESSION = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPRCC");

function makeContext(): {
  root: string;
  store: SessionGrantStore;
  outputs: string[];
  ctx: GrantsCommandContext;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-cmd-"));
  // 这些用例只看配置文件，授权建立与撤销不落盘（纯内存）
  const store = new SessionGrantStore({ workspaceRoot: root });
  const outputs: string[] = [];
  const ctx: GrantsCommandContext = {
    root,
    store,
    configRules: [],
    sessionId: SESSION,
    write: (text) => outputs.push(text),
  };
  return {
    root,
    store,
    outputs,
    ctx,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("/grants save：写入配置规则，出处结构化记下会话、grant 与首调（promotedFrom.grantId 为稳定身份）", () => {
  const { root, store, outputs, ctx, cleanup } = makeContext();
  try {
    const grant = store.create({
      tool: "edit_file",
      pathPrefix: "src",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
    });
    assert.equal(runGrantCommand(["grants", "save", grant.grantId], ctx), true);

    const rules = loadGrantConfig(root);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.tool, "edit_file");
    assert.equal(rules[0]?.pathPrefix, "src");
    assert.equal(rules[0]?.promotedFrom.grantId, grant.grantId);
    assert.equal(rules[0]?.promotedFrom.sessionId, SESSION);
    assert.equal(rules[0]?.promotedFrom.firstCall.toolCallId, "toolu_01ABC");
    assert.ok(outputs.join("").includes(`已升格 ${grant.grantId}`));
  } finally {
    cleanup();
  }
});

test("/grants save 重复升格：响亮报错指出已存在的 config#N，配置不变", () => {
  const { root, store, ctx, cleanup } = makeContext();
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
  } finally {
    cleanup();
  }
});

test("/revoke config#N：移除配置规则并报告其出处 grant；其余规则回指不变", () => {
  const { root, store, outputs, ctx, cleanup } = makeContext();
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
    assert.ok(
      outputs.join("").includes("已移除固化规则 config#0（edit_file，出处 grant"),
      outputs.join("")
    );

    // 移除后：原第二条前移为 config#0，但回指逐字不变（P2-1 根因修复）
    const rules = loadGrantConfig(root);
    assert.equal(rules.length, 1);
    const after = matchConfigGrants(rules, root, "read_file", {});
    assert.equal(after?.refId, second.grantId, "位置序号前移，身份不变");
    assert.equal(rules[0]?.promotedFrom.grantId, second.grantId);
  } finally {
    cleanup();
  }
});

test("/revoke config#N 越界：响亮报错", () => {
  const { ctx, cleanup } = makeContext();
  try {
    assert.throws(() => runGrantCommand(["revoke", "config#3"], ctx), /固化规则不存在/);
  } finally {
    cleanup();
  }
});
