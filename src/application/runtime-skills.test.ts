// M5 S4（决策 043）：装配根在会话开始登记 Skill Catalog——名称、简介、路径追加进 system prompt
// 与 Memory 同段冻结，哈希清单进 InjectionSnapshot v3 的 skills 字段；有 Skill 才注册并广告
// load_skill，无 Skill 时不占工具广告。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { buildRuntime } from "./runtime.ts";

async function build(root: string, home: string) {
  const bundle = buildRuntime({
    streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: false,
    provider: "fake-provider",
    modelId: "fake-model",
    createApprovalHandler: () => async () => ({ approved: false }),
    homeDir: home,
  });
  const snapshot = bundle.adapter.snapshot();
  await bundle.adapter.dispose();
  bundle.eventLog.close();
  return snapshot;
}

test("有 Skill：目录行进 system prompt、清单进快照、load_skill 被广告；无 Skill：不广告", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-runtime-skills-"));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  try {
    const withSkills = join(base, "with");
    mkdirSync(join(withSkills, ".pigeon", "skills", "deploy"), { recursive: true });
    writeFileSync(
      join(withSkills, ".pigeon", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 部署步骤\n---\n# 部署正文\n"
    );
    const snapshot = await build(withSkills, home);
    assert.ok(
      snapshot.context.systemPrompt.includes("- deploy：部署步骤（.pigeon/skills/deploy）")
    );
    assert.ok(!snapshot.context.systemPrompt.includes("部署正文"));
    assert.equal(snapshot.skills.length, 1);
    assert.equal(snapshot.skills[0]?.name, "deploy");
    assert.deepEqual(
      snapshot.skills[0]?.files.map((file) => file.path),
      ["SKILL.md"]
    );
    assert.ok(snapshot.tools.advertised.includes("load_skill"));

    const without = join(base, "without");
    mkdirSync(without, { recursive: true });
    const bare = await build(without, home);
    assert.deepEqual(bare.skills, []);
    assert.ok(!bare.tools.advertised.includes("load_skill"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
