// M5 S4（决策 043）：Skill Catalog 扫描——项目级与用户级标准目录、前言 name / description、
// 开会话给每个 Skill 目录下全部文件算哈希清单；只把名称、简介、路径放进 Skill 目录段（开工状态块的一节），
// 大量 Skill 不线性膨胀初始上下文（完成证据）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { loadSkillCatalog } from "./catalog.ts";

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

function makeDirs(): { root: string; home: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "pigeon-skills-"));
  const root = join(base, "workspace");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skillMd(name: string, description: string, body = "# 正文"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

test("扫描项目级与用户级：前言 name / description；清单含目录下全部文件的哈希与字节数", () => {
  const { root, home, cleanup } = makeDirs();
  try {
    const deploy = skillMd("deploy", "部署到预发环境的步骤", "# 部署\n1. 先跑测试");
    writeFile(join(root, ".pigeon", "skills", "deploy", "SKILL.md"), deploy);
    writeFile(join(root, ".pigeon", "skills", "deploy", "references", "checklist.md"), "检查清单");
    writeFile(join(root, ".pigeon", "skills", "deploy", "scripts", "run.sh"), "echo hi");
    writeFile(
      join(home, ".pigeon", "skills", "review", "SKILL.md"),
      skillMd("review", "代码评审要点")
    );

    const catalog = loadSkillCatalog({ workspaceRoot: root, homeDir: home });
    assert.deepEqual(
      catalog.skills.map((skill) => [skill.name, skill.description, skill.displayPath]),
      [
        ["deploy", "部署到预发环境的步骤", ".pigeon/skills/deploy"],
        ["review", "代码评审要点", "~/.pigeon/skills/review"],
      ]
    );
    assert.deepEqual(catalog.manifest[0], {
      name: "deploy",
      path: ".pigeon/skills/deploy",
      files: [
        { path: "SKILL.md", hash: sha256(deploy), bytes: Buffer.byteLength(deploy) },
        { path: "references/checklist.md", hash: sha256("检查清单"), bytes: 12 },
        { path: "scripts/run.sh", hash: sha256("echo hi"), bytes: 7 },
      ],
    });
    assert.ok(catalog.section.includes("- deploy：部署到预发环境的步骤（.pigeon/skills/deploy）"));
    assert.ok(catalog.section.includes("- review：代码评审要点（~/.pigeon/skills/review）"));
    assert.ok(!catalog.section.includes("先跑测试"), "SKILL.md 正文不进启动注入");
    assert.match(catalog.section, /load_skill/);
  } finally {
    cleanup();
  }
});

test("同名 Skill 项目级优先，用户级同名记问题不重复登记；缺 SKILL.md 的目录不登记；缺前言字段有兜底", () => {
  const { root, home, cleanup } = makeDirs();
  try {
    writeFile(join(root, ".pigeon", "skills", "review", "SKILL.md"), skillMd("review", "项目版"));
    writeFile(join(home, ".pigeon", "skills", "review", "SKILL.md"), skillMd("review", "用户版"));
    mkdirSync(join(root, ".pigeon", "skills", "empty"), { recursive: true });
    writeFile(join(root, ".pigeon", "skills", "bare", "SKILL.md"), "# 没有前言");

    const catalog = loadSkillCatalog({ workspaceRoot: root, homeDir: home });
    assert.deepEqual(
      catalog.skills.map((skill) => [skill.name, skill.description]),
      [
        ["bare", "（无简介）"],
        ["review", "项目版"],
      ]
    );
    assert.ok(catalog.problems.some((problem) => problem.includes("~/.pigeon/skills/review")));
    assert.ok(catalog.problems.some((problem) => problem.includes(".pigeon/skills/empty")));
  } finally {
    cleanup();
  }
});

test("一百个 Skill：初始上下文只涨目录行数，正文不进 system prompt 段（完成证据）", () => {
  const { root, home, cleanup } = makeDirs();
  try {
    for (let index = 0; index < 100; index++) {
      const name = `s${String(index).padStart(3, "0")}`;
      writeFile(
        join(root, ".pigeon", "skills", name, "SKILL.md"),
        skillMd(name, `第 ${index} 个技能`, "长正文".repeat(2000))
      );
    }
    const catalog = loadSkillCatalog({ workspaceRoot: root, homeDir: home });
    assert.equal(catalog.skills.length, 100);
    const lines = catalog.section.split("\n").filter((line) => line.startsWith("- "));
    assert.equal(lines.length, 100);
    assert.ok(!catalog.section.includes("长正文"));
    assert.ok(catalog.section.length < 6000, `目录段过长：${catalog.section.length}`);
  } finally {
    cleanup();
  }
});

test("无 Skill 时段落与清单为空", () => {
  const { root, home, cleanup } = makeDirs();
  try {
    const catalog = loadSkillCatalog({ workspaceRoot: root, homeDir: home });
    assert.equal(catalog.section, "");
    assert.deepEqual(catalog.manifest, []);
    assert.deepEqual(catalog.skills, []);
  } finally {
    cleanup();
  }
});
