// 开工状态块与状态变化通道接到运行面上（决策 363、354）：
// - 状态块随第一条输入作一条单独的用户消息发出；写档、命令档工具之后 git 状态变了，以追加放在该批工具结果之后，
//   之前的消息一字不改（只追加不改写）；
// - 续跑：系统提示与对话前缀逐字节不变，只追加变了的节，完全没变不追加；
// - 压缩之后重发完整块（没有工具结果、因通知接着跑的一轮触发的压缩也一样）；Skill 改动后 load_skill 按新登记读取；
// - /reload 与续跑接着最后发出的一份（模型自己写的记忆不回显）；旧会话续跑的完整块开头另加一句以本状态块为准；
// - 读会话的地方（会话列表、检索、缺省分叉点、回看）按消息上的标记跳过状态块，人输入的以标签开头的话照常算人说的。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSessionRefs, readSessionView } from "../persistence/session-catalog.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn, type FakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { extractSessionSearch } from "../state/session-search-text.ts";
import { resolveForkPoint } from "./fork-command.ts";
import { runHeadless } from "./headless-core.ts";
import { messageLines } from "./history.ts";
import type { McpSession } from "./mcp.ts";
import { listRecentMainSessions } from "./recent-sessions.ts";
import { buildRuntime, disposeRuntime, type RuntimeBundle } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";
import { LEGACY_PROMPT_NOTE } from "./status-block.ts";
import { statusTextOf, userTexts } from "./status-fixtures.ts";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function repo(): { root: string; home: string; cleanup: () => void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-status-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-status-home-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "pigeon@example.invalid"]);
  git(["config", "user.name", "pigeon-test"]);
  git(["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(root, "AGENTS.md"), "约定一\n");
  writeFileSync(join(root, "a.txt"), "old\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return {
    root,
    home,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const wire = (call: FakeStreamFn["calls"][number] | undefined) =>
  JSON.stringify((call?.context.messages ?? []).map((m) => ({ role: m.role, content: m.content })));
const sections = (text: string) =>
  [...text.matchAll(/<pigeon-section name="([^"]+)">/g)].map((match) => match[1]);

const EDIT = [
  {
    text: "改",
    toolCalls: [
      { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: "new\n" } },
    ],
  },
  { text: "改好了" },
];

test("状态块随第一条输入单独发出；改了文件后 git 状态以追加放在工具结果之后，之前的消息一字不改", async () => {
  const r = repo();
  try {
    const streamFn = createFakeStreamFn({ replies: EDIT });
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: r.root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake",
      modelId: "fake",
      homeDir: r.home,
    });
    try {
      await bundle.adapter.run("把 a.txt 改成 new");
    } finally {
      await disposeRuntime(bundle);
    }
    const [first, second] = streamFn.calls;
    assert.deepEqual(userTexts(first).slice(1), ["把 a.txt 改成 new"]);
    assert.match(userTexts(first)[0] ?? "", /^<pigeon-status>\n/);
    assert.match(statusTextOf(first), /工作区没有未提交的改动/);
    // 第二次请求以第一次的消息为前缀，其后是助手消息、工具结果、状态追加
    const prefix = wire(first).slice(0, -1);
    assert.ok(wire(second).startsWith(prefix), "之前的消息一字不改");
    const tail = (second?.context.messages ?? []).slice(first?.context.messages.length);
    assert.deepEqual(
      tail.map((message) => message.role),
      ["assistant", "toolResult", "user"]
    );
    const update = userTexts(second).at(-1) ?? "";
    assert.deepEqual(sections(update), ["git 状态"]);
    assert.match(
      update,
      /以下整段取代此前的「git 状态」：\n分支 main，当前提交 [0-9a-f]+；工作区有未提交的改动/
    );
    assert.ok(!update.includes("a.txt"), "具体改了哪些文件不进看板");
  } finally {
    r.cleanup();
  }
});

