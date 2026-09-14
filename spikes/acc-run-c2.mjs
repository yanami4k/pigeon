// 路径 C 续：C2 批准后 1500ms 强杀（intent+receipt 已落盘，死于模型收尾轮次）→ C3 resume 同一会话续跑
import { readdirSync } from "node:fs";
import { runScenario } from "./acc-driver.mjs";
const sessionsDir = "tmp/acc-c/.pigeon/sessions";
const listSessions = () => readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).sort();
const before = listSessions();
const c2 = await runScenario({
  name: "C2 批准后立即崩溃",
  args: ["--root", "tmp/acc-c", "--stream-fn", "spikes/real-stream-fn.mjs"],
  logPath: "tmp/acc-c2.log",
  steps: [
    { wait: /pigeon> /, send: "notes.txt 第二行 twoo 是错别字，请用 read_file 读后用 edit_file 改成 two，改完只回复「完成」。" },
    { wait: /批准执行？\[y\]/, send: "y", kill: 1500 },
  ],
});
const c2Session = listSessions().find((f) => !before.includes(f))?.replace(/\.jsonl$/, "");
const resume = await runScenario({
  name: "C3 resume C2 会话并续跑一个 Run",
  args: ["resume", c2Session, "--root", "tmp/acc-c", "--stream-fn", "spikes/real-stream-fn.mjs"],
  logPath: "tmp/acc-c3.log",
  steps: [
    { wait: /pigeon> /, send: "请用 read_file 读 notes.txt，确认第二行现在是什么，只回复该行内容。" },
    { wait: /终态：completed/, send: ":quit" },
  ],
});
console.log(JSON.stringify({ c2: c2.signal ?? c2.code, c2Session, resume: resume.code }));
