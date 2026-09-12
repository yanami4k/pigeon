// 会话 grant 存储测试（M4 S6 决策 3 + 3b）：创建写 grant.created、匹配、命中计数只在放行
// 生效后记、撤销写 grant.revoked 并立即停匹配、冷恢复种子生效。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newGrantId } from "../state/ids.ts";
import type { ActiveGrant } from "../state/materialize.ts";
import { SessionGrantStore } from "./grant-store.ts";

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
