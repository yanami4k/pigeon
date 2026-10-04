// Pigeon 自己在后台起的 git 统一加固（决策 348、352）：文件变化的取证、代码快照、退出快照、设置层的跟踪检查等都经这一处。
// - 关掉 fsmonitor（core.fsmonitor 可配成任意命令）与钩子（core.hooksPath 指向不存在的目录）；
// - git 支持时以空树作属性来源（--attr-source）：工作区与仓库里 .gitattributes 指派的过滤（clean / smudge / process，
//   命令配在 .git/config 里）在重算哈希、暂存时不再执行。不认 --attr-source 的较旧 git 只有前两项。
// 这些都是全局选项，放在子命令之前。容器里的取证脚本按同一张表拼出自己的参数（execution/container-host.ts）
import { execFileSync } from "node:child_process";

// 空树对象：git 内置，任何仓库里都可用（SHA-1 仓库）
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const NO_HOOKS_PATH = "/nonexistent/pigeon-no-hooks";
export const GIT_HARDENING_CONFIG: readonly string[] = [
  "-c",
  "core.fsmonitor=",
  "-c",
  `core.hooksPath=${NO_HOOKS_PATH}`,
];
export const GIT_ATTR_SOURCE_ARG = `--attr-source=${EMPTY_TREE}`;

let attrSourceSupported: boolean | undefined;

// 本进程里的 git 认不认 --attr-source（探测一次）
function supportsAttrSource(): boolean {
  if (attrSourceSupported === undefined) {
    try {
      execFileSync("git", [GIT_ATTR_SOURCE_ARG, "version"], {
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      });
      attrSourceSupported = true;
    } catch {
      attrSourceSupported = false;
    }
  }
  return attrSourceSupported;
}

// 加在 git 与子命令之间的加固参数
export function hardenedGitArgs(): string[] {
  return [...(supportsAttrSource() ? [GIT_ATTR_SOURCE_ARG] : []), ...GIT_HARDENING_CONFIG];
}
