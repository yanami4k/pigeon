// Skill Catalog 显式根（M6.5，决策 059 含修订）：暂存目录 .pigeon/candidates/skills/ 缺省不加载，
// 只在显式根里列出时加载；显式根自身有 SKILL.md 即一个 Skill；根不存在如实记为问题。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadSkillCatalog } from "./catalog.ts";

function writeSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} 简介\n---\n正文\n`
  );
}

test("Skill 暂存目录：缺省扫描不加载 .pigeon/candidates/skills，显式列出时只加载它", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pigeon-catalog-roots-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-catalog-roots-home-"));
  try {
    writeSkill(join(workspace, ".pigeon", "skills", "active"), "active");
    const candidates = join(workspace, ".pigeon", "candidates", "skills");
    writeSkill(join(candidates, "staged"), "staged");

    const byDefault = loadSkillCatalog({ workspaceRoot: workspace, homeDir: home });
    assert.deepEqual(
      byDefault.skills.map((skill) => skill.name),
      ["active"]
    );

    const explicit = loadSkillCatalog({
      workspaceRoot: workspace,
      homeDir: home,
      roots: [{ path: candidates, label: ".pigeon/candidates/skills" }],
    });
    assert.deepEqual(
      explicit.skills.map((skill) => [skill.name, skill.displayPath, skill.scope]),
      [["staged", ".pigeon/candidates/skills/staged", "configured"]]
    );
    assert.deepEqual(explicit.roots, [candidates]);
    assert.match(explicit.section, /staged：staged 简介（\.pigeon\/candidates\/skills\/staged）/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Skill 显式根：根自身有 SKILL.md 即一个 Skill（展示路径为 label）；根不存在记为问题；空数组不登记任何本地 Skill", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pigeon-catalog-roots-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-catalog-roots-home-"));
  try {
    writeSkill(join(workspace, ".pigeon", "skills", "active"), "active");
    const candidate = join(workspace, "skills", "pitfalls", "candidate");
    writeSkill(candidate, "pitfalls");
    const catalog = loadSkillCatalog({
      workspaceRoot: workspace,
      homeDir: home,
      roots: [
        { path: candidate, label: "skills/pitfalls/candidate" },
        { path: join(workspace, "missing"), label: "missing" },
      ],
    });
    assert.deepEqual(
      catalog.skills.map((skill) => [skill.name, skill.displayPath]),
      [["pitfalls", "skills/pitfalls/candidate"]]
    );
    assert.deepEqual(
      catalog.manifest[0]?.files.map((file) => file.path),
      ["SKILL.md"]
    );
    assert.ok(catalog.problems.some((problem) => /missing：Skill 根不存在/.test(problem)));

    const none = loadSkillCatalog({ workspaceRoot: workspace, homeDir: home, roots: [] });
    assert.deepEqual(none.skills, []);
    assert.equal(none.section, "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
