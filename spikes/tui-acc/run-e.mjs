// 剧本 E：运行中崩溃（taskkill /F，命中 intent→receipt 窗口）→ 重启 TUI → /sessions 待对账突出
// → /resume 对账（哈希自动确证或人工确认）→ 同 sessionId 续跑（tmp/tui-acc/ws-e）
// 校准（run-e-cal）：y → intent +2278ms；execution 窗口 +2284ms ~ +4944ms。本剧本 y+3500ms 强杀。
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { runTuiScenario } from "./tui-driver.mjs";

const root = "tmp/tui-acc/ws-e";
const sessionsDir = `${root}/.pigeon/sessions`;
const listSessions = () => readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).sort();

// 还原 big.txt 第一行（校准跑已把它改成 LINE ONE）
execFileSync(process.execPath, ["tmp/tui-acc/gen-e.mjs"], { stdio: "inherit" });

const before = listSessions();
const crash = await runTuiScenario({
  name: "e-crash",
  args: ["--root", root, "--stream-fn", "spikes/real-stream-fn.mjs"],
  steps: [
    { wait: /state: idle/, send: "big.txt 第一行是 line 1。请先用 read_file 读取 big.txt（用 limit 只看前 5 行），再用 edit_file 把第一行改成 LINE ONE，改完只回复「完成」。" },
    { wait: /批准执行？\[y\]/, snapshot: "panel", sendKey: "y", kill: 3500 },
  ],
});
const crashFile = listSessions().find((f) => !before.includes(f));
const crashSession = crashFile?.replace(/\.jsonl$/, "");

// 崩溃落点判定：intent 是否无 receipt；文件是否已写入（决定人工菜单答案）
const crashRecords = readFileSync(`${sessionsDir}/${crashFile}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const intent = crashRecords.find((r) => r.kind === "intent" && r.toolName === "edit_file");
const receipt = crashRecords.find((r) => r.kind === "receipt" && r.receipt?.executionId === intent?.executionId);
const firstLine = readFileSync(`${root}/big.txt`, "utf8").slice(0, 16).split("\n")[0];
const executedOnDisk = firstLine === "LINE ONE";
// 人工确认答案：磁盘已执行 → [1]，未执行 → [2]
const menuAnswer = executedOnDisk ? "1" : "2";

const resume = await runTuiScenario({
  name: "e-resume",
  args: ["--root", root, "--stream-fn", "spikes/real-stream-fn.mjs"],
  steps: [
    { wait: /state: idle/, send: "/sessions" },
    { wait: /条待对账（上次会话异常中断，用 resume 处理）/, snapshot: "sessions" },
    { wait: /state: idle/, send: `/resume ${crashSession}` },
    { wait: /冷恢复对账/, snapshot: "reconcile" },
    {
      wait: /请选择 \[1\/2\/3]：|模型对话上下文重新建立/,
      sendKey: (m) => (m[0].includes("请选择") ? menuAnswer : undefined),
    },
    // 人工菜单路径接下来还有「已记录/重建说明」；自动确证路径直接到重建说明——
    // 两条路径共同的下一个稳定信号是状态栏回 idle（换绑完成）
    { wait: /state: idle/, snapshot: "rebound", send: "只回复两个字：继续。不要使用任何工具。" },
    { wait: /== run: completed/, snapshot: "continued" },
  ],
});

const finalRecords = readFileSync(`${sessionsDir}/${crashFile}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const runIds = new Set(finalRecords.map((r) => r.runId).filter(Boolean));
const resolution = finalRecords.find((r) => r.kind === "resolution");
console.log(JSON.stringify({
  crashCode: crash.code, crashKilled: crash.killed,
  crashSession,
  danglingIntent: intent !== undefined && receipt === undefined,
  executedOnDisk,
  resumeCode: resume.code,
  sessionsHighlight: /条待对账/.test(resume.stripped),
  hashAuto: resume.stripped.includes("本次自动确证（哈希比对）"),
  manualMenu: resume.stripped.includes("请选择 [1/2/3]"),
  resolution: resolution ? { method: resolution.resolution?.method ?? resolution.method, outcome: resolution.resolution?.outcome ?? resolution.outcome } : null,
  distinctRunIdsInCrashSession: runIds.size,
  continuedCompleted: resume.stripped.includes("== run: completed"),
}, null, 1));
