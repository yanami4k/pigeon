// 只适用于旧格式：本脚本读写旧账本或会话树写穿（persistence/event-log.ts 等模块已在账本重构第四段删除），只能在只读旧版代码 455d88d 上运行；新代码上不再维护。
// 剧本 M5c：load_skill 拒绝与"修改下个会话生效"的真实链路复验（决策 042 / 043）。
// 背景：剧本 m5a 第 3 步模型没有真正发起 load_skill(ghost) 调用，而是自行编造了错误文本，
// 拒绝路径未经真实链路验证；本剧本明确要求真实调用并以事件日志判定。
// 沿用 m5a 的工作区 tmp/tui-acc/ws-m5（其 Memory 文件已在 m5a 会话中途改为「红色乌鸦」），新开会话：
//   1. load_skill {name: ghost} —— 来源约束拒绝；
//   2. load_skill {name: deploy, resource: ../../memory/conventions.md} —— 路径约束拒绝；
//   3. 再问常驻 Memory —— 新会话冻结的是修改后的版本；
//   4. /quit。
// 从仓库根目录运行：node spikes/tui-acc/run-m5c.mjs；需先跑过 run-m5.mjs。产出写 tmp/tui-acc/，不入库。
import { join } from "node:path";
import {
  JsonlEventLog,
  materializeSession,
  readMessageContentFileDetailed,
} from "../../src/persistence/event-log.ts";
import { runTuiScenario } from "./tui-driver-selfexit.mjs";

const root = "tmp/tui-acc/ws-m5";
const args = [
  "--root",
  root,
  "--stream-fn",
  "spikes/m5-reasoning-stream-fn.mjs",
  "--provider",
  "kimi-coding",
  "--model",
  "kimi-for-coding",
];
const runDone = /== run: \w+[^\n]*==/;
let sessionId = "";

const m5c = await runTuiScenario({
  name: "m5c",
  expectSelfExit: true,
  args,
  timeoutMs: 480_000,
  steps: [
    {
      wait: /session (sess_[0-9A-Z]{26})[\s\S]*?state: idle/,
      send: (match) => {
        sessionId = match[1];
        return '这是一次工具测试。请立刻真实调用 load_skill 工具，参数为 {"name": "ghost"}。必须发起工具调用，不允许自己编造工具返回值；拿到返回后原样复述错误信息。';
      },
    },
    {
      wait: runDone,
      snapshot: "reject-name",
      send: '再真实调用一次 load_skill 工具，参数为 {"name": "deploy", "resource": "../../memory/conventions.md"}。必须发起工具调用，拿到返回后原样复述错误信息。',
    },
    {
      wait: runDone,
      snapshot: "reject-path",
      send: "只根据 system prompt 里的常驻 Memory 回答：包管理器是什么？暗号是什么？不要调用任何工具，一句话回答。",
    },
    { wait: runDone, snapshot: "memory-next-session", send: "/quit" },
  ],
});

const sessionsDir = join(root, ".pigeon", "sessions");
const materialized = materializeSession(sessionsDir, sessionId);
const contents = readMessageContentFileDetailed(
  JsonlEventLog.contentFilePathFor(sessionsDir, sessionId)
).records;
const loadSkillCalls = materialized.runtimeEvents
  .filter((event) => event.kind === "tool.proposed" && event.payload.toolName === "load_skill")
  .map((event) => {
    const settled = materialized.runtimeEvents.find(
      (other) => other.kind === "tool.settled" && other.payload.toolCallId === event.payload.toolCallId
    );
    const result = contents.find(
      (record) => record.role === "toolResult" && record.toolCallId === event.payload.toolCallId
    );
    return {
      args: event.payload.args,
      isError: settled?.kind === "tool.settled" ? settled.payload.isError : null,
      result: result?.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
    };
  });
const lastRun = materialized.runStarteds.at(-1)?.runId;
const lastAnswer = contents
  .filter((record) => record.runId === lastRun && record.role === "assistant")
  .flatMap((record) => record.blocks.filter((block) => block.type === "text").map((block) => block.text))
  .join("");

console.log(
  JSON.stringify(
    {
      exitCode: m5c.code,
      sessionId,
      loadSkillCalls,
      skillLoaded: materialized.skillLoadeds.length,
      memoryManifestHash: materialized.runStarteds[0]?.payload.memory[0]?.hash.slice(0, 12),
      lastAnswer,
      lastAnswerMentionsNewSecret: lastAnswer.includes("红色乌鸦"),
      contentGaps: materialized.contentGaps,
      entryGaps: materialized.entryGaps,
    },
    null,
    1
  )
);
