// 剧本 M5：真实 Kimi 链路 + 真实 ConPTY 验收 M5（决策 037 / 038 / 042 / 043 / 044 / 045）。
//   m5a（一个进程，一个会话）：
//     1. 问常驻 Memory 的内容（暗号「蓝色鸽子」）；
//     2. 会话中途把 Memory 文件改成「红色乌鸦」再问一次——冻结的 system prompt 不变；
//     3. 让模型调用 load_skill 读未登记的 ghost——拒绝；
//     4. 让模型读 deploy 的 SKILL.md 与 references/checklist.md——成功并落 skill.loaded；
//     5. /search 蓝色鸽子——人的检索入口；
//     6. 让模型用 search_sessions 与 read_session_entry 翻本会话旧消息读原文；
//     7. /quit 自退出。
//   m5b（新进程）：/resume 同一会话——历史渲染（正文、thinking、工具行、折叠 toolResult）→ /quit。
// 流式 thinking 需要推理档位：用 spikes/m5-reasoning-stream-fn.mjs（缺省 reasoning=medium）。
// 从仓库根目录运行：node spikes/tui-acc/run-m5.mjs；产出（日志、快照、工作区）写 tmp/tui-acc/，不入库。
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  JsonlEventLog,
  materializeSession,
  readMessageContentFileDetailed,
} from "../../src/persistence/event-log.ts";
import { runTuiScenario } from "./tui-driver-selfexit.mjs";

const root = "tmp/tui-acc/ws-m5";
rmSync(root, { recursive: true, force: true });
mkdirSync(`${root}/.pigeon/memory`, { recursive: true });
mkdirSync(`${root}/.pigeon/skills/deploy/references`, { recursive: true });
const conventions = `${root}/.pigeon/memory/conventions.md`;
writeFileSync(conventions, "项目约定：包管理器一律用 pnpm，暗号是 蓝色鸽子。\n", "utf8");
writeFileSync(
  `${root}/.pigeon/skills/deploy/SKILL.md`,
  "---\nname: deploy\ndescription: 预发部署步骤\n---\n# 部署\n1. 先跑 pnpm test\n2. 再读 references/checklist.md\n",
  "utf8"
);
writeFileSync(
  `${root}/.pigeon/skills/deploy/references/checklist.md`,
  "检查清单：确认暗号已写进发布说明，回滚脚本已演练。\n",
  "utf8"
);

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

const m5a = await runTuiScenario({
  name: "m5a",
  expectSelfExit: true,
  args,
  timeoutMs: 600_000,
  steps: [
    {
      wait: /session (sess_[0-9A-Z]{26})[\s\S]*?state: idle/,
      snapshot: "start",
      send: (match) => {
        sessionId = match[1];
        return "只根据 system prompt 里的常驻 Memory 回答：本项目的包管理器是什么？暗号是什么？不要调用任何工具，一句话回答。";
      },
    },
    {
      wait: runDone,
      snapshot: "memory-1",
      send: () => {
        writeFileSync(conventions, "项目约定：包管理器改用 npm，暗号改为 红色乌鸦。\n", "utf8");
        return "再回答一次同样的问题：只根据 system prompt 里的常驻 Memory，包管理器是什么？暗号是什么？不要调用任何工具。";
      },
    },
    {
      wait: runDone,
      snapshot: "memory-2-frozen",
      send: "请调用 load_skill 工具，参数 name 填 ghost（故意测试未登记的 Skill），然后原样报告工具返回的错误，不要调用其他工具。",
    },
    {
      wait: runDone,
      snapshot: "skill-reject",
      send: "请调用 load_skill 读取 deploy 的 SKILL.md，再按其中提示调用 load_skill 读取 references/checklist.md，最后用一句话说出检查清单的内容。",
    },
    { wait: runDone, snapshot: "skill-load", send: "/search 蓝色鸽子" },
    {
      wait: /命中 \d+ 条|没有命中/,
      snapshot: "search-command",
      send: "请用 search_sessions 工具检索关键词 暗号，挑一条命中用 read_session_entry 读原文，然后告诉我原文里暗号是什么。",
    },
    { wait: runDone, snapshot: "search-tools", send: "/quit" },
  ],
});

