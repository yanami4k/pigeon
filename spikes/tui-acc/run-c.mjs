// 剧本 C：[a] 放权 → 第二次写调用免审（approvedBy=human:grant）→ /grants 命中计数（tmp/tui-acc/ws-c）
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { runTuiScenario } from "./tui-driver.mjs";

const root = "tmp/tui-acc/ws-c";
mkdirSync(root, { recursive: true });
writeFileSync(`${root}/hello.txt`, "hello worlld\nthis file has a typo\n", "utf8");
writeFileSync(`${root}/second.txt`, "keep alpha\nkeep beta\n", "utf8");

const result = await runTuiScenario({
  name: "c-grant",
  args: ["--root", root, "--stream-fn", "spikes/real-stream-fn.mjs"],
  steps: [
    { wait: /state: idle/, send: "hello.txt 第一行有个错别字 worlld，请用 read_file 读后用 edit_file 改成 world，改完只回复「完成」。" },
    { wait: /批准执行？\[y\]/, snapshot: "panel", sendKey: "a" },
    { wait: /已创建会话放权 (grant_[0-9A-Z]+)/, snapshot: "granted" },
    { wait: /== run: completed/ },
    { wait: /state: idle/, send: "请用 read_file 读 second.txt，再用 edit_file 把第二行的 beta 改成 BETA，改完只回复「完成」。" },
    { wait: /== run: completed/, snapshot: "second-run" },
    { wait: /state: idle/, send: "/grants" },
    { wait: /命中 [1-9]\d* 次/, snapshot: "grants" },
  ],
});

const count = (s, re) => (s.match(re) ?? []).length;
const panelCount = count(result.stripped, /批准执行？\[y\]/g);
const helloAfter = readFileSync(`${root}/hello.txt`, "utf8");
const secondAfter = readFileSync(`${root}/second.txt`, "utf8");
const sessFile = readdirSync(`${root}/.pigeon/sessions`).find((f) => f.endsWith(".jsonl"));
const records = readFileSync(`${root}/.pigeon/sessions/${sessFile}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const editIntents = records.filter((r) => r.kind === "intent" && r.toolName === "edit_file");
const grantsTextMatch = result.stripped.match(/会话放权（\d+）：/);
console.log(JSON.stringify({
  code: result.code,
  panelCount,
  helloAfter,
  secondAfter,
  editApprovedBy: editIntents.map((r) => r.decision?.approvedBy),
  grantsHeader: grantsTextMatch?.[0],
  hitLine: result.stripped.match(/命中 \d+ 次[^\n]*/)?.[0],
}, null, 1));
