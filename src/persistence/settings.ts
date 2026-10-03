// 三层设置的读取与会话快照（决策 325）：会话开始时读一次三层 settings.json 与项目根 .mcp.json，校验、合并，形成本会话的
// 设置快照；本会话内各处都从快照取，中途改文件不生效（决策 326 ②：第三道防线在启动时确认会执行命令的配置，中途重读会绕过确认）。
// worker 与沙箱会话用派出它的会话的快照。文件缺失 = 该层为空（合法）；存在但不是合法 JSON、有未知键、写了 key、项目级写了
// trustedDirectories、或合并后语义不明 → 响亮失败并指出文件、键与所在层。
// 另含：项目程序状态目录 .pigeon/state/ 与 .pigeon/.gitignore 的建立（第一次建状态目录或个人设置时写入 .gitignore）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DotMcpJson } from "../state/mcp-config.ts";
import {
  dotMcpJsonPathOf,
  LOCAL_SETTINGS_FILE,
  PIGEON_GITIGNORE_LINES,
  pigeonRel,
  projectLocalSettingsPath,
  projectPigeonDir,
  projectPigeonGitignorePath,
  projectSettingsPath,
  projectStateDir,
  SETTINGS_FILE,
  userPigeonRel,
  userSettingsPath,
} from "../state/paths.ts";
import {
  describeSource,
  mergedSettingsProblems,
  mergeSettingsLayers,
  type SettingsFile,
  type SettingsLayer,
  type SettingsSnapshot,
  type SettingsSource,
  validateSettingsLayer,
} from "../state/settings.ts";
import { readDotMcpJson } from "./mcp-config.ts";

export class SettingsError extends Error {}

export interface SettingsLocation extends SettingsSource {
  path: string;
}

// 三层文件的位置（按优先级从低到高）
export function settingsLocations(root: string, homeDir: string = homedir()): SettingsLocation[] {
  return [
    { layer: "user", path: userSettingsPath(homeDir), file: userPigeonRel(SETTINGS_FILE) },
    { layer: "project", path: projectSettingsPath(root), file: pigeonRel(SETTINGS_FILE) },
    { layer: "local", path: projectLocalSettingsPath(root), file: pigeonRel(LOCAL_SETTINGS_FILE) },
  ];
}

// 读一层：缺失为 undefined；不是合法 JSON 或校验不过响亮失败
export function readSettingsLayer(location: SettingsLocation): SettingsFile | undefined {
  if (!existsSync(location.path)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(location.path, "utf8"));
  } catch (error) {
    throw new SettingsError(
      `设置文件 ${describeSource(location)}不是合法 JSON：${location.path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const checked = validateSettingsLayer(raw, location);
  if ("problems" in checked) {
    throw new SettingsError(`${checked.problems.join("；")}（${location.path}）`);
  }
  return checked.file;
}

export interface LoadSettingsOptions {
  // 用户主目录（缺省 os.homedir()；测试指到临时目录）
  homeDir?: string;
}

// 读三层与 .mcp.json，合并成本会话的设置快照
export function loadSettings(root: string, options: LoadSettingsOptions = {}): SettingsSnapshot {
  const locations = settingsLocations(root, options.homeDir);
  const layers: Array<{ layer: SettingsLayer; file: SettingsFile }> = [];
  const sources: Array<SettingsSource & { exists: boolean }> = [];
  for (const location of locations) {
    const file = readSettingsLayer(location);
    sources.push({ layer: location.layer, file: location.file, exists: file !== undefined });
    if (file !== undefined) {
      layers.push({ layer: location.layer, file });
    }
  }
  let dotMcp: DotMcpJson | undefined;
  try {
    dotMcp = readDotMcpJson(dotMcpJsonPathOf(root));
  } catch (error) {
    throw new SettingsError(error instanceof Error ? error.message : String(error));
  }
  const result = mergeSettingsLayers(layers);
  const problems = mergedSettingsProblems(result.merged, dotMcp);
  if (problems.length > 0) {
    throw new SettingsError(`设置合并后校验失败：${problems.join("；")}`);
  }
  const dockerfile = result.merged.sandbox?.dockerfile;
  let dockerfileContent: string | undefined;
  if (dockerfile !== undefined) {
    try {
      dockerfileContent = readFileSync(path.resolve(root, dockerfile), "utf8");
    } catch {
      dockerfileContent = undefined;
    }
  }
  return {
    root,
    sources,
    merged: result.merged,
    grants: result.grants,
    hooks: result.hooks,
    sectionSources: result.sectionSources,
    commandSources: result.commandSources,
    ...(dotMcp !== undefined ? { dotMcp } : {}),
    ...(dockerfileContent !== undefined ? { dockerfileContent } : {}),
  };
}

// ---- 程序状态目录与 .pigeon/.gitignore ----

// 第一次建 .pigeon/state/ 或 settings.local.json 时调用：.pigeon/.gitignore 不存在即写入两行；已存在不改，缺这两行时
// 经 notice 提示一行（缺省标准错误输出）
export function ensurePigeonGitignore(
  root: string,
  notice: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): void {
  const file = projectPigeonGitignorePath(root);
  if (!existsSync(file)) {
    mkdirSync(projectPigeonDir(root), { recursive: true });
    writeFileSync(file, `${PIGEON_GITIGNORE_LINES.join("\n")}\n`);
    return;
  }
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim());
  } catch {
    return;
  }
  const missing = PIGEON_GITIGNORE_LINES.filter((line) => !lines.includes(line));
  if (missing.length > 0) {
    notice(
      `提示：${pigeonRel(".gitignore")} 里缺 ${missing.join("、")}（程序状态与个人设置不该提交，可自行补上）`
    );
  }
}

// 确保项目的程序状态目录在；第一次建时一并写 .pigeon/.gitignore
export function ensureProjectStateDir(root: string, notice?: (line: string) => void): string {
  const dir = projectStateDir(root);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    ensurePigeonGitignore(root, notice);
  }
  return dir;
}
