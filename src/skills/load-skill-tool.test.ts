// M5 S4（决策 043）：load_skill 三重约束 fail-closed——realpath 后必须在该 Skill 目录内（含目录联接
// 逃逸）、单文件上限默认 64 KiB 超出可见截断、来源只认登记过的 Skill 名；读取时比对开会话时的
// 哈希清单，不符或新增文件拒绝并提示下个会话生效；每次读取回调 skill.loaded 载荷；scripts 只读不执行。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { SkillLoadedPayload } from "../state/runtime-events.ts";
import { loadSkillCatalog } from "./catalog.ts";
import {
  createLoadSkillTool,
  DEFAULT_SKILL_FILE_LIMIT_BYTES,
  LOAD_SKILL_TOOL,
} from "./load-skill-tool.ts";

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

const SKILL_MD = "---\nname: deploy\ndescription: 部署步骤\n---\n# 部署\n1. 先跑测试\n";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

function makeSkill(setup?: (skillDir: string, base: string) => void) {
  const base = mkdtempSync(join(tmpdir(), "pigeon-load-skill-"));
  const root = join(base, "workspace");
  const home = join(base, "home");
  const skillDir = join(root, ".pigeon", "skills", "deploy");
  mkdirSync(home, { recursive: true });
  writeFile(join(skillDir, "SKILL.md"), SKILL_MD);
  writeFile(join(skillDir, "references", "checklist.md"), "检查清单");
  writeFile(join(skillDir, "scripts", "run.sh"), "echo hi");
  writeFile(join(base, "outside", "secret.md"), "不该读到的机密");
  setup?.(skillDir, base);
  const catalog = loadSkillCatalog({ workspaceRoot: root, homeDir: home });
  const loaded: SkillLoadedPayload[] = [];
  const tool = createLoadSkillTool({ catalog, onLoaded: (payload) => loaded.push(payload) });
  return {
    base,
    skillDir,
    tool,
    loaded,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test("读 SKILL.md 与 references 资源；每次读取回调 skill.loaded 载荷（名、路径、哈希、是否截断）", async () => {
  const { tool, loaded, cleanup } = makeSkill();
  try {
    assert.equal(tool.name, LOAD_SKILL_TOOL);
    const main = await tool.execute("t1", { name: "deploy" });
    assert.match(textOf(main), /# 部署/);
    assert.equal(main.details.resourcePath, "SKILL.md");
    const reference = await tool.execute("t2", {
      name: "deploy",
      resource: "references/checklist.md",
    });
    assert.match(textOf(reference), /检查清单/);
    assert.deepEqual(loaded, [
      {
        name: "deploy",
        resourcePath: "SKILL.md",
        hash: sha256(SKILL_MD),
        bytes: Buffer.byteLength(SKILL_MD),
        truncated: false,
      },
      {
        name: "deploy",
        resourcePath: "references/checklist.md",
        hash: sha256("检查清单"),
        bytes: 12,
        truncated: false,
      },
    ]);
  } finally {
    cleanup();
  }
});

test("来源约束：未登记的 Skill 名拒绝，什么都不返回也不留读取记录", async () => {
  const { tool, loaded, cleanup } = makeSkill();
  try {
    await assert.rejects(tool.execute("t1", { name: "ghost" }), /未登记的 Skill：ghost/);
    assert.deepEqual(loaded, []);
  } finally {
    cleanup();
  }
});

test("路径约束：../ 与目录联接逃逸出 Skill 目录一律拒绝（去 realpath 校验变红）", async () => {
  const { tool, loaded, cleanup } = makeSkill((skillDir, base) => {
    symlinkSync(join(base, "outside"), join(skillDir, "linked"), "junction");
  });
  try {
    await assert.rejects(
      tool.execute("t1", { name: "deploy", resource: "../../../../outside/secret.md" }),
      /越出 Skill 目录/
    );
    await assert.rejects(
      tool.execute("t2", { name: "deploy", resource: "linked/secret.md" }),
      /越出 Skill 目录/
    );
    assert.deepEqual(loaded, []);
  } finally {
    cleanup();
  }
});

test("路径约束：名字以 .. 开头的合法资源（..notes.md）照常读取；../ 与目录联接逃逸仍拒绝", async () => {
  const { tool, loaded, cleanup } = makeSkill((skillDir, base) => {
    writeFile(join(skillDir, "..notes.md"), "两个点开头的笔记");
    symlinkSync(join(base, "outside"), join(skillDir, "linked"), "junction");
  });
  try {
    const notes = await tool.execute("t1", { name: "deploy", resource: "..notes.md" });
    assert.match(textOf(notes), /两个点开头的笔记/);
    assert.equal(notes.details.resourcePath, "..notes.md");
    await assert.rejects(
      tool.execute("t2", { name: "deploy", resource: "../../../../outside/secret.md" }),
      /越出 Skill 目录/
    );
    await assert.rejects(
      tool.execute("t3", { name: "deploy", resource: "linked/secret.md" }),
      /越出 Skill 目录/
    );
    assert.deepEqual(
      loaded.map((entry) => entry.resourcePath),
      ["..notes.md"]
    );
  } finally {
    cleanup();
  }
});

test("大小约束：单文件超 64 KiB 可见截断并带全文哈希（去大小上限变红）", async () => {
  const big = "大".repeat(30000);
  const { tool, loaded, cleanup } = makeSkill((skillDir) => {
    writeFile(join(skillDir, "references", "big.md"), big);
  });
  try {
    assert.equal(DEFAULT_SKILL_FILE_LIMIT_BYTES, 64 * 1024);
    const result = await tool.execute("t1", { name: "deploy", resource: "references/big.md" });
    const text = textOf(result);
    assert.equal(result.details.truncated, true);
    assert.match(text, /已截断/);
    assert.ok(text.includes(sha256(big)));
    assert.ok(Buffer.byteLength(text) < 64 * 1024 + 1024);
    assert.equal(loaded[0]?.truncated, true);
    assert.equal(loaded[0]?.bytes, Buffer.byteLength(big));
  } finally {
    cleanup();
  }
});

test("会话中途改文件或新增文件：与冻结哈希清单不符即拒绝，提示下个会话生效（去哈希比对变红）", async () => {
  const { skillDir, tool, loaded, cleanup } = makeSkill();
  try {
    writeFileSync(join(skillDir, "SKILL.md"), `${SKILL_MD}\n3. 偷偷加的一步`);
    await assert.rejects(tool.execute("t1", { name: "deploy" }), /已变更.*下个会话生效/);
    writeFile(join(skillDir, "references", "new.md"), "会话中新增");
    await assert.rejects(
      tool.execute("t2", { name: "deploy", resource: "references/new.md" }),
      /已变更.*下个会话生效/
    );
    assert.deepEqual(loaded, []);
  } finally {
    cleanup();
  }
});

test("scripts 只读不执行：返回脚本文本并标注不执行", async () => {
  const { tool, cleanup } = makeSkill();
  try {
    const text = textOf(await tool.execute("t1", { name: "deploy", resource: "scripts/run.sh" }));
    assert.match(text, /echo hi/);
    assert.match(text, /只读不执行/);
  } finally {
    cleanup();
  }
});
