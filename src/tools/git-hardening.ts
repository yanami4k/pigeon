// Pigeon 自己在后台起的 git 统一加固（决策 348、352）：文件变化的取证、代码快照、退出快照、设置层的跟踪检查等都经这一处。
// - 关掉 fsmonitor（core.fsmonitor 可配成任意命令）与钩子（core.hooksPath 指向不存在的目录）；
// - git 支持时以空树作属性来源（--attr-source）：工作区与仓库里 .gitattributes 指派的过滤（clean / smudge / process，
//   命令配在 .git/config 里，可能指向写工具改得到的脚本）在重算哈希、暂存时不再执行。空树的编号随仓库的对象格式
//   （SHA-1 / SHA-256）不同，按仓库算出（git hash-object -t tree --stdin，不写入对象库），本进程内按目录缓存；
//   不是仓库、算不出或 git 不认 --attr-source 时只有前两项。
// 这些都是全局选项，放在子命令之前。容器里的取证脚本按同一张表拼出自己的参数、在容器里按仓库算空树（execution/container-host.ts）
import { execFileSync } from "node:child_process";

export const NO_HOOKS_PATH = "/nonexistent/pigeon-no-hooks";
export const GIT_HARDENING_CONFIG: readonly string[] = [
  "-c",
  "core.fsmonitor=",
  "-c",
  `core.hooksPath=${NO_HOOKS_PATH}`,
];

// 目录 → 该处仓库可用的 --attr-source 参数（不可用为 null）
const attrSources = new Map<string, string | null>();

function attrSourceOf(cwd: string): string | null {
  const cached = attrSources.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  let arg: string | null = null;
  try {
    const tree = execFileSync(
      "git",
      [...GIT_HARDENING_CONFIG, "hash-object", "-t", "tree", "--stdin"],
      {
        cwd,
        input: "",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 10_000,
        windowsHide: true,
      }
    ).trim();
    if (/^[0-9a-f]{40,64}$/.test(tree)) {
      const candidate = `--attr-source=${tree}`;
      execFileSync("git", [candidate, "version"], {
        cwd,
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      });
      arg = candidate;
    }
  } catch {
    arg = null;
  }
  attrSources.set(cwd, arg);
  return arg;
}

// 加在 git 与子命令之间的加固参数；cwd 为这条 git 的工作目录（据它定仓库与空树的编号）
export function hardenedGitArgs(cwd: string): string[] {
  const attrSource = attrSourceOf(cwd);
  return [...(attrSource !== null ? [attrSource] : []), ...GIT_HARDENING_CONFIG];
}
