// Grant 体系（M4 S6，决策 3 + D6）：会话 grant 存储、固化配置（.pigeon/grants.json）
// 与确定性匹配。排律由 adapter 求值顺序承载（deny 清单 → 会话 grant → 配置 grant →
// yolo → read 自动 → prompt）；本模块只负责匹配语义与持久化：
//   - 匹配确定性（约束 5）：工具名 + 可选 pathPrefix 目录包含（paths.ts realpath 机制），
//     无自由文本模式；非路径参数或解析失败 → 不匹配，回落人工审批
//   - 固化写入方唯一（约束 3）：appendGrantConfigRule 只被 /grants save（人显式触发）调用
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newGrantId, newSessionId } from "../state/ids.ts";
import type { ActiveGrant } from "./event-log.ts";
import {
  appendGrantConfigRule,
  GrantsConfigError,
  grantsConfigPath,
  loadGrantConfig,
  matchConfigGrants,
  SessionGrantStore,
} from "./grants.ts";

function makeWorkspace(files: Record<string, string> = {}): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ---- 固化配置（D6） ----

test("grants 配置：文件缺失 = 无规则（合法全新项目）", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    assert.deepEqual(loadGrantConfig(root), []);
  } finally {
    cleanup();
  }
});

test("grants 配置：合法文件载入规则（含 promotedFrom 出处）", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(
      grantsConfigPath(root),
      JSON.stringify({
        version: 1,
        grants: [
          {
            tool: "edit_file",
            pathPrefix: "src",
            promotedFrom: {
              grantId: "grant_01J5Z7K8W9ABCDEFGHJKMNPQRS",
              sessionId: "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS",
              firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
              promotedAt: 1_757_000_000_000,
            },
          },
          {
            tool: "read_file",
            promotedFrom: {
              grantId: "grant_01J5Z7K8W9ABCDEFGHJKMNPQRT",
              sessionId: "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS",
              firstCall: { toolCallId: "toolu_01DEF", args: { path: "b.ts" } },
              promotedAt: 1_757_000_000_001,
            },
          },
        ],
      }),
      "utf8"
    );
    const rules = loadGrantConfig(root);
    assert.equal(rules.length, 2);
    assert.equal(rules[0]?.tool, "edit_file");
    assert.equal(rules[0]?.pathPrefix, "src");
    assert.equal(rules[0]?.promotedFrom.grantId, "grant_01J5Z7K8W9ABCDEFGHJKMNPQRS");
    assert.equal(rules[1]?.pathPrefix, undefined);
  } finally {
    cleanup();
  }
});

test("grants 配置：畸形文件响亮失败（JSON 语法错 / schema 违反都列问题），fail-closed", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(grantsConfigPath(root), "{ 这不是 JSON", "utf8");
    assert.throws(
      () => loadGrantConfig(root),
      (error: unknown) => {
        assert.ok(error instanceof GrantsConfigError);
        assert.ok(error.message.includes("不是合法 JSON"), error.message);
        assert.ok(error.message.includes("grants.json"), error.message);
        return true;
      }
    );

    writeFileSync(
      grantsConfigPath(root),
      JSON.stringify({ version: 1, grants: [{ tool: "edit_file" }] }),
      "utf8"
    );
    assert.throws(
      () => loadGrantConfig(root),
      (error: unknown) => {
        assert.ok(error instanceof GrantsConfigError);
        assert.ok(error.message.includes("校验失败"), error.message);
        assert.ok(error.message.includes("promotedFrom"), error.message);
        return true;
      }
    );

    writeFileSync(grantsConfigPath(root), JSON.stringify({ version: 2, grants: [] }), "utf8");
    assert.throws(() => loadGrantConfig(root), GrantsConfigError);
  } finally {
    cleanup();
  }
});

test("升格写入：appendGrantConfigRule 新建/追加 .pigeon/grants.json，出处字段逐字保留", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const rule = {
      tool: "edit_file",
      pathPrefix: "src",
      promotedFrom: {
        grantId: newGrantId(),
        sessionId: newSessionId(),
        firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
        promotedAt: 1_757_000_000_000,
      },
    };
    appendGrantConfigRule(root, rule);
    const { pathPrefix: _omit, ...toolOnly } = rule;
    appendGrantConfigRule(root, { ...toolOnly, tool: "read_file" });
    const rules = loadGrantConfig(root);
    assert.equal(rules.length, 2);
    assert.deepEqual(rules[0], rule);
    assert.equal(rules[1]?.tool, "read_file");
    // 文件可读（人可读配置，D6）且含 version 字段（M0 迁移管线路由依据）
    const onDisk = JSON.parse(readFileSync(grantsConfigPath(root), "utf8")) as {
      version: number;
      grants: unknown[];
    };
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.grants.length, 2);
  } finally {
    cleanup();
  }
});

// ---- 配置规则匹配 ----

