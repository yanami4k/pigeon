// 路径 D：[d] 目录限定 grant → 目录内免审 → 目录外弹审批 → /revoke 会话 grant → 重新弹审批并拒绝（tmp/acc-d）
import { runScenario } from "./acc-driver.mjs";

let grantId = "";
const result = await runScenario({
  name: "D [d] 目录限定 + /revoke",
  args: ["--root", "tmp/acc-d", "--stream-fn", "spikes/real-stream-fn.mjs"],
  logPath: "tmp/acc-d.log",
  steps: [
    { wait: /pigeon> /, send: "请用 read_file 读 src/a.txt，再用 edit_file 把 alpha 改成 ALPHA，改完只回复「完成」。" },
    { wait: /批准执行？\[y\][^\n]*\[d\]/, send: "d" },
    { wait: /已创建会话放权 (grant_[0-9A-Z]+)/, send: (m) => { grantId = m[1]; return undefined; } },
    { wait: /终态：completed/, send: undefined },
    { wait: /pigeon> /, send: "请用 read_file 读 src/b.txt，再用 edit_file 把 bravo 改成 BRAVO，改完只回复「完成」。" },
    { wait: /终态：completed/, send: undefined },
    { wait: /pigeon> /, send: "请用 read_file 读 lib/c.txt，再用 edit_file 把 charlie 改成 CHARLIE，改完只回复「完成」。" },
    { wait: /批准执行？\[y\]/, send: "y" },
    { wait: /终态：completed/, send: undefined },
    { wait: /pigeon> /, send: "/grants" },
    { wait: /仅限目录 src/, send: () => `/revoke ${grantId}` },
    { wait: /已撤销会话放权/, send: "请用 read_file 读 src/a.txt，再用 edit_file 把 ALPHA 改回 alpha，改完只回复「完成」。" },
    { wait: /批准执行？\[y\]/, send: "n" },
    { wait: /拒绝理由/, send: "验收：撤销后必须重新问人，这次故意拒绝" },
    { wait: /终态：completed/, send: ":quit" },
  ],
});
console.log(JSON.stringify({ code: result.code, grantId }));
