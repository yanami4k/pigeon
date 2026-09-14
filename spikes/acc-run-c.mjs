// 路径 C：真实进程崩溃 + resume（tmp/acc-c）
// C1：审批提示挂起时强杀（死于 intent 之前：无治理记录，只有 tool.proposed 悬空）
// C2：回答 y 之后 40ms 强杀（intent+receipt 已落盘，死于后续模型轮次：无 run.ended）
// 然后对 C2 的会话 resume：冷恢复对账报告 → 进入 REPL 在同一会话再跑一个 Run → :quit
import { readdirSync } from "node:fs";
import { runScenario } from "./acc-driver.mjs";

const sessionsDir = "tmp/acc-c/.pigeon/sessions";
const listSessions = () => readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).sort();

const c1 = await runScenario({
  name: "C1 审批挂起时崩溃",
  args: ["--root", "tmp/acc-c", "--stream-fn", "spikes/real-stream-fn.mjs"],
  logPath: "tmp/acc-c1.log",
  steps: [
    { wait: /pigeon> /, send: "notes.txt 第二行 twoo 是错别字，请用 read_file 读后用 edit_file 改成 two，改完只回复「完成」。" },
    { wait: /批准执行？\[y\]/, kill: 200 },
  ],
});
const afterC1 = listSessions();

const c2 = await runScenario({
  name: "C2 批准后立即崩溃",
  args: ["--root", "tmp/acc-c", "--stream-fn", "spikes/real-stream-fn.mjs"],
  logPath: "tmp/acc-c2.log",
  steps: [
    { wait: /pigeon> /, send: "notes.txt 第二行 twoo 是错别字，请用 read_file 读后用 edit_file 改成 two，改完只回复「完成」。" },
    { wait: /批准执行？\[y\]/, send: "y" },
    { wait: /批准执行？\[y\][^\n]*\n/, kill: 40 },
  ],
});
const afterC2 = listSessions();
const c2Session = afterC2.find((f) => !afterC1.includes(f))?.replace(/\.jsonl$/, "");

const resume = await runScenario({
  name: "C3 resume C2 会话并续跑一个 Run",
  args: ["resume", c2Session, "--root", "tmp/acc-c", "--stream-fn", "spikes/real-stream-fn.mjs"],
  logPath: "tmp/acc-c3.log",
  steps: [
    { wait: /pigeon> /, send: "请用 read_file 读 notes.txt，确认第二行现在是什么，只回复该行内容。" },
    { wait: /终态：completed/, send: ":quit" },
  ],
});
console.log(JSON.stringify({ c1: c1.signal ?? c1.code, c2: c2.signal ?? c2.code, c2Session, resume: resume.code, sessions: afterC2 }));
