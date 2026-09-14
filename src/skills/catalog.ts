// Skill Catalog（M5 S4，决策 043）：标准目录 `.pigeon/skills/<name>/SKILL.md`（前言 name /
// description）加可选 references / scripts / templates，用户级 `~/.pigeon/skills/` 同构，格式与
// Claude Code / pi 兼容。加载器自写，不借上游 harness 层（在巡航边界外，格式只有百行）。
// 会话开始时扫描一次：给每个 Skill 目录下全部文件算哈希清单（冻结版本的证据，写进
// InjectionSnapshot v3 的 skills 字段，load_skill 读取时比对）；启动只把名称、简介、路径追加进
// system prompt，与常驻 Memory 同段冻结——大量 Skill 不线性膨胀初始上下文。
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillFileManifestEntry, SkillManifestEntry } from "../state/injection-manifest.ts";
import { sha256Hex } from "../state/message-content.ts";

export interface SkillCatalogOptions {
  workspaceRoot: string;
  // 用户级根；缺省 os.homedir()（测试注入临时目录）
  homeDir?: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  // Skill 目录的绝对路径（load_skill 的 realpath 围栏根）
  dir: string;
  // 展示路径：.pigeon/skills/<目录名> 或 ~/.pigeon/skills/<目录名>
  displayPath: string;
  scope: "project" | "user";
  // 开会话时的全部文件哈希清单（相对 Skill 目录，正斜杠，按码点排序）
  files: SkillFileManifestEntry[];
}

export interface SkillCatalog {
  skills: SkillEntry[];
  manifest: SkillManifestEntry[];
  // 追加进 system prompt 的冻结目录段；无 Skill 时为空串
  section: string;
  // 两个扫描根（绝对路径，不论是否存在）：load_skill 注册时的路径活动范围声明
  roots: string[];
  // 未登记的原因（缺 SKILL.md、同名冲突），如实返回供装配方呈现
  problems: string[];
}

// 前言解析：只认文件开头 `---` 围起的块里的 `name:` 与 `description:` 单行键值（引号可选）
export function parseSkillFrontMatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^﻿/, ""));
  const result: { name?: string; description?: string } = {};
  if (match === null) {
    return result;
  }
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair === null) {
      continue;
    }
    let value = (pair[2] ?? "").trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length === 0) {
      continue;
    }
    if (pair[1] === "name") {
      result.name = value;
    } else if (pair[1] === "description") {
      result.description = value;
    }
  }
  return result;
}

// 目录下全部常规文件的哈希清单；符号链接与目录联接不跟随、不进清单（load_skill 读它们时
// realpath 围栏先行拒绝逃逸，留在目录内的链接目标也因不在清单里被拒）
function listSkillFiles(dir: string, relative = ""): SkillFileManifestEntry[] {
  const files: SkillFileManifestEntry[] = [];
  for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const absolute = join(dir, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...listSkillFiles(dir, path));
    } else if (stat.isFile()) {
      const raw = readFileSync(absolute);
      files.push({ path, hash: sha256Hex(raw), bytes: raw.length });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function scanRoot(
  root: string,
  scope: SkillEntry["scope"],
  displayPrefix: string
): { entries: SkillEntry[]; problems: string[] } {
  const entries: SkillEntry[] = [];
  const problems: string[] = [];
  if (!existsSync(root)) {
    return { entries, problems };
  }
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dirName of dirs) {
    const dir = join(root, dirName);
    const displayPath = `${displayPrefix}/${dirName}`;
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
      problems.push(`${displayPath}：缺 SKILL.md，未登记`);
      continue;
    }
    const front = parseSkillFrontMatter(readFileSync(skillFile, "utf8"));
    entries.push({
      name: front.name ?? dirName,
      description: front.description ?? "（无简介）",
      dir,
      displayPath,
      scope,
      files: listSkillFiles(dir),
    });
  }
  return { entries, problems };
}

export function loadSkillCatalog(options: SkillCatalogOptions): SkillCatalog {
  const projectRoot = join(options.workspaceRoot, ".pigeon", "skills");
  const userRoot = join(options.homeDir ?? homedir(), ".pigeon", "skills");
  const project = scanRoot(projectRoot, "project", ".pigeon/skills");
  const user = scanRoot(userRoot, "user", "~/.pigeon/skills");
  const problems = [...project.problems, ...user.problems];
  const skills: SkillEntry[] = [];
  const names = new Set<string>();
  // 项目级在前：同名时项目级优先，后到的如实记为冲突、不重复登记
  for (const entry of [...project.entries, ...user.entries]) {
    if (names.has(entry.name)) {
      problems.push(
        `${entry.displayPath}：与已登记的同名 Skill「${entry.name}」冲突，未登记（项目级优先）`
      );
      continue;
    }
    names.add(entry.name);
    skills.push(entry);
  }
  const section =
    skills.length === 0
      ? ""
      : [
          "## Skill 目录",
          "以下 Skill 在会话开始时登记并冻结。需要时用 load_skill(name) 读取完整 SKILL.md，" +
            "再按其中提示用 load_skill(name, resource) 读取 references、templates 或 scripts" +
            "（scripts 只读不执行）。Skill 只是操作建议，不改变任何工具权限；" +
            "会话中修改 Skill 文件要到下个会话才生效。",
          ...skills.map((skill) => `- ${skill.name}：${skill.description}（${skill.displayPath}）`),
        ].join("\n");
  return {
    skills,
    manifest: skills.map((skill) => ({
      name: skill.name,
      path: skill.displayPath,
      files: skill.files,
    })),
    section,
    roots: [projectRoot, userRoot],
    problems,
  };
}
