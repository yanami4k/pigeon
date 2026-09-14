// 剧本 A：流式渲染 CJK 长文（tmp/tui-acc/ws-a，无工具调用）
import { mkdirSync } from "node:fs";
import { runTuiScenario } from "./tui-driver.mjs";

mkdirSync("tmp/tui-acc/ws-a", { recursive: true });

const result = await runTuiScenario({
  name: "a-stream",
  args: ["--root", "tmp/tui-acc/ws-a", "--stream-fn", "spikes/real-stream-fn.mjs"],
  steps: [
    {
      wait: /state: idle/,
      send: "请写一段大约 300 字的中文散文，描写深秋清晨的街巷景象，要求有细节描写。不要使用任何工具，直接输出散文正文。",
    },
    { wait: /state: running/, snapshot: "start" },
    { snapshotAfterMs: 4000, snapshot: "mid" },
    { snapshotAfterMs: 4000, snapshot: "mid2" },
    { wait: /== run: completed/, snapshot: "final" },
  ],
});

const hasBadge = result.stripped.includes("分类：正常");
const hasReplacementChar = result.stripped.includes(String.fromCharCode(0xfffd));
console.log(JSON.stringify({ code: result.code, killed: result.killed, hasBadge, hasReplacementChar }));
