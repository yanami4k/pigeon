// 按环境只注册用得上的工具（决策 359）：会话开始时做几项便宜的本地检查——PATH 里有没有 docker 可执行文件、工作区是不是
// git 仓库、本项目有没有本会话以外的会话——不连 docker、不发请求。结果随开局冻结的内容沿用到 /reload（一次会话内工具清单
// 固定），下次会话重查。没注册的工具与原因记进 Run 开始条目。
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { isGitWorkspace } from "../orchestration/checkpoint.ts";
import { listSessionFiles } from "../persistence/session-reader.ts";

// 各项检查的结果；只查用得上的，没查的缺省
export interface ToolEnvironment {
  dockerOnPath?: boolean;
  gitWorkspace?: boolean;
  sessionHistory?: boolean;
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

// 按需检查：已有结果的（/reload 沿用开局的）不重查
export function toolEnvironmentProbe(input: {
  frozen?: ToolEnvironment;
  governanceRoot: string;
  sessionsDir: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): { check: (key: keyof ToolEnvironment) => boolean; result: () => ToolEnvironment } {
  const environment: ToolEnvironment = { ...input.frozen };
  const probes: Record<keyof ToolEnvironment, () => boolean> = {
    dockerOnPath: () => executableOnPath("docker", input.env),
    gitWorkspace: () => isGitWorkspace(input.governanceRoot),
    sessionHistory: () =>
      listSessionFiles(input.sessionsDir).some((file) => file.sessionId !== input.sessionId),
  };
  return {
    check: (key) => {
      environment[key] ??= probes[key]();
      return environment[key];
    },
    result: () => ({ ...environment }),
  };
}