const m5b = await runTuiScenario({
  name: "m5b",
  expectSelfExit: true,
  args,
  timeoutMs: 120_000,
  steps: [
    { wait: /state: idle/, send: () => `/resume ${sessionId}` },
    { wait: /== 历史结束，以下为续跑 ==/, snapshot: "resume-history", send: "/quit" },
  ],
});

// ---- 证据汇总：事件日志与内容文件是事实源，屏幕快照是呈现证据 ----
const sessionsDir = join(root, ".pigeon", "sessions");
const materialized = materializeSession(sessionsDir, sessionId);
const contents = readMessageContentFileDetailed(
  JsonlEventLog.contentFilePathFor(sessionsDir, sessionId)
).records;
const assistantTexts = contents
  .filter((record) => record.role === "assistant")
  .map((record) =>
    record.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
  );
const runIds = materialized.runStarteds.map((record) => record.runId);
const answerOfRun = (runId) =>
  contents
    .filter((record) => record.runId === runId && record.role === "assistant")
    .flatMap((record) => record.blocks.filter((block) => block.type === "text").map((block) => block.text))
    .join("");
const loadSkillSettled = materialized.runtimeEvents
  .filter((event) => event.kind === "tool.settled" && event.payload.toolName === "load_skill")
  .map((event) => event.payload.isError);
const toolNames = [
  ...new Set(
    materialized.runtimeEvents
      .filter((event) => event.kind === "tool.proposed")
      .map((event) => event.payload.toolName)
  ),
];
const resumeScreen = m5b.screenText();

console.log(
  JSON.stringify(
    {
      exitCodes: { m5a: m5a.code, m5b: m5b.code },
      sessionId,
      sessionFiles: readdirSync(sessionsDir),
      runStarted: materialized.runStarteds.length,
      llmRequests: materialized.llmRequests.length,
      memoryManifestHashesPerRun: materialized.runStarteds.map((record) => record.payload.memory[0]?.hash.slice(0, 12)),
      systemPromptHashesPerRun: [...new Set(materialized.runStarteds.map((record) => record.payload.systemPromptHash))].length,
      answer1: answerOfRun(runIds[0]),
      answer2: answerOfRun(runIds[1]),
      answer2MentionsOldSecret: answerOfRun(runIds[1]).includes("蓝色鸽子"),
      answer2MentionsNewSecret: answerOfRun(runIds[1]).includes("红色乌鸦"),
      toolNames,
      loadSkillSettledIsError: loadSkillSettled,
      skillLoaded: materialized.skillLoadeds.map((record) => [record.payload.name, record.payload.resourcePath, record.payload.truncated]),
      contentRecords: contents.length,
      systemRecords: contents.filter((record) => record.role === "system").length,
      thinkingBlocks: contents.flatMap((record) => record.blocks).filter((block) => block.type === "thinking").length,
      contentGaps: materialized.contentGaps,
      entryGaps: materialized.entryGaps,
      totalTokens: materialized.runtimeEvents
        .filter((event) => event.kind === "turn.completed" && event.payload.usage !== undefined)
        .reduce((sum, event) => sum + event.payload.usage.totalTokens, 0),
      resumeScreen: {
        hasUserEcho: resumeScreen.includes("> 只根据 system prompt"),
        hasThinkingLine: /(^|\n)\s*~ /.test(resumeScreen),
        hasToolLine: resumeScreen.includes("$ load_skill"),
        hasFoldedResult: resumeScreen.includes("[result] load_skill"),
        hasHistoryEnd: resumeScreen.includes("== 历史结束，以下为续跑 =="),
      },
      lastAssistantText: assistantTexts.at(-1),
    },
    null,
    1
  )
);
