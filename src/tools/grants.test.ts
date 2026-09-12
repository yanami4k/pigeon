// Grant 确定性匹配测试（M4 S6 决策 3 约束 5 + 收口决策 ①）：工具名 + 目录包含；回指
// promotedFrom.grantId 稳定身份，删前面的规则后回指不变；无工作区根 fail-closed。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newGrantId, newSessionId } from "../state/ids.ts";
import { matchConfigGrants } from "./grants.ts";

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

// ---- 配置规则匹配 ----

test("配置规则匹配：命中回指 promotedFrom.grantId（稳定身份，M4 收口决策 ①）；目录限定外/非路径参数不命中", () => {
  const { root, cleanup } = makeWorkspace({ "src/a.ts": "a", "lib/b.ts": "b" });
  try {
    const editGrantId = newGrantId();
    const readGrantId = newGrantId();
    const rules = [
      {
        tool: "edit_file",
        pathPrefix: "src",
        promotedFrom: {
          grantId: editGrantId,
          sessionId: newSessionId(),
          firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
          promotedAt: 1,
        },
      },
      {
        tool: "read_file",
        promotedFrom: {
          grantId: readGrantId,
          sessionId: newSessionId(),
          firstCall: { toolCallId: "toolu_01DEF", args: { path: "b.ts" } },
          promotedAt: 2,
        },
      },
    ];
    assert.deepEqual(matchConfigGrants(rules, root, "edit_file", { path: "src/a.ts" }), {
      source: "config-rule",
      refId: editGrantId,
    });
    assert.equal(matchConfigGrants(rules, root, "edit_file", { path: "lib/b.ts" }), null);
    assert.equal(matchConfigGrants(rules, root, "edit_file", { nope: 1 }), null);
    assert.equal(matchConfigGrants(rules, root, "other_tool", { path: "src/a.ts" }), null);
    // 工具级规则（无 pathPrefix）不依赖路径解析，无路径参数也命中
    assert.deepEqual(matchConfigGrants(rules, root, "read_file", {}), {
      source: "config-rule",
      refId: readGrantId,
    });
    // 回指稳定性（P2-1 根因）：删掉排在前面的规则后，剩余规则的回指逐字不变——
    // 位置序号会前移，身份不会
    const afterRemoval = rules.slice(1);
    assert.deepEqual(matchConfigGrants(afterRemoval, root, "read_file", {}), {
      source: "config-rule",
      refId: readGrantId,
    });
    // 目录限定规则在无工作区根可解析时不得匹配（fail-closed 到人工）
    assert.equal(matchConfigGrants(rules, undefined, "edit_file", { path: "src/a.ts" }), null);
  } finally {
    cleanup();
  }
});
