// 剧本 n3：/grants 重复行真实终端验证——M2 审计 note-3（零模型调用）。
//   工作区 ws-n3：.pigeon/grants.json 两条固化规则 + 从 ws-c 复制的会话文件
//   （含一条 grant.created）。/resume 进该会话后连发三次 /grants（触发重绘），
//   每次抓虚拟屏快照；判据 = 屏幕快照里同一条 grant 行是否出现两次
//   （剥离流是增量合成流，重复属正常；屏幕快照才是真相）。
//   最后 /quit 自退出。
import { runTuiScenario } from "./tui-driver-selfexit.mjs";

const root = "tmp/tui-acc/ws-n3";
const sessionId = "sess_01M2BWBAG6CHYHR6Q6578MW6GG";

const r = await runTuiScenario({
  name: "n3-grants",
  expectSelfExit: true,
  args: ["--root", root, "--stream-fn", "spikes/real-stream-fn.mjs"],
  steps: [
    { wait: /state: idle/, send: `/resume ${sessionId}` },
    { wait: /模型对话上下文重新建立/ },
    // 恢复完成、换绑收口后状态栏回到 idle（第二个 state: idle 才是恢复后的）
    { wait: /state: idle/, send: "/grants" },
    { wait: /固化规则（/, snapshot: "grants", send: "/grants" },
    { wait: /固化规则（/, snapshot: "grants2", send: "/grants" },
    { wait: /固化规则（/, snapshot: "grants3", send: "/quit" },
  ],
});

console.log(JSON.stringify({ code: r.code, signal: r.signal, killed: r.killed }));
