// 按环境只注册用得上的工具（决策 359）：会话开始时做几项便宜的本地检查——PATH 里有没有 docker 可执行文件、工作区是不是
// git 仓库、本会话所在的会话树以外有没有会话——不连 docker、不发请求；另记搜索后端可不可用。结果随开局冻结的内容沿用到
// /reload（一次会话内工具清单固定），新开会话重查；key 与 PATH 取自进程环境，改了要重启进程才生效。没注册的工具与原因记进
// Run 开始条目。
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { sessionFamily } from "../memory/session-search.ts";
import { isGitWorkspace } from "../orchestration/checkpoint.ts";
import { listSessionFiles, readSessionHeader } from "../persistence/session-reader.ts";

// 各项检查的结果；只查用得上的，没查的缺省
export interface ToolEnvironment {
  dockerOnPath?: boolean;
  gitWorkspace?: boolean;
  sessionHistory?: boolean;
  webSearch?: boolean;
}

export interface SkippedTools {
  tools: string[];
  reason: string;
}

// PATH 里有没有该可执行文件：只看 PATH 里的绝对目录，Windows 认 .exe，其余平台要有执行权限
export function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const file = platform === "win32" ? `${name}.exe` : name;
  return pathValue.split(path.delimiter).some((dir) => {
    if (!path.isAbsolute(dir)) {
      return false;
    }
    try {
      accessSync(path.join(dir, file), platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// 会话检索能不能搜到东西：与检索同一口径，排除本会话所在的整棵会话树（决策 339）；只读文件头，没有合法文件头的（空文件、
// 写了一半）不算
export function hasSessionHistory(
  sessionsDir: string,
  current: { sessionId: string; parentSessionId?: string }
): boolean {
  const parentOf = new Map<string, string | undefined>();
  for (const file of listSessionFiles(sessionsDir)) {
    const header = file.sessionId === current.sessionId ? undefined : readSessionHeader(file.path);
    if (header !== undefined) {
      parentOf.set(file.sessionId, header.parentSessionId);
    }
  }
  parentOf.set(current.sessionId, current.parentSessionId);
  const family = sessionFamily(current.sessionId, parentOf);
  return [...parentOf.keys()].some((id) => !family.has(id));
}

// 按需检查：已有结果的（/reload 沿用开局的）不重查
export function toolEnvironmentProbe(input: {
  frozen?: ToolEnvironment;
  governanceRoot: string;
  sessionsDir: string;
  current: { sessionId: string; parentSessionId?: string };
  searchBackend: boolean;
  env?: NodeJS.ProcessEnv;
}): { check: (key: keyof ToolEnvironment) => boolean; result: () => ToolEnvironment } {
  const environment: ToolEnvironment = { ...input.frozen };
  const probes: Record<keyof ToolEnvironment, () => boolean> = {
    dockerOnPath: () => executableOnPath("docker", input.env),
    gitWorkspace: () => isGitWorkspace(input.governanceRoot),
    sessionHistory: () => hasSessionHistory(input.sessionsDir, input.current),
    webSearch: () => input.searchBackend,
  };
  return {
    check: (key) => {
      environment[key] ??= probes[key]();
      return environment[key];
    },
    result: () => ({ ...environment }),
  };
}
