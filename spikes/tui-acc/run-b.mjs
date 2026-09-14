// 剧本 B：审批面板 [y] 批准 edit_file，文件真实写入，账本 approvedBy=human（tmp/tui-acc/ws-b）
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { runTuiScenario } from "./tui-driver.mjs";

const root = "tmp/tui-acc/ws-b";
mkdirSync(root, { recursive: true });
writeFileSync(`${root}/hello.txt`, "hello worlld\nthis file has a typo\n", "utf8");

const result = await runTuiScenario({
  name: "b-approve",
  args: ["--root", root, "--stream-fn", "spikes/real-stream-fn.mjs"],
  steps: [
    { wait: /state: idle/, send: "hello.txt 第一行有个错别字 worlld，请用 read_file 读后用 edit_file 改成 world，改完只回复「完成」。" },
    { wait: /批准执行？\[y\]/, snapshot: "panel", sendKey: "y" },
    { wait: /== run: completed/, snapshot: "final" },
  ],
});

const fileAfter = readFileSync(`${root}/hello.txt`, "utf8");
const sessDir = `${root}/.pigeon/sessions`;
const sessFile = readdirSync(sessDir).find((f) => f.endsWith(".jsonl"));
const records = readFileSync(`${sessDir}/${sessFile}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const editIntent = records.find((r) => r.kind === "intent" && r.toolName === "edit_file");
const editReceipt = records.find((r) => r.kind === "receipt" && r.payload?.executionId === editIntent?.executionId)
  ?? records.find((r) => r.kind === "receipt" && r.executionId === editIntent?.executionId);
console.log(JSON.stringify({
  code: result.code,
  fileAfter,
  sessionFile: sessFile,
  editApprovedBy: editIntent?.decision?.approvedBy ?? editIntent?.payload?.decision?.approvedBy,
  receiptExecuted: editReceipt?.receipt?.executed ?? editReceipt?.payload?.receipt?.executed,
  panelShown: result.stripped.includes("批准执行？[y]"),
}, null, 1));