test("配置规则匹配：命中回指 config:grants.json#<序号>；目录限定外/非路径参数不命中", () => {
  const { root, cleanup } = makeWorkspace({ "src/a.ts": "a", "lib/b.ts": "b" });
  try {
    const rules = [
      {
        tool: "edit_file",
        pathPrefix: "src",
        promotedFrom: {
          grantId: newGrantId(),
          sessionId: newSessionId(),
          firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
          promotedAt: 1,
        },
      },
      {
        tool: "read_file",
        promotedFrom: {
          grantId: newGrantId(),
          sessionId: newSessionId(),
          firstCall: { toolCallId: "toolu_01DEF", args: { path: "b.ts" } },
          promotedAt: 2,
        },
      },
    ];
    assert.deepEqual(matchConfigGrants(rules, root, "edit_file", { path: "src/a.ts" }), {
      source: "config-rule",
      refId: "config:grants.json#0",
    });
    assert.equal(matchConfigGrants(rules, root, "edit_file", { path: "lib/b.ts" }), null);
    assert.equal(matchConfigGrants(rules, root, "edit_file", { nope: 1 }), null);
    assert.equal(matchConfigGrants(rules, root, "other_tool", { path: "src/a.ts" }), null);
    // 工具级规则（无 pathPrefix）不依赖路径解析，无路径参数也命中
    assert.deepEqual(matchConfigGrants(rules, root, "read_file", {}), {
      source: "config-rule",
      refId: "config:grants.json#1",
    });
    // 目录限定规则在无工作区根可解析时不得匹配（fail-closed 到人工）
    assert.equal(matchConfigGrants(rules, undefined, "edit_file", { path: "src/a.ts" }), null);
  } finally {
    cleanup();
  }
});

// ---- 会话 grant 存储 ----

test("会话 grant：创建写 grant.created 事件；工具级与目录限定匹配；命中计数只在放行生效后记", () => {
  const { root, cleanup } = makeWorkspace({ "src/a.ts": "a", "lib/b.ts": "b" });
  try {
    const events: Array<Record<string, unknown>> = [];
    const sink = {
      appendGrantCreated: (input: Record<string, unknown>) => {
        events.push(input);
      },
      appendGrantRevoked: (input: Record<string, unknown>) => {
        events.push(input);
      },
    };
    const store = new SessionGrantStore({ workspaceRoot: root, eventLog: sink });
    const grant = store.create({
      tool: "edit_file",
      pathPrefix: "src",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.tool, "edit_file");
    assert.equal(events[0]?.pathPrefix, "src");

    // 目录内命中、目录外不命中、非路径参数不命中
    assert.deepEqual(store.match("edit_file", { path: "src/a.ts" }), {
      source: "session-grant",
      refId: grant.grantId,
    });
    assert.equal(store.match("edit_file", { path: "lib/b.ts" }), null);
    assert.equal(store.match("edit_file", {}), null);
    assert.equal(store.match("read_file", { path: "src/a.ts" }), null);

    // 求值纯无副作用：命中计数由 noteEffectiveHit 记（deny 压过 grant 的求值不计命中）
    assert.equal(store.list()[0]?.hitCount, 0);
    store.noteEffectiveHit({ source: "session-grant", refId: grant.grantId });
    assert.equal(store.list()[0]?.hitCount, 1);
    // 配置规则出处不进会话存储
    store.noteEffectiveHit({ source: "config-rule", refId: "config:grants.json#0" });
    assert.equal(store.list()[0]?.hitCount, 1);
  } finally {
    cleanup();
  }
});

test("会话 grant：撤销立即停匹配并写 grant.revoked；未知 id 响亮报错；恢复种子冷启动生效", () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "a" });
  try {
    const events: Array<Record<string, unknown>> = [];
    const sink = {
      appendGrantCreated: (input: Record<string, unknown>) => {
        events.push(input);
      },
      appendGrantRevoked: (input: Record<string, unknown>) => {
        events.push(input);
      },
    };
    const store = new SessionGrantStore({ workspaceRoot: root, eventLog: sink });
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
    });
    store.revoke(grant.grantId);
    assert.equal(store.match("edit_file", { path: "a.ts" }), null, "撤销立即生效");
    assert.equal(events.filter((event) => "revokedAt" in event).length, 1);
    assert.throws(() => store.revoke(grant.grantId), /不存在/);

    // 冷恢复种子（决策 3b）：从物化态还原的 grant 直接生效，无需重写事件
    const restored: ActiveGrant = {
      grantId: newGrantId(),
      tool: "edit_file",
      createdAt: 1_757_000_000_000,
      firstCall: { toolCallId: "toolu_01XYZ", args: { path: "a.ts" } },
    };
    const store2 = new SessionGrantStore({ workspaceRoot: root, restored: [restored] });
    assert.equal(store2.list().length, 1);
    assert.deepEqual(store2.match("edit_file", { path: "a.ts" }), {
      source: "session-grant",
      refId: restored.grantId,
    });
  } finally {
    cleanup();
  }
});