test("续跑：系统提示与对话前缀逐字节不变，只追加变了的节；再续跑时什么都没变就不追加", async () => {
  const r = repo();
  const sessionId = newSessionId();
  const flags = { yolo: true, provider: "custom", modelId: "custom", persistThinking: true };
  const open = async (streamFn: StreamFn, resume: boolean) =>
    openSessionRuntime({
      governanceRoot: r.root,
      sessionId,
      streamFn,
      flags,
      startMcp: noMcp,
      homeDir: r.home,
      ...(resume ? { resume: true } : {}),
    });
  try {
    const first = createFakeStreamFn({ replies: EDIT });
    let opened = await open(first, false);
    await opened.bundle.adapter.run("改");
    const transcript = opened.bundle.adapter.transcript();
    await disposeRuntime(opened.bundle);
    appendFileSync(join(r.root, "AGENTS.md"), "约定二\n");

    const second = createFakeStreamFn({ replies: [{ text: "好" }] });
    opened = await open(second, true);
    await opened.bundle.adapter.run("继续");
    const resumedTranscript = opened.bundle.adapter.transcript();
    await disposeRuntime(opened.bundle);
    const call = second.calls[0];
    assert.equal(call?.context.systemPrompt, first.calls.at(-1)?.context.systemPrompt);
    const shape = (messages: ReadonlyArray<{ role: string }>) =>
      JSON.stringify(
        messages.map((m) => ({ role: m.role, content: (m as { content?: unknown }).content }))
      );
    const expected = shape(transcript);
    const sent = (call?.context.messages ?? []).slice(0, transcript.length);
    assert.equal(shape(sent), expected);
    const appended = userTexts(call).slice(-2);
    assert.deepEqual(sections(appended[0] ?? ""), ["项目说明"]);
    assert.match(appended[0] ?? "", /^<pigeon-status-update>\n[\s\S]*约定二/);
    assert.equal(appended[1], "继续");

    const third = createFakeStreamFn({ replies: [{ text: "好" }] });
    opened = await open(third, true);
    await opened.bundle.adapter.run("再继续");
    await disposeRuntime(opened.bundle);
    assert.equal(third.calls[0]?.context.messages.length, resumedTranscript.length + 1);
    assert.equal(userTexts(third.calls[0]).at(-1), "再继续", "什么都没变就不追加");
  } finally {
    r.cleanup();
  }
});

test("压缩之后重发完整块，注明取代此前的全部开工状态", async () => {
  const r = repo();
  try {
    const fake = createFakeStreamFn({
      replies: [
        {
          text: "我先读一下文件。".repeat(20),
          toolCalls: [{ name: "read_file", args: { path: "a.txt" } }],
          contextTokens: 5000,
        },
        { text: "## Goal\n读文件" },
        { text: "读完了", contextTokens: 300 },
      ],
    });
    const main: FakeStreamFn["calls"] = [];
    const streamFn: StreamFn = (model, context, options) => {
      if (!(context.systemPrompt ?? "").startsWith("You are a context summarization assistant.")) {
        main.push({ model, context: { ...context, messages: [...context.messages] } });
      }
      return fake(model, context, options);
    };
    const result = await runHeadless({
      task: `请读 a.txt。${"背景说明。".repeat(60)}`,
      governanceRoot: r.root,
      workspaceRoot: r.root,
      streamFn,
      yolo: true,
      homeDir: r.home,
      compaction: { thresholdTokens: 1000, keepRecentTokens: 20 },
    });
    assert.equal(result.status, "completed");
    const last = main.at(-1);
    assert.ok(main.length >= 2 && last !== undefined);
    assert.match(
      statusTextOf(last),
      /<pigeon-status>\n以下整段取代此前的全部开工状态。\n[\s\S]*约定一/
    );
  } finally {
    r.cleanup();
  }
});

test("Skill 文件改动后：load_skill 按重新登记的内容读取，不再按开局的哈希拒绝", async () => {
  const r = repo();
  try {
    const skillDir = join(r.root, ".pigeon", "skills", "deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: deploy\ndescription: 部署\n---\n旧步骤\n"
    );
    const streamFn = createFakeStreamFn({
      replies: [
        { text: "好" },
        { text: "读", toolCalls: [{ name: "load_skill", args: { name: "deploy" } }] },
        { text: "读完了" },
      ],
    });
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: r.root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake",
      modelId: "fake",
      homeDir: r.home,
    });
    try {
      await bundle.adapter.run("开始");
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: deploy\ndescription: 部署\n---\n新步骤\n"
      );
      await bundle.adapter.run("读 deploy");
    } finally {
      await disposeRuntime(bundle);
    }
    const result = JSON.stringify(streamFn.calls.at(-1)?.context.messages.at(-1));
    assert.match(result, /新步骤/);
    assert.doesNotMatch(result, /已变更/);
  } finally {
    r.cleanup();
  }
});

