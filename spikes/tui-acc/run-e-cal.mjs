// 剧本 E 校准：大文件 edit_file 全跑（不崩溃），量出 intent→execution→receipt 的墙钟窗口
import { readFileSync, readdirSync } from "node:fs";
import { runTuiScenario } from "./tui-driver.mjs";

const root = "tmp/tui-acc/ws-e";

const result = await runTuiScenario({
  name: "e-cal",
  args: ["--root", root, "--stream-fn", "spikes/real-stream-fn.mjs"],
  steps: [
    { wait: /state: idle/, send: "big.txt 第一行是 line 1。请先用 read_file 读取 big.txt（用 limit 只看前 5 行），再用 edit_file 把第一行改成 LINE ONE，改完只回复「完成」。" },
    { wait: /批准执行？\[y\]/, snapshot: "panel", sendKey: "y" },
    { wait: /== run: completed/, snapshot: "final" },
  ],
});

const keyLine = readFileSync("tmp/tui-acc/e-cal.log", "utf8").match(/wall=([^\]]+)\] "y"/);
const yWall = new Date(keyLine[1]).getTime();
const sessFile = readdirSync(`${root}/.pigeon/sessions`).filter((f) => f.endsWith(".jsonl")).sort().pop();
const records = readFileSync(`${root}/.pigeon/sessions/${sessFile}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const intent = records.find((r) => r.kind === "intent" && r.toolName === "edit_file");
const receipt = records.find((r) => r.kind === "receipt");
console.log(JSON.stringify({
  code: result.code,
  yWall: new Date(yWall).toISOString(),
  intentAt: `${intent.timestamp} (+${intent.timestamp - yWall}ms after y)`,
  execStart: `${receipt.receipt.startedAt} (+${receipt.receipt.startedAt - yWall}ms)`,
  execEnd: `${receipt.receipt.finishedAt} (+${receipt.receipt.finishedAt - yWall}ms)`,
  executed: receipt.receipt.executed,
}, null, 1));
