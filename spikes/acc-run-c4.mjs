// 路径 C 续：C4 批准后 1500ms 强杀 → C5 resume 同一会话续跑
import { readdirSync } from "node:fs";
import { runScenario } from "./acc-driver.mjs";
const sessionsDir = "tmp/acc-c/.pigeon/sessions";
const listSessions = () => readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).sort();
const before = listSessions();
const c4 = await runScenario({
  name: "C4 批准后 1500ms 崩溃",
  args: ["--root", "tmp/acc-c", "--stream-fn", "spikes/real-stream-fn.mjs"],
  logPath: "tmp/acc-c4.log",
  steps: [
    { wait: /pigeon> /, send: "notes.txt 第二行 twoo 是错别字，请用 read_file 读后用 edit_file 改成 two，改完只回复「完成」。" },
    { wait: /批准执行？\[y\]/, send: "y", kill: 1500 },
  ],
});
const c4Session = listSessions().find((f) => !before.includes(f))?.replace(/\.jsonl$/, "");
const resume = await runScenario({
  name: "C5 resume C4 会话并续跑一个 Run",
  args: ["resume", c4Session, "--root", "tmp/acc-c", "--stream-fn", "spikes/real-stream-fn.mjs"],
  logPath: "tmp/acc-c5.log",
  steps: [
    { wait: /pigeon> /, send: "请用 read_file 读 notes.txt，确认第二行现在是什么，只回复该行内容。" },
    { wait: /终态：completed/, send: ":quit" },
  ],
});
console.log(JSON.stringify({ c4: c4.signal ?? c4.code, c4Session, resume: resume.code }));
