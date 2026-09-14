// 路径 B：新进程装载固化规则 → 命中记 policy:config → /grants 列出 config#0 → /revoke config#0
//（tmp/acc-a，接路径 A 的 grants.json）
import { runScenario } from "./acc-driver.mjs";

const result = await runScenario({
  name: "B 固化规则命中 + /revoke config#0",
  args: ["--root", "tmp/acc-a", "--stream-fn", "spikes/real-stream-fn.mjs"],
  logPath: "tmp/acc-b.log",
  steps: [
    { wait: /pigeon> /, send: "/grants" },
    { wait: /固化规则（1，来自/, send: "请用 read_file 读 second.txt，再用 edit_file 把第一行 alpha 改成 ALPHA，改完只回复「完成」。" },
    { wait: /终态：completed/, send: undefined },
    { wait: /pigeon> /, send: "/revoke config#0" },
    { wait: /已移除固化规则 config#0/, send: "/grants" },
    { wait: /固化规则（1，来自/, send: ":quit" },
  ],
});
console.log(JSON.stringify({ code: result.code }));
