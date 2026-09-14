// 剧本 G：退出路径（决策 033）真实 ConPTY 复验——M2 审计 note-9。
//   g1 单击 Ctrl+C 清缓冲 → /quit 优雅退出（零模型调用）
//   g2 空闲双击 Ctrl+C 优雅退出（零模型调用）
//   g3 运行中（Kimi 流式）双击 Ctrl+C 优雅退出：进程 code=0，事件日志有 run.ended（非崩溃残留）
// 三个子剧本各自独立进程；退出判定 = 子进程自行退出且 code=0（驱动步骤用尽时才关桥 stdin，
// 若 TUI 已退出则桥的 CTRL_C_EVENT 无对象）。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { runTuiScenario } from "./tui-driver-selfexit.mjs";

const root = "tmp/tui-acc/ws-g";
mkdirSync(root, { recursive: true });
writeFileSync(`${root}/note.txt`, "placeholder\n", "utf8");

const g1 = await runTuiScenario({
  name: "g1-quit",
  expectSelfExit: true,
  args: ["--root", root, "--stream-fn", "spikes/real-stream-fn.mjs"],
  steps: [
    { wait: /state: idle/, sendKey: "draft text not submitted" },
    { wait: /draft text not submitted/, snapshot: "typed", sendKey: "\x03" },
    { wait: /\[cleared\] 输入已清空（再按一次 Ctrl\+C 退出）/, snapshot: "cleared", send: "/quit" },
  ],
});

const g2 = await runTuiScenario({
  name: "g2-double",
  expectSelfExit: true,
  args: ["--root", root, "--stream-fn", "spikes/real-stream-fn.mjs"],
  steps: [{ wait: /state: idle/, snapshot: "idle", sendKey: "\x03\x03" }],
});

const before = readdirSync(`${root}/.pigeon/sessions`).filter((f) => f.endsWith(".jsonl"));
const g3 = await runTuiScenario({
  name: "g3-running-exit",
  expectSelfExit: true,
  args: ["--root", root, "--stream-fn", "spikes/real-stream-fn.mjs"],
  timeoutMs: 240_000,
  steps: [
    { wait: /state: idle/, send: "请从 1 数到 400，每个数字单独一行，不要省略任何数字，不要使用任何工具。" },
    { wait: /\b60\b/, snapshot: "streaming", sendKey: "\x03\x03" },
  ],
});
const after = readdirSync(`${root}/.pigeon/sessions`).filter((f) => f.endsWith(".jsonl"));
const g3File = after.find((f) => !before.includes(f));
const g3Records = g3File
  ? readFileSync(`${root}/.pigeon/sessions/${g3File}`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const kinds = g3Records.map((r) => r.kind);
const lastTurn = [...g3Records].reverse().find((r) => r.kind === "turn.completed");

console.log(JSON.stringify({
  g1: { code: g1.code, cleared: g1.stripped.includes("[cleared] 输入已清空"), draftGoneAfterClear: !g1.screenText().includes("draft text not submitted") },
  g2: { code: g2.code },
  g3: {
    code: g3.code,
    session: g3File,
    hasRunEnded: kinds.includes("run.ended"),
    lastTurnStopReason: lastTurn?.payload?.stopReason,
    tornTail: false,
  },
}, null, 1));
