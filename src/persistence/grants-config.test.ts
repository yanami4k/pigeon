// 固化 grant 配置文件读写测试（M4 S6 D6 + 收口决策 ②）：缺失 = 无规则、合法载入、畸形
// fail-closed、升格追加、同 grantId 去重拒绝。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newGrantId, newSessionId } from "../state/ids.ts";
import {
  appendGrantConfigRule,
  findPromotedRuleIndex,
  GrantAlreadyPromotedError,
  GrantsConfigError,
  grantsConfigPath,
  loadGrantConfig,
} from "./grants-config.ts";

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
        permissions: {
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
        },
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
        assert.ok(error.message.includes("settings.local.json（项目个人）"), error.message);
        return true;
      }
    );

    writeFileSync(
      grantsConfigPath(root),
      JSON.stringify({ permissions: { grants: [{ tool: "edit_file" }] } }),
      "utf8"
    );
    assert.throws(
      () => loadGrantConfig(root),
      (error: unknown) => {
        assert.ok(error instanceof GrantsConfigError);
        assert.ok(error.message.includes("permissions"), error.message);
        assert.ok(error.message.includes("promotedFrom"), error.message);
        return true;
      }
    );

    writeFileSync(grantsConfigPath(root), JSON.stringify({ grants: [] }), "utf8");
    assert.throws(() => loadGrantConfig(root), GrantsConfigError);
  } finally {
    cleanup();
  }
});

test("升格写入：appendGrantConfigRule 新建/追加项目个人设置的 permissions 一节，出处字段逐字保留，其余各节原样", () => {
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
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(
      grantsConfigPath(root),
      JSON.stringify({ commands: { commands: { t: "npm test" } }, $schema: "x" })
    );
    appendGrantConfigRule(root, rule);
    const { pathPrefix: _omit, ...toolOnly } = rule;
    // 第二条规则来自另一个 grant（同 grantId 二次升格会被去重拒绝，见决策 ② 用例）
    appendGrantConfigRule(root, {
      ...toolOnly,
      tool: "read_file",
      promotedFrom: { ...toolOnly.promotedFrom, grantId: newGrantId() },
    });
    const rules = loadGrantConfig(root);
    assert.equal(rules.length, 2);
    assert.deepEqual(rules[0], rule);
    assert.equal(rules[1]?.tool, "read_file");
    // 文件可读（人可读配置，D6）；文件里其余各节原样保留
    const onDisk = JSON.parse(readFileSync(grantsConfigPath(root), "utf8")) as {
      permissions: { grants: unknown[] };
      commands: unknown;
      $schema: string;
    };
    assert.equal(onDisk.permissions.grants.length, 2);
    assert.deepEqual(onDisk.commands, { commands: { t: "npm test" } });
    assert.equal(onDisk.$schema, "x");
  } finally {
    cleanup();
  }
});

test("升格去重（note-6 / 决策 ②）：同一 grantId 二次升格响亮报错并指出已存在的 config#N；文件不变", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const grantId = newGrantId();
    const rule = {
      tool: "edit_file",
      promotedFrom: {
        grantId,
        sessionId: newSessionId(),
        firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
        promotedAt: 1_757_000_000_000,
      },
    };
    appendGrantConfigRule(root, {
      ...rule,
      tool: "read_file",
      promotedFrom: { ...rule.promotedFrom, grantId: newGrantId() },
    });
    appendGrantConfigRule(root, rule);
    // 第一次建个人设置时写下 .pigeon/.gitignore
    assert.equal(
      readFileSync(join(root, ".pigeon", ".gitignore"), "utf8"),
      "state/\nsettings.local.json\n"
    );
    assert.equal(findPromotedRuleIndex(loadGrantConfig(root), grantId), 1);
    const bytesBefore = readFileSync(grantsConfigPath(root), "utf8");
    assert.throws(
      () =>
        appendGrantConfigRule(root, {
          ...rule,
          promotedFrom: { ...rule.promotedFrom, promotedAt: 2 },
        }),
      (error: unknown) => {
        assert.ok(error instanceof GrantAlreadyPromotedError);
        assert.ok(error instanceof GrantsConfigError, "去重失败也是配置错误的子类");
        assert.ok(error.message.includes("config#1"), error.message);
        assert.ok(error.message.includes(grantId), error.message);
        return true;
      }
    );
    assert.equal(readFileSync(grantsConfigPath(root), "utf8"), bytesBefore, "拒绝时文件不得改写");
    assert.equal(findPromotedRuleIndex(loadGrantConfig(root), newGrantId()), -1);
  } finally {
    cleanup();
  }
});
