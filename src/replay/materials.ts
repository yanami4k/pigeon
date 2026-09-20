// 回放材料：临时治理根（M8 S3，决策 085 / 083）。
//
// 决策 085：在回放工作区里造一个临时治理根，把经验按种类的正常格式放进去，走与真激活完全相同的装载路径
// （即 activation 层的落点与写入），宿主的经验目录一个字节都不写。
// 为什么不走"运行面注入"：那会造出第二条装载路径，验证形态与激活形态的细微差异最难发现。
// 为什么不"真激活后撤销"：崩溃时会留下已激活的经验，与"不能跳过审批"直接冲突。
//
// 临时治理根里放什么：
//   - 固化命令规则 .pigeon/commands.json 与固化放权规则 .pigeon/grants.json 从宿主复制——
//     回放的命令档工具只在固化命令规则内放行（083），规则不在就等于一条命令也跑不了；
//   - 宿主已激活的 Skill 与 Memory（基线组与带经验组都装，两组之间唯一的差别只有候选本身）；
//   - 带经验组另按正常格式放入被验证的候选；同名同种的宿主经验先剔除，避免"旧版本与候选同时在场"。
//   - 不复制 MCP 配置：外部 server 不可复现且把网络面带进回放，回放一律不起外部 server。
//
// 经验集合明细：Skill 目录下的附属资源各自成一条（名字为 <skill>/<相对路径>），
// 故集合内容哈希覆盖真正装载进去的每一个字节；候选自身那条的哈希即候选身份哈希。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { ACTIVATION_DIRS, activateExperience } from "../activation/activate.ts";
import type { CandidateKind } from "../state/candidate.ts";
import type { LoadedExperience } from "../state/event-log.ts";
import { sha256Hex } from "../state/message-content.ts";
import { experienceSetHash } from "./environment.ts";

// 从宿主复制进临时治理根的治理配置（083：固化命令规则与固化放权规则）
export const SEEDED_CONFIG_FILES = ["commands.json", "grants.json"] as const;

export interface SeedRerunRootInput {
  // 宿主治理根：固化规则与已激活经验的来源，只读
  hostGovernanceRoot: string;
  // 临时治理根：回放工作区内的目录（通常即工作树根）
  tempGovernanceRoot: string;
  // 带经验组放入的候选；基线组不传
  candidate?: { kind: CandidateKind; name: string; content: string };
}

export interface SeedRerunRootResult {
  experiences: LoadedExperience[];
  experienceSetHash: string;
}

export function seedRerunRoot(input: SeedRerunRootInput): SeedRerunRootResult {
  const hostPigeon = join(input.hostGovernanceRoot, ".pigeon");
  const tempPigeon = join(input.tempGovernanceRoot, ".pigeon");
  mkdirSync(tempPigeon, { recursive: true });
  for (const file of SEEDED_CONFIG_FILES) {
    const from = join(hostPigeon, file);
    if (existsSync(from)) {
      cpSync(from, join(tempPigeon, file));
    }
  }
  const excluded = input.candidate;
  copyMemories(input.hostGovernanceRoot, input.tempGovernanceRoot, excluded);
  copySkills(input.hostGovernanceRoot, input.tempGovernanceRoot, excluded);
  if (input.candidate !== undefined) {
    activateExperience({
      governanceRoot: input.tempGovernanceRoot,
      kind: input.candidate.kind,
      name: input.candidate.name,
      content: input.candidate.content,
    });
  }
  const experiences = listLoadedExperiences(input.tempGovernanceRoot, input.candidate);
  return { experiences, experienceSetHash: experienceSetHash(experiences) };
}

function sameExperience(
  excluded: { kind: CandidateKind; name: string } | undefined,
  kind: CandidateKind,
  name: string
): boolean {
  return excluded !== undefined && excluded.kind === kind && excluded.name === name;
}