test("Skill 在两次请求之间被改（不经写档、命令档工具）：下一次请求之前即重新登记，load_skill 读到新内容", async () => {
  const r = repo();
  try {
    const skillDir = join(r.root, ".pigeon", "skills", "deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: deploy\ndescription: 部署\n---\n旧步骤\n"
    );
    const streamFn = createFakeStreamFn({
      replies: [
        { text: "看看", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
        { text: "读", toolCalls: [{ name: "load_skill", args: { name: "deploy" } }] },
        { text: "读完了" },
      ],
    });
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: r.root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake",
      modelId: "fake",
      homeDir: r.home,
    });
    let changed = false;
    bundle.adapter.subscribeRounds(() => {
      if (!changed) {
        changed = true;
        writeFileSync(
          join(skillDir, "SKILL.md"),
          "---\nname: deploy\ndescription: 部署\n---\n新步骤，多写一句\n"
        );
      }
    });
    try {
      await bundle.adapter.run("开始");
    } finally {
      await disposeRuntime(bundle);
    }
    const result = JSON.stringify(streamFn.calls.at(-1)?.context.messages.at(-1));
    assert.match(result, /新步骤，多写一句/);
    assert.doesNotMatch(result, /已变更/);
  } finally {
    r.cleanup();
  }
});

