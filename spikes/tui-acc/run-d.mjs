// 剧本 D：长流式中 Esc 取消——aborted 终态 + 分类「取消」+ 进程不悬挂（tmp/tui-acc/ws-d）
import { mkdirSync } from "node:fs";
import { runTuiScenario } from "./tui-driver.mjs";

const root = "tmp/tui-acc/ws-d";
mkdirSync(root, { recursive: true });

const result = await runTuiScenario({
  name: "d-cancel",
  args: ["--root", root, "--stream-fn", "spikes/real-stream-fn.mjs"],
  timeoutMs: 240_000,
  steps: [
    { wait: /state: idle/, send: "请从 1 数到 400，每个数字单独一行，不要省略任何数字，不要使用任何工具。" },
    // 等流到 200 左右再按 Esc（数字逐个流式输出，出现 200 说明已流了一半）
    { wait: /200/, snapshot: "streaming", sendKey: "\x1b" },
    { wait: /== run: aborted[^\n]*分类：取消/, snapshot: "aborted" },
    // 不悬挂验证：取消后状态回 idle，且能再跑一个完整 Run
    { wait: /state: idle/, send: "只回复两个字：好的。不要使用任何工具。" },
    { wait: /== run: completed/, snapshot: "after" },
  ],
});

console.log(JSON.stringify({
  code: result.code,
  abortedBadge: /== run: aborted[^\n]*分类：取消/.test(result.stripped),
  resumedCompleted: result.stripped.includes("== run: completed"),
}, null, 1));
