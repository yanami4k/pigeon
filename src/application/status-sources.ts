// 开工状态块的来源（决策 363、354）：环境看板（工作目录、操作系统与 shell、沙箱档位、检测到的语言环境与依赖目录、
// 网络是否可用（确知时）、git 分支与当前提交、有无未提交改动、日期）与"取工作区 git 状态"的接口。
// git 状态只在写档或命令档工具之后重取（由调用方决定何时重取）；具体改了哪些文件不进看板（由工具结果交代）。
// 取 git 状态的实现本段先用简单做法：一次 git --no-optional-locks status --porcelain=v2 --branch（分支、当前提交、
// 有无未提交改动，不看被忽略的文件与 Pigeon 自己的程序状态；不顺手刷新索引、不抢索引锁）。取不到时如实写原因
//（没装 git、仓库属主不符被 git 拒绝、超时等），只有 git 说不是仓库时才写不是 git 仓库。run_command 的文件变化报告改由 git 找候选（决策 348）之后，
// 换成复用它已取的状态，接口不变。
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { PROGRAM_OWNED_PATHS } from "../state/paths.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";

export type GitWorkspaceState =
  | { kind: "none" }
  // 取不到（原因是给模型看的一句）
  | { kind: "unavailable"; reason: string }
  | {
      kind: "repo";
      // 分离 HEAD 时缺省
      branch?: string;
      // 还没有提交时缺省
      commit?: string;
      dirty: boolean;
    };

// 取工作区状态的接口：git 状态与工作区根下的条目名（检测语言环境用）
export interface WorkspaceStatusProbe {
  gitState(): Promise<GitWorkspaceState>;
  rootEntries(): Promise<readonly string[]>;
}

const GIT_TIMEOUT_MS = 10_000;
// git 的报错按英文原文归类（不随系统语言变）
const GIT_ENV = { LC_ALL: "C" };

// 不看 Pigeon 自己的程序状态（会话文件在变不算工作区有改动）
export const GIT_STATUS_ARGS: readonly string[] = [
  "--no-optional-locks",
  "status",
  "--porcelain=v2",
  "--branch",
  "--untracked-files=normal",
  "--",
  ".",
  ...PROGRAM_OWNED_PATHS.map((owned) => `:(exclude)${owned}`),
];

export function parseGitStatus(output: string): GitWorkspaceState {
  let branch: string | undefined;
  let commit: string | undefined;
  let dirty = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      commit = oid === "(initial)" ? undefined : oid.slice(0, 12);
    } else if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head === "(detached)" ? undefined : head;
    } else if (line.trim() !== "" && !line.startsWith("#")) {
      dirty = true;
    }
  }
  return {
    kind: "repo",
    ...(branch !== undefined ? { branch } : {}),
    ...(commit !== undefined ? { commit } : {}),
    dirty,
  };
}

// git 没有成功时按情形归类：不是仓库、没装 git、超时、仓库属主不符，其余取 git 报错的第一行
export function gitFailure(failure: {
  missing?: boolean;
  timedOut?: boolean;
  stderr: string;
}): GitWorkspaceState {
  if (failure.missing === true) {
    return { kind: "unavailable", reason: "没有装 git（找不到 git 程序）" };
  }
  if (failure.timedOut === true) {
    return { kind: "unavailable", reason: `git status 超过 ${GIT_TIMEOUT_MS / 1000} 秒没有结束` };
  }
  if (/not a git repository/i.test(failure.stderr)) {
    return { kind: "none" };
  }
  if (/dubious ownership/i.test(failure.stderr)) {
    return {
      kind: "unavailable",
      reason: "仓库属主与当前用户不同，git 拒绝读取（dubious ownership；需把该目录加进 safe.directory）",
    };
  }
  const line = failure.stderr
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => text !== "");
  return {
    kind: "unavailable",
    reason: line !== undefined ? `git 报错：${line.slice(0, 200)}` : "git status 没有成功，也没有报错输出",
  };
}

// 本机工作区
export function localStatusProbe(root: string): WorkspaceStatusProbe {
  return {
    gitState: () =>
      new Promise((resolve) => {
        execFile(
          "git",
          [...GIT_STATUS_ARGS],
          {
            cwd: root,
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
            env: { ...process.env, ...GIT_ENV },
          },
          (error, stdout, stderr) =>
            resolve(
              error === null
                ? parseGitStatus(stdout)
                : gitFailure({
                    missing: (error as NodeJS.ErrnoException).code === "ENOENT",
                    timedOut: error.killed === true,
                    stderr: String(stderr ?? ""),
                  })
            )
        );
      }),
    rootEntries: async () => {
      try {
        return await readdir(root);
      } catch {
        return [];
      }
    },
  };
}

