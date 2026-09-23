// 测试夹具：本机 sh 实现的 StreamShell，与容器里同一批脚本在临时目录里真跑。只供测试使用。
import { spawn } from "node:child_process";
import type { ShellResult, StreamShell } from "./stream-workspace.ts";

// Windows 宿主上 PATH 里的 timeout 会先命中系统自带的同名程序，把 coreutils 所在的 /usr/bin 提到最前
// （容器里本来就是 coreutils）；末尾显式 exit，否则 sh 直接 exec 最后一条命令，MSYS 下被信号杀掉的退出码
// 会编码成 2304 一类的值
export function localStreamShell(root: string): StreamShell {
  return {
    root,
    sh(script, options = {}) {
      return new Promise<ShellResult>((resolve, reject) => {
        const body = `export PATH="/usr/bin:$PATH"\n${script}\nexit $?`;
        const child = spawn("sh", ["-c", body, "sh", ...(options.args ?? [])], {
          cwd: options.cwd ?? root,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => out.push(c));
        child.stderr.on("data", (c: Buffer) => err.push(c));
        child.on("error", reject);
        child.on("close", (code) => {
          const stdoutBytes = Buffer.concat(out);
          resolve({
            exitCode: code,
            stdout: stdoutBytes.toString("utf8"),
            stdoutBytes,
            stderr: Buffer.concat(err).toString("utf8"),
          });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(options.stdin ?? "");
      });
    },
  };
}
