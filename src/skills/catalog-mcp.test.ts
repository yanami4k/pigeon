// MCP prompts 进 Skill Catalog（M5.7 S4，决策 043 口径）：名称与简介进目录段，来源标为 server；哈希清单按会话开始时
// 取到的正文算（load_skill 读取时比对）；与本地 Skill 同名时本地优先，如实记冲突。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSkillCatalog, MCP_PROMPT_RESOURCE } from "./catalog.ts";

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

test("MCP prompts 进 Skill Catalog：名称、简介、来源标 server；哈希清单按会话开始时的正文算；与本地 Skill 同名记冲突", () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-skills-mcp-"));
  try {
    const root = join(base, "workspace");
    const home = join(base, "home");
    mkdirSync(join(root, ".pigeon", "skills", "deploy"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(root, ".pigeon", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 部署步骤\n---\n# 部署\n"
    );
    const simple = "This is a simple prompt without arguments.";
    const catalog = loadSkillCatalog({
      workspaceRoot: root,
      homeDir: home,
      prompts: [
        {
          name: "mcp__everything__simple_prompt",
          description: "A prompt with no arguments",
          server: "everything",
          prompt: "simple-prompt",
          text: simple,
          load: async () => simple,
        },
        {
          name: "mcp__everything__untitled",
          server: "everything",
          prompt: "untitled",
          text: "无简介",
          load: async () => "无简介",
        },
        {
          name: "deploy",
          server: "fx",
          prompt: "deploy",
          text: "同名",
          load: async () => "同名",
        },
      ],
    });
    assert.deepEqual(
      catalog.skills.map((skill) => [skill.name, skill.scope, skill.displayPath]),
      [
        ["deploy", "project", ".pigeon/skills/deploy"],
        ["mcp__everything__simple_prompt", "mcp", "mcp:everything/simple-prompt"],
        ["mcp__everything__untitled", "mcp", "mcp:everything/untitled"],
      ]
    );
    const entry = catalog.skills[1];
    assert.equal(entry?.prompt?.server, "everything");
    assert.equal(entry?.prompt?.prompt, "simple-prompt");
    assert.deepEqual(catalog.manifest[1], {
      name: "mcp__everything__simple_prompt",
      path: "mcp:everything/simple-prompt",
      files: [
        { path: MCP_PROMPT_RESOURCE, hash: sha256(simple), bytes: Buffer.byteLength(simple) },
      ],
    });
    assert.ok(
      catalog.section.includes(
        "- mcp__everything__simple_prompt：A prompt with no arguments（MCP server everything 的 prompt）"
      ),
      catalog.section
    );
    assert.ok(
      catalog.section.includes(
        "- mcp__everything__untitled：（无简介）（MCP server everything 的 prompt）"
      ),
      catalog.section
    );
    assert.ok(
      catalog.problems.some(
        (problem) => problem.includes("mcp:fx/deploy") && problem.includes("冲突")
      ),
      JSON.stringify(catalog.problems)
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