// 执行端另一侧的工作区（容器）：经执行端在工作区根执行
export function hostStatusProbe(host: WorkspaceHost): WorkspaceStatusProbe {
  const exec = (program: string, args: readonly string[]) =>
    host.exec(
      { program, args: [...args], verbatim: false },
      { env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 1024 * 1024, signal: undefined }
    );
  return {
    gitState: async () => {
      try {
        const result = await exec("git", GIT_STATUS_ARGS);
        if (result.spawned && result.exitCode === 0 && !result.timedOut) {
          return parseGitStatus(result.stdout);
        }
        return gitFailure({
          missing: !result.spawned && result.spawnError?.code === "ENOENT",
          timedOut: result.timedOut,
          stderr: result.stderr,
        });
      } catch (error) {
        return {
          kind: "unavailable",
          reason: `执行端出错：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    rootEntries: async () => {
      try {
        const result = await exec("ls", ["-A"]);
        return result.spawned && result.exitCode === 0
          ? result.stdout.split("\n").filter((name) => name !== "")
          : [];
      } catch {
        return [];
      }
    },
  };
}

// 认得出的语言环境：工作区根下的项目文件 → 语言名；依赖目录在不在一并写出
const LANGUAGES: ReadonlyArray<{
  name: string;
  markers: readonly string[];
  deps: readonly string[];
}> = [
  { name: "Node.js", markers: ["package.json"], deps: ["node_modules"] },
  {
    name: "Python",
    markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
    deps: [".venv", "venv"],
  },
  { name: "Rust", markers: ["Cargo.toml"], deps: ["target"] },
  { name: "Go", markers: ["go.mod"], deps: ["vendor"] },
  { name: "Java", markers: ["pom.xml", "build.gradle", "build.gradle.kts"], deps: [] },
  { name: "Ruby", markers: ["Gemfile"], deps: ["vendor"] },
  { name: "PHP", markers: ["composer.json"], deps: ["vendor"] },
];

export function languageLine(entries: readonly string[]): string {
  const present = new Set(entries);
  const found = LANGUAGES.flatMap((language) => {
    const markers = language.markers.filter((marker) => present.has(marker));
    return markers.length > 0 ? [{ language, markers }] : [];
  });
  if (found.length === 0) {
    return "语言环境：没有认出（工作区根下没有常见的项目文件）";
  }
  const deps = [
    ...new Set(found.flatMap(({ language }) => language.deps.filter((dep) => present.has(dep)))),
  ];
  return (
    `语言环境：${found.map(({ language, markers }) => `${language.name}（${markers.join("、")}）`).join("、")}；` +
    `依赖目录：${deps.length > 0 ? deps.join("、") : "没有"}`
  );
}

const OS_NAMES: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  linux: "Linux",
  win32: "Windows",
  darwin: "macOS",
};

// 入口给出的确知事实：沙箱档位与网络（不知道网络能不能用时不给）
export interface StatusFacts {
  sandbox?: string;
  network?: string;
}

export function environmentText(input: {
  root: string;
  platform: NodeJS.Platform;
  // 工作区在执行端另一侧（容器）
  remote: boolean;
  entries: readonly string[];
  facts?: StatusFacts;
}): string {
  const os = OS_NAMES[input.platform] ?? input.platform;
  const shell = input.platform === "win32" ? "cmd.exe" : "/bin/sh -c";
  return [
    `工作目录：${input.root}`,
    `操作系统：${os}${input.remote ? "（容器内）" : ""}；需要 shell 的命令经 ${shell} 执行`,
    `沙箱：${input.facts?.sandbox ?? "不在沙箱里（命令直接在本机执行）"}`,
    languageLine(input.entries),
    ...(input.facts?.network !== undefined ? [`网络：${input.facts.network}`] : []),
  ].join("\n");
}

export function gitText(state: GitWorkspaceState): string {
  if (state.kind === "none") {
    return "不是 git 仓库。";
  }
  if (state.kind === "unavailable") {
    return `取不到 git 状态：${state.reason}`;
  }
  const where = state.branch !== undefined ? `分支 ${state.branch}` : "分离 HEAD（不在任何分支上）";
  const commit = state.commit !== undefined ? `当前提交 ${state.commit}` : "还没有提交";
  return `${where}，${commit}；工作区${state.dirty ? "有" : "没有"}未提交的改动`;
}

export function dateText(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `今天是 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}（本地时间）`;
}
