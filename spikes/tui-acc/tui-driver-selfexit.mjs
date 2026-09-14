// TUI 验收驱动自退出变体（脚本在 spikes/ 入库；产出写 tmp/ 不入库；剧本 G 用，expectSelfExit=true 时步骤用尽不关桥 stdin）：经 PtyHost.exe（ConPTY）起 TUI 子进程，按
// "剥离 ANSI 后的输出流出现正则 → 写输入"的步骤表交互；支持定时强杀（模拟崩溃）。
// 步骤形状：
//   { wait: RegExp, send?: string | ((m)=>string), sendKey?: string, kill?: number, snapshot?: string }
//   send  写一行（自动补 \r 回车）；sendKey 写原始字节（单键，如 "y"、"\x1b"）；
//   kill  命中后在 kill 毫秒时 taskkill /F 子进程（真实崩溃）；snapshot 落一张虚拟屏快照。
// 产物（均在 tmp/tui-acc/）：
//   <name>.raw.log   原始 ANSI 输出流（含驱动注入的时间/输入标记）
//   <name>.log       剥离 ANSI 的输出流（人读）
//   <name>.screen.<label>.txt  虚拟屏快照（VirtualScreen 仿真，含 scrollback）
//   <name>.chunks.log  stdout 分块到达时间线（流式生长的时序证据）
// 结束：步骤用尽后关闭桥 stdin → 桥发 CTRL_C_EVENT → TUI 优雅退出。
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { VirtualScreen } from "../../src/tui/testing.ts";

const COLS = 100;
const ROWS = 30;

// ANSI 剥离（CSI / OSC / 单字符序列）
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?><!]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()#][0-9A-Za-z]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\x1b/g, "");
}

export function runTuiScenario({ name, args, steps, timeoutMs = 240_000, expectSelfExit = false }) {
  const base = `tmp/tui-acc/${name}`;
  const rawPath = `${base}.raw.log`;
  const logPath = `${base}.log`;
  const chunksPath = `${base}.chunks.log`;
  const pidPath = `${base}.pid`;
  writeFileSync(rawPath, `=== ${name} ===\n$ PtyHost ${COLS}x${ROWS} node src/tui/main.ts ${args.join(" ")}\n`, "utf8");
  writeFileSync(logPath, "", "utf8");
  writeFileSync(chunksPath, "", "utf8");
  const screen = new VirtualScreen(COLS, ROWS);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(
      "spikes/tui-acc/PtyHost.exe",
      [String(COLS), String(ROWS), pidPath, "--", process.execPath, "src/tui/main.ts", ...args],
      { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stripped = "";
    let cursor = 0;
    let stepIndex = 0;
    let killed = false;
    let killScheduled = false;
    const timer = setTimeout(() => {
      killChild();
      reject(new Error(`${name}: 超时（步骤 ${stepIndex}/${steps.length}）`));
    }, timeoutMs);

    const elapsed = () => Date.now() - startedAt;
    const snapshot = (label) => {
      const text = screen.contentLines().join("\n");
      writeFileSync(`${base}.screen.${label}.txt`, text + "\n", "utf8");
      appendFileSync(logPath, `\n[快照] ${label} @${elapsed()}ms → ${base}.screen.${label}.txt\n`, "utf8");
    };
    const killChild = () => {
      try {
        const pid = readFileSync(pidPath, "utf8").trim();
        spawn("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
      } catch { /* pid 文件可能还没出现 */ }
    };

    const tryAdvance = () => {
      while (stepIndex < steps.length) {
        const step = steps[stepIndex];
        // 定时快照步：不等输出，调度即过（用于流式中途抓屏）
        if (step.snapshotAfterMs !== undefined) {
          const label = step.snapshot ?? `t${step.snapshotAfterMs}`;
          setTimeout(() => snapshot(label), step.snapshotAfterMs);
          stepIndex += 1;
          continue;
        }
        const match = step.wait.exec(stripped.slice(cursor));
        if (match === null) return;
        cursor += match.index + match[0].length;
        stepIndex += 1;
        if (step.snapshot) snapshot(step.snapshot);
        const line = typeof step.send === "function" ? step.send(match) : step.send;
        if (line !== undefined) {
          appendFileSync(logPath, `\n[驱动 → 输入行 @${elapsed()}ms] ${line}\n`, "utf8");
          child.stdin.write(`${line}\r`);
        }
        if (step.sendKey !== undefined) {
          const key = typeof step.sendKey === "function" ? step.sendKey(match) : step.sendKey;
          if (key !== undefined) {
            appendFileSync(logPath, `\n[驱动 → 单键 @${elapsed()}ms wall=${new Date().toISOString()}] ${JSON.stringify(key)}\n`, "utf8");
            child.stdin.write(key);
          }
        }
        if (step.kill !== undefined) {
          killScheduled = true;
          setTimeout(() => {
            killed = true;
            appendFileSync(logPath, `\n[驱动] taskkill /F 子进程（模拟崩溃，距上一步 ${step.kill}ms，实际 @${elapsed()}ms）\n`, "utf8");
            killChild();
          }, step.kill);
          return;
        }
      }
      // 自退出变体（剧本 G）：步骤用尽后不关桥 stdin——TUI 由自身退出路径（/quit、双击 Ctrl+C）
      // 结束进程，退出码即 TUI 自己的 process.exit 码；桥的 CTRL_C_EVENT 不再介入
      if (!expectSelfExit) child.stdin.end();
    };

    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk) => {
      appendFileSync(rawPath, chunk, "utf8");
      appendFileSync(chunksPath, `+${elapsed()}ms ${chunk.length}B\n`, "utf8");
      // StringDecoder 拼接跨块的多字节字符（逐块 toString 会在块界产生 U+FFFD 假错位）
      const text = decoder.write(chunk);
      screen.feed(text);
      stripped += stripAnsi(text);
      appendFileSync(logPath, stripAnsi(text), "utf8");
      tryAdvance();
    });
    child.stderr.on("data", (chunk) => {
      appendFileSync(rawPath, `\n[桥 stderr] ${chunk.toString("utf8")}`, "utf8");
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      snapshot("exit");
      appendFileSync(logPath, `\n[退出] code=${code} signal=${signal} killed=${killed}\n`, "utf8");
      if (!expectSelfExit && !killed && !killScheduled && stepIndex < steps.length) {
        reject(new Error(`${name}: 进程提前退出，步骤 ${stepIndex}/${steps.length}`));
        return;
      }
      resolve({ code, signal, killed, stripped, screenText: () => screen.contentLines().join("\n") });
    });
    child.on("error", reject);
  });
}
