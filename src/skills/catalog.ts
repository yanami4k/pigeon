// Skill Catalog（M5 S4，决策 043）：标准目录 `.pigeon/skills/<name>/SKILL.md`（前言 name /
// description）加可选 references / scripts / templates，用户级 `~/.pigeon/skills/` 同构，格式与
// Claude Code / pi 兼容。加载器自写，不借上游 harness 层（在巡航边界外，格式只有百行）。
// 会话开始时扫描一次：给每个 Skill 目录下全部文件算哈希清单（冻结版本的证据，写进
// InjectionSnapshot v3 的 skills 字段，load_skill 读取时比对）；启动只把名称、简介、路径追加进
// system prompt，与常驻 Memory 同段冻结——大量 Skill 不线性膨胀初始上下文。
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SkillFileManifestEntry, SkillManifestEntry } from "../state/injection-manifest.ts";
import { sha256Hex } from "../state/message-content.ts";

// M5.7 S4（决策 043 口径）：MCP server 的 prompt 作为 Skill 登记——正文在会话开始时由装配根经 getPrompt 取好，
// 哈希清单按它算；load_skill 读取时经 load 重取并比对。skills 层只收结构类型，不触达 mcp。
// prompt 型 Skill 只有正文，清单里的资源名固定为 prompt
export const MCP_PROMPT_RESOURCE = "prompt";

export interface SkillPromptSource {
  server: string;
  prompt: string;
  // 重取正文；server 不可用时抛出的错误原样上抛
  load(): Promise<string>;
}

export interface SkillPromptInput extends SkillPromptSource {
  // 目录里的 Skill 名（装配根给 mcp__<server>__<prompt>）
  name: string;
  description?: string;
  // 会话开始时取到的正文
  text: string;
}

// M6.5（决策 059）：显式 Skill 根。label 是清单与目录段里的展示路径（如 eval/skills/<name>/candidate），
// 哈希清单随 run.started 落盘，事后可与该路径下的文件对账
export interface SkillRoot {
  path: string;
  label: string;
}

export interface SkillCatalogOptions {
  workspaceRoot: string;
  // 用户级根；缺省 os.homedir()（测试注入临时目录）
  homeDir?: string;
  // M5.7 S4：MCP server 的 prompts（缺省无）
  prompts?: readonly SkillPromptInput[];
  // M6.5（决策 059）：在场时只扫这些根，不扫治理根的 .pigeon/skills 与用户级目录（空数组 = 不登记任何本地 Skill）；
  // 根目录自身有 SKILL.md 即一个 Skill，否则按子目录登记。第一版候选暂存目录 .pigeon/candidates/skills/
  // （候选链已退役，决策 137；磁盘上的旧目录是用户数据，不删）缺省不加载，
  // 只在这里显式列出时加载
  roots?: readonly SkillRoot[];
}

export interface SkillEntry {
  name: string;
  description: string;
  // Skill 目录的绝对路径（load_skill 的 realpath 围栏根）；MCP prompt 为空串
  dir: string;
  // 展示路径：.pigeon/skills/<目录名>、~/.pigeon/skills/<目录名>、mcp:<server>/<prompt> 或显式根的 label
  displayPath: string;
  scope: "project" | "user" | "mcp" | "configured";
  // 开会话时的全部文件哈希清单（相对 Skill 目录，正斜杠，按码点排序）；MCP prompt 只有正文一项
  files: SkillFileManifestEntry[];
  // MCP prompt 的来源（scope 为 mcp 时在场）
  prompt?: SkillPromptSource;
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
    if (!hasSkillFile(dir)) {
      problems.push(`${displayPath}：缺 SKILL.md，未登记`);
      continue;
    }
    entries.push(skillEntryOf(dir, displayPath, dirName, scope));
  }
  return { entries, problems };
}

function hasSkillFile(dir: string): boolean {
  const skillFile = join(dir, "SKILL.md");
  return existsSync(skillFile) && statSync(skillFile).isFile();
}

function skillEntryOf(
  dir: string,
  displayPath: string,
  fallbackName: string,
  scope: SkillEntry["scope"]
): SkillEntry {
  const front = parseSkillFrontMatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
  return {
    name: front.name ?? fallbackName,
    description: front.description ?? "（无简介）",
    dir,
    displayPath,
    scope,
    files: listSkillFiles(dir),
  };
}

// 显式根（M6.5）：自身有 SKILL.md 即一个 Skill，否则按子目录登记；根不存在如实记为问题
function scanConfiguredRoot(root: SkillRoot): { entries: SkillEntry[]; problems: string[] } {
  if (!existsSync(root.path)) {
    return { entries: [], problems: [`${root.label}：Skill 根不存在，未登记`] };
  }
  if (hasSkillFile(root.path)) {
    return {
      entries: [skillEntryOf(root.path, root.label, basename(root.path), "configured")],
      problems: [],
    };
  }
  return scanRoot(root.path, "configured", root.label);
}

export function loadSkillCatalog(options: SkillCatalogOptions): SkillCatalog {
  const projectRoot = join(options.workspaceRoot, ".pigeon", "skills");
  const userRoot = join(options.homeDir ?? homedir(), ".pigeon", "skills");
  const scanned =
    options.roots !== undefined
      ? options.roots.map(scanConfiguredRoot)
      : [
          scanRoot(projectRoot, "project", ".pigeon/skills"),
          scanRoot(userRoot, "user", "~/.pigeon/skills"),
        ];
  const localEntries = scanned.flatMap((result) => result.entries);
  const problems = scanned.flatMap((result) => result.problems);
  const mcpEntries: SkillEntry[] = (options.prompts ?? []).map((input) => ({
    name: input.name,
    description: input.description ?? "（无简介）",
    dir: "",
    displayPath: `mcp:${input.server}/${input.prompt}`,
    scope: "mcp",
    files: [
      {
        path: MCP_PROMPT_RESOURCE,
        hash: sha256Hex(input.text),
        bytes: Buffer.byteLength(input.text),
      },
    ],
    prompt: { server: input.server, prompt: input.prompt, load: input.load },
  }));
  const skills: SkillEntry[] = [];
  const names = new Set<string>();
  // 项目级在前、用户级其次、MCP prompt 最后：同名时先登记者优先，后到的如实记为冲突、不重复登记
  for (const entry of [...localEntries, ...mcpEntries]) {
    if (names.has(entry.name)) {
      problems.push(
        `${entry.displayPath}：与已登记的同名 Skill「${entry.name}」冲突，未登记（${entry.scope === "mcp" ? "本地 Skill 优先" : "项目级优先"}）`
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
            "（scripts 只读不执行）。MCP server 的 prompt 只有正文，用 load_skill(name) 读取。" +
            "Skill 只是操作建议，不改变任何工具权限；会话中修改 Skill 文件要到下个会话才生效。",
          ...skills.map((skill) =>
            skill.prompt !== undefined
              ? `- ${skill.name}：${skill.description}（MCP server ${skill.prompt.server} 的 prompt）`
              : `- ${skill.name}：${skill.description}（${skill.displayPath}）`
          ),
        ].join("\n");
  return {
    skills,
    manifest: skills.map((skill) => ({
      name: skill.name,
      path: skill.displayPath,
      files: skill.files,
    })),
    section,
    roots:
      options.roots !== undefined
        ? options.roots.map((root) => root.path)
        : [projectRoot, userRoot],
    problems,
  };
}
