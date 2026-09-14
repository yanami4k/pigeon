// 验收驱动（脚本在 spikes/ 入库；产出写 tmp/ 不入库）：起 CLI 子进程，按"等 stdout 出现正则 → 写一行 stdin"的步骤表交互。
// 步骤形状：{ wait: RegExp, send?: string | ((match) => string), kill?: number }
//   wait 命中后：send 存在则写入一行；kill 存在则在 kill 毫秒后强杀子进程（模拟崩溃）；
//   两者可同时给（先写入再定时强杀 = "批准后立即崩溃"的形态）。
// 全程 stdout/stderr 原样落到日志文件，供审计文档摘录。密钥经环境变量透传，不打印。
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

export function runScenario({ name, args, steps, logPath, timeoutMs = 180_000 }) {
  writeFileSync(logPath, `=== ${name} ===\n$ node src/cli/index.ts ${args.join(" ")}\n`, "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli/index.ts", ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let cursor = 0;
    let stepIndex = 0;
    let killed = false;
    let killScheduled = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name}: 超时（步骤 ${stepIndex}/${steps.length}）`));
    }, timeoutMs);

    const tryAdvance = () => {
      while (stepIndex < steps.length) {
        const step = steps[stepIndex];
        const haystack = buffer.slice(cursor);
        const match = step.wait.exec(haystack);
        if (match === null) {
          return;
        }
        cursor += match.index + match[0].length;
        stepIndex += 1;
        const line = typeof step.send === "function" ? step.send(match) : step.send;
        if (line !== undefined) {
          appendFileSync(logPath, `\n[驱动 → stdin] ${line}\n`, "utf8");
          child.stdin.write(`${line}\n`);
        }
        if (step.kill !== undefined) {
          killScheduled = true;
          setTimeout(() => {
            killed = true;
            appendFileSync(logPath, `\n[驱动] 强杀子进程（模拟崩溃，距上一步 ${step.kill}ms）\n`, "utf8");
            child.kill("SIGKILL");
          }, step.kill);
          return;
        }
      }
      // 步骤用尽：关 stdin（EOF），REPL 正常退出
      child.stdin.end();
    };

    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      buffer += text;
      appendFileSync(logPath, text, "utf8");
      tryAdvance();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      appendFileSync(logPath, `\n[退出] code=${code} signal=${signal}\n`, "utf8");
      if (!killed && !killScheduled && stepIndex < steps.length) {
        reject(new Error(`${name}: 进程提前退出，步骤 ${stepIndex}/${steps.length}`));
        return;
      }
      resolve({ code, signal, killed, output: buffer });
    });
    child.on("error", reject);
  });
}