test("读会话的地方按标记跳过状态块：会话列表的第一句、检索、缺省分叉点、回看；人输入的以 <pigeon-status> 开头的话照常算人说的", async () => {
  const r = repo();
  try {
    const human = "<pigeon-status> 这是我自己打的一句";
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const opened = await openSessionRuntime({
      governanceRoot: r.root,
      sessionId: newSessionId(),
      streamFn,
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: r.home,
    });
    try {
      await opened.bundle.adapter.run(human);
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const sessionId = opened.bundle.adapter.sessionId;
    assert.equal(listRecentMainSessions(r.root)[0]?.firstInput, human);
    const ref = listSessionRefs(sessionsDirOf(r.root)).find((item) => item.sessionId === sessionId);
    const view = ref !== undefined ? readSessionView(ref) : undefined;
    assert.ok(view !== undefined);
    const [status, input] = view.messages;
    assert.equal(status?.raw.pigeonStatus, true, "状态消息带标记存进会话记录");
    assert.equal(input?.raw.pigeonStatus, undefined);
    const search = extractSessionSearch(view, 0);
    assert.ok(search.conversation.some((doc) => doc.text === human));
    assert.ok(!search.conversation.some((doc) => doc.text.includes("开工状态（Pigeon 自动附上）")));
    const store = loadStoreSession(sessionsDirOf(r.root), sessionId)?.view;
    assert.ok(store !== undefined);
    assert.equal(resolveForkPoint(store, {}).runSeq, 2, "缺省分叉点落在人输入的那条上");
    assert.match(messageLines(status as never)[0]?.text ?? "", /^\[开工状态\] 项目说明、/);
    assert.equal(messageLines(input as never)[0]?.text, `> ${human}`);
    // 交给模型的请求里没有标记
    assert.ok(!JSON.stringify(streamFn.calls[0]?.context.messages).includes("pigeonStatus"));
  } finally {
    r.cleanup();
  }
});

test("旧会话续跑：沿用会话记录里的系统提示（其中带人写的说明等），开工状态块照新规则追加完整一份", async () => {
  const r = repo();
  try {
    const old = "旧系统提示\n\n## 人写的说明（AGENTS.md）\n约定一";
    const s = createFixtureSession({
      sessionsDir: join(r.root, ".pigeon", "state", "sessions"),
      cwd: r.root,
    });
    s.startRun({ task: "旧任务", config: { systemPrompt: old } });
    s.assistant({ text: "旧回答" });
    s.endRun();
    const { sessionId } = await s.close();
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const opened = await openSessionRuntime({
      governanceRoot: r.root,
      sessionId,
      streamFn,
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: r.home,
      resume: true,
    });
    try {
      await opened.bundle.adapter.run("继续");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const call = streamFn.calls[0];
    assert.equal(call?.context.systemPrompt, old, "不重新生成系统提示");
    const texts = userTexts(call);
    assert.equal(texts[0], "旧任务");
    assert.match(texts.at(-2) ?? "", /^<pigeon-status>\n开工状态/);
    // 旧系统提示里没有权威层级说明、还带"开局冻结"的旧说法：完整块开头另加一句以本状态块为准
    assert.ok((texts.at(-2) ?? "").split("\n")[2] === LEGACY_PROMPT_NOTE);
    assert.equal(texts.at(-1), "继续");
  } finally {
    r.cleanup();
  }
});

test("/reload 与续跑接着最后发出的一份：不重发完整块；模型自己写的记忆在 /reload 之后、续跑之后都不回显", async () => {
  const r = repo();
  const sessionId = newSessionId();
  const fake = createFakeStreamFn({
    replies: [
      {
        text: "记",
        toolCalls: [
          {
            name: "update_memory",
            args: { action: "add", layer: "project", content: "提交信息用英文" },
          },
        ],
      },
      { text: "记好了" },
      { text: "好" },
      { text: "好" },
    ],
  });
  const open = (extra: { resume?: true; reloadFrom?: RuntimeBundle } = {}) =>
    openSessionRuntime({
      governanceRoot: r.root,
      sessionId,
      streamFn: fake,
      flags: {
        yolo: true,
        provider: "custom",
        modelId: "custom",
        persistThinking: true,
        pushedMemory: true,
      },
      startMcp: noMcp,
      homeDir: r.home,
      memoryWrite: { source: "tui" },
      ...extra,
    });
  try {
    let bundle = (await open()).bundle;
    await bundle.adapter.run("记一下");
    assert.match(statusTextOf(fake.calls[0]), /<pigeon-section name="记忆">/);
    assert.doesNotMatch(statusTextOf(fake.calls[1]), /「记忆」/, "本运行面内不回显");
    // /reload：照终端界面的做法，先落盘，同一会话上带着旧运行面重开，再释放旧的
    await bundle.sessionStore.flush();
    const reloaded = (await open({ resume: true, reloadFrom: bundle })).bundle;
    await disposeRuntime(bundle);
    bundle = reloaded;
    await bundle.adapter.run("继续");
    await disposeRuntime(bundle);
    assert.deepEqual(
      userTexts(fake.calls[2]).slice(1),
      ["记一下", "继续"],
      "/reload 之后不重发完整块、不回显自己写的记忆"
    );
    // 续跑：从会话记录里最后一条状态条目接着比对
    bundle = (await open({ resume: true })).bundle;
    await bundle.adapter.run("再继续");
    await disposeRuntime(bundle);
    assert.deepEqual(
      userTexts(fake.calls[3]).slice(1),
      ["记一下", "继续", "再继续"],
      "续跑之后同样不回显"
    );
  } finally {
    r.cleanup();
  }
});

test("没有工具结果、因通知接着跑的一轮触发的压缩：下一次请求之前照样重发完整块（排在通知之前）", async () => {
  const r = repo();
  try {
    const fake = createFakeStreamFn({
      replies: [
        // 填充文字逐句不同，免得触发流式重复检测（决策 367）
        { text: Array.from({ length: 40 }, (_, i) => `第${i + 1}句。`).join(""), contextTokens: 5000 },
        { text: "## Goal\n说话" },
        { text: "收到通知", contextTokens: 300 },
      ],
    });
    const main: FakeStreamFn["calls"] = [];
    const streamFn: StreamFn = (model, context, options) => {
      if (!(context.systemPrompt ?? "").startsWith("You are a context summarization assistant.")) {
        main.push({ model, context: { ...context, messages: [...context.messages] } });
      }
      return fake(model, context, options);
    };
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: r.root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake",
      modelId: "fake",
      homeDir: r.home,
      compaction: { thresholdTokens: 1000, keepRecentTokens: 20 },
    });
    let posted = false;
    bundle.adapter.subscribeRounds(() => {
      if (!posted) {
        posted = true;
        bundle.adapter.notify("[提醒] 有一条通知");
      }
    });
    try {
      const result = await bundle.adapter.run(`开始。${"背景说明。".repeat(60)}`);
      assert.equal(result.status, "completed");
    } finally {
      await disposeRuntime(bundle);
    }
    assert.equal(main.length, 2);
    const texts = userTexts(main[1]);
    assert.match(
      texts.at(-2) ?? "",
      /^<pigeon-status>\n以下整段取代此前的全部开工状态。\n[\s\S]*约定一/
    );
    assert.match(texts.at(-1) ?? "", /有一条通知/);
  } finally {
    r.cleanup();
  }
});
