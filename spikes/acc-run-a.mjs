// 路径 A：多 Run + [a] 放权 + 免审命中 + /grants + /grants save（tmp/acc-a）
import { runScenario } from "./acc-driver.mjs";

const grantIds = [];
const result = await runScenario({
  name: "A 多 Run + [a] + 升格",
  args: ["--root", "tmp/acc-a", "--stream-fn", "spikes/real-stream-fn.mjs"],
  logPath: "tmp/acc-a.log",
  steps: [
    { wait: /pigeon> /, send: "hello.txt 第一行有个错别字 worlld，请用 read_file 读后用 edit_file 改成 world，改完只回复「完成」。" },
    { wait: /批准执行？\[y\] 批准一次 \/ \[n\] 拒绝 \/ \[a\] 本会话允许/, send: "a" },
    {
      wait: /已创建会话放权 (grant_[0-9A-Z]+)/,
      send: (m) => {
        grantIds.push(m[1]);
        return undefined;
      },
    },
    { wait: /终态：completed/, send: undefined },
    { wait: /pigeon> /, send: "请用 read_file 读 second.txt，再用 edit_file 把第二行 beta 改成 BETA，改完只回复「完成」。" },
    { wait: /终态：completed/, send: undefined },
    { wait: /pigeon> /, send: "/grants" },
    { wait: /固化规则（0/, send: () => `/grants save ${grantIds[0]}` },
    { wait: /已升格/, send: "/grants" },
    { wait: /固化规则（0，来自/, send: ":quit" },
  ],
});
console.log(JSON.stringify({ code: result.code, grantIds }));