function copyMemories(
  hostRoot: string,
  tempRoot: string,
  excluded: { kind: CandidateKind; name: string } | undefined
): void {
  const from = join(hostRoot, ACTIVATION_DIRS.memory);
  if (!existsSync(from)) {
    return;
  }
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const name = entry.name.slice(0, -".md".length);
    if (sameExperience(excluded, "memory", name)) {
      continue;
    }
    const target = join(tempRoot, ACTIVATION_DIRS.memory, entry.name);
    mkdirSync(join(tempRoot, ACTIVATION_DIRS.memory), { recursive: true });
    cpSync(join(from, entry.name), target);
  }
}

function copySkills(
  hostRoot: string,
  tempRoot: string,
  excluded: { kind: CandidateKind; name: string } | undefined
): void {
  const from = join(hostRoot, ACTIVATION_DIRS.skill);
  if (!existsSync(from)) {
    return;
  }
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isDirectory() || sameExperience(excluded, "skill", entry.name)) {
      continue;
    }
    cpSync(join(from, entry.name), join(tempRoot, ACTIVATION_DIRS.skill, entry.name), {
      recursive: true,
    });
  }
}

// 目录下的全部常规文件（相对路径，正斜杠，按码点排序）
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        out.push(relative(dir, path).split(sep).join(posix.sep));
      }
    }
  };
  walk(dir);
  return out.sort();
}

function entryOf(
  kind: CandidateKind,
  name: string,
  absolute: string,
  candidate: boolean
): LoadedExperience {
  const raw = readFileSync(absolute);
  return { kind, name, contentHash: sha256Hex(raw), bytes: raw.length, candidate };
}

// 临时治理根里真正会被装载的经验清单
export function listLoadedExperiences(
  governanceRoot: string,
  candidate?: { kind: CandidateKind; name: string }
): LoadedExperience[] {
  const experiences: LoadedExperience[] = [];
  const memoryDir = join(governanceRoot, ACTIVATION_DIRS.memory);
  if (existsSync(memoryDir)) {
    for (const file of readdirSync(memoryDir)) {
      if (!file.endsWith(".md") || !statSync(join(memoryDir, file)).isFile()) {
        continue;
      }
      const name = file.slice(0, -".md".length);
      experiences.push(
        entryOf("memory", name, join(memoryDir, file), sameExperience(candidate, "memory", name))
      );
    }
  }
  const skillsDir = join(governanceRoot, ACTIVATION_DIRS.skill);
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillDir = join(skillsDir, entry.name);
      for (const file of filesUnder(skillDir)) {
        // SKILL.md 是这条 Skill 的身份文件，名字即 Skill 名；附属资源各自成一条
        const isBody = file === "SKILL.md";
        experiences.push(
          entryOf(
            "skill",
            isBody ? entry.name : `${entry.name}/${file}`,
            join(skillDir, file),
            isBody && sameExperience(candidate, "skill", entry.name)
          )
        );
      }
    }
  }
  // 只有 Memory 与 Skill 两类进装载路径（决策 094 之后不再有第三种）
  return experiences;
}

// 若此刻把某个候选激活，治理根的经验集合会变成什么样（M8 S7，决策 091）：不写任何文件，
// 只按落点口径算出集合与它的内容哈希。批准前拿它与验证回执里的哈希比对——
// 两者不同即说明"当时验的那一套"与"现在要激活的这一套"不是同一套，批准据此失效。
export function projectedExperienceSet(
  governanceRoot: string,
  candidate?: { kind: CandidateKind; name: string; content: string }
): SeedRerunRootResult {
  const existing = listLoadedExperiences(governanceRoot).filter(
    (entry) =>
      candidate === undefined ||
      !(entry.kind === candidate.kind && ownerName(entry.kind, entry.name) === candidate.name)
  );
  const experiences =
    candidate === undefined
      ? existing
      : [
          ...existing,
          {
            kind: candidate.kind,
            name: candidate.name,
            contentHash: sha256Hex(Buffer.from(candidate.content, "utf8")),
            bytes: Buffer.byteLength(candidate.content, "utf8"),
            candidate: true,
          },
        ];
  return { experiences, experienceSetHash: experienceSetHash(experiences) };
}

// 附属资源那条的名字是 <skill>/<相对路径>，归属的 Skill 名取第一段
function ownerName(kind: CandidateKind, name: string): string {
  return kind === "skill" ? (name.split("/")[0] ?? name) : name;
}
