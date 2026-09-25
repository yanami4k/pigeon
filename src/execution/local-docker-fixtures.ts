// 测试夹具：在本机执行命令的假 docker CLI——exec 在 -w 给出的目录里直接运行（该目录即"容器内"工作区），其余子命令
// 直接成功。容器执行端经它驱动，撤回、验证等跨边界的逻辑因而能对着真实的 git 与 shell 验证。只供测试使用。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { createContainerWorkspaceHost } from "./container-host.ts";

const LOCAL_DOCKER = `
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] !== "exec") process.exit(0);
let i = 1;
let cwd = process.cwd();
let interactive = false;
for (;;) {
  if (args[i] === "-i") { interactive = true; i++; continue; }
  if (args[i] === "-w") {
    cwd = args[i + 1];
    // Windows 宿主：工作区根以 MSYS 形式交来（与容器内 readlink 的结果同形），作工作目录前转回 Windows 路径
    if (process.platform === "win32" && cwd.startsWith("/")) {
      cwd = spawnSync("sh", ["-c", 'cygpath -w "$1"', "sh", cwd]).stdout.toString().trim();
    }
    i += 2;
    continue;
  }
  if (args[i] === "-e") { i += 2; continue; }
  // 以哪个用户执行：本机照常以当前用户执行
  if (args[i] === "-u") { i += 2; continue; }
  break;
}
let [program, ...rest] = args.slice(i + 1);
// 容器里的 /bin/sh 在 Windows 宿主上对应 PATH 里的 sh
if (program === "/bin/sh" && process.platform === "win32") program = "sh";
// Windows 宿主上 PATH 里的 find、timeout 会先命中系统自带的同名程序：sh -c 的脚本前把 coreutils 所在的 /usr/bin 提到最前
// （容器里本来就是 coreutils）
if (process.platform === "win32" && (program === "sh" || program === "/bin/sh") && rest[0] === "-c") {
  rest[1] = 'export PATH="/usr/bin:$PATH"\\n' + rest[1];
}
const r = spawnSync(program, rest, { cwd, stdio: [interactive ? "inherit" : "ignore", "inherit", "inherit"] });
if (r.error) { process.stderr.write("OCI runtime exec failed: exec failed: " + r.error.message + ": no such file or directory\\n"); process.exit(127); }
process.exit(r.status ?? 1);
`;

// 以 root 目录为"容器内"工作区的容器执行端；另给出 docker 调用前缀与"容器内"工作区根，供自行创建执行端的调用方注入
export function localDockerHost(root: string): {
  host: WorkspaceHost;
  docker: string[];
  containerRoot: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-local-docker-"));
  const script = join(dir, "docker.mjs");
  writeFileSync(script, LOCAL_DOCKER);
  // Windows 宿主上"容器内"的路径形式是 MSYS 的（readlink 给出的形式），工作区根也取这一形式，路径围栏才比得对
  const containerRoot =
    process.platform === "win32"
      ? execFileSync("sh", ["-c", 'cd -- "$1" && readlink -f .', "sh", root], {
          encoding: "utf8",
        }).trim()
      : root;
  const docker = [process.execPath, script];
  return {
    host: createContainerWorkspaceHost({ container: "box", root: containerRoot, docker }),
    docker,
    containerRoot,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
