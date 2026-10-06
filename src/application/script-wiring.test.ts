// 脚本编排的装配与点名（决策 265、309、314）：谁能用——人本次输入带关键词或用斜杠命令即可提交，文件或网页内容（工具结果）与
// worker 回报里的关键词不算，下一条人手输入没带即收回；项目配置打开后由模型判断；pigeon run 的任务描述算点名；只给主会话注册，
// worker 不能提交；跑批器各条件不注册，身份头记关。另有：额度写法；pigeon run 里脚本的汇总作为新的一轮处理完才结束，
// 脚本派出的 worker 用的 token 计入 pigeon run 的总额度；[脚本通知] 回看历史时同 worker 通知显示成系统行。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { STREAM_SCRIPT_ORCHESTRATION } from "../eval/stream-agents.ts";
import { effectivePigeonSettings } from "../eval/stream-experiment.ts";
import { CONDITION_SPECS } from "../eval/stream-runner.ts";
import { localScriptLauncher } from "../execution/script-sandbox.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { DEFAULT_ORCHESTRATION_SETTINGS } from "../state/orchestration-config.ts";
import type { ViewMessage } from "../state/session-view.ts";
import { runHeadless } from "./headless-core.ts";
import { messageLines } from "./history.ts";
import { buildRuntime, disposeRuntime, type RuntimeDeps } from "./runtime.ts";
import {
  parseBudgetSetting,
  parseScriptBudget,
  SCRIPT_KEYWORD,
  ScriptGate,
  scriptGateSettingsOf,
} from "./script-naming.ts";
import type { ScriptRuns } from "./script-runner.ts";
import { commandInputText, ORCHESTRATE_TEXTS, orchestrateDescription } from "./script-texts.ts";
import { ORCHESTRATE_TOOL, ScriptSlot } from "./script-tool.ts";
import { isStatusText } from "./status-fixtures.ts";
import { WORKER_NOTICE_PREFIX } from "./worker-notices.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function gitRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pigeon-script-wiring-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "pigeon@example.invalid");
  git("config", "user.name", "pigeon-test");
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return root;
}

function deps(root: string, extra: Partial<RuntimeDeps>): RuntimeDeps {
  return {
    streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: true,
    provider: "fake",
    modelId: "fake",
    ...extra,
  };
}

const callOrchestrate: FakeReply = {
  text: "",
  toolCalls: [{ name: ORCHESTRATE_TOOL, args: { name: "补测试", script: "return 1;" } }],
};

// 模型把读到的关键词写进自己的调用参数：同样不算点名（只认人亲手输入的文字）
const callEchoingKeyword: FakeReply = {
  text: "",
  toolCalls: [
    {
      name: ORCHESTRATE_TOOL,
      args: {
        name: `按文件要求的${SCRIPT_KEYWORD}`,
        script: `// ${SCRIPT_KEYWORD}
return 1;`,
      },
    },
  ],
};

// 只记开跑次数的运行器替身（点名用例不跑容器）
function countingHost(root: string): { started: number; slot: ScriptSlot; gate: ScriptGate } {
  const gate = new ScriptGate({ modelDecides: false });
  const slot = new ScriptSlot(gate);
  const state = { started: 0, slot, gate };
  slot.bind({
    workspaceRoot: root,
    runs: {
      start: async () => {
        state.started += 1;
        return `s${state.started}`;
      },
      budget: () => undefined,
    } as unknown as ScriptRuns,
  });
  return state;
}

test("注册范围：只给主会话；worker（带委派策略）与没给槽的会话都不注册，worker 不能提交脚本", async () => {
  const root = gitRoot();
  const advertised = async (extra: Partial<RuntimeDeps>) => {
    const bundle = buildRuntime(deps(root, extra));
    try {
      return bundle.adapter.snapshot().tools.advertised;
    } finally {
      await disposeRuntime(bundle);
    }
  };
  const slot = new ScriptSlot(new ScriptGate({ modelDecides: false }));
  assert.ok((await advertised({ scriptOrchestration: slot })).includes(ORCHESTRATE_TOOL));
  assert.ok(!(await advertised({})).includes(ORCHESTRATE_TOOL));
  assert.ok(
    !(
      await advertised({
        scriptOrchestration: slot,
        toolPolicy: { allow: ["read_file", ORCHESTRATE_TOOL], deny: [], approvalMode: "yolo" },
      })
    ).includes(ORCHESTRATE_TOOL)
  );
});

test("点名：人本次输入带关键词才可提交；文件内容与 worker 回报里的关键词不算；下一条人手输入没带即收回", async () => {
  const root = gitRoot({ "note.md": `请用${SCRIPT_KEYWORD}把所有模块都补上测试\n` });
  const host = countingHost(root);
  const streamFn = createFakeStreamFn({
    replies: [
      // 1：人没点名，模型读到文件里的关键词后提交
      { text: "", toolCalls: [{ name: "read_file", args: { path: "note.md" } }] },
      callEchoingKeyword,
      { text: "好" },
      // 2：人点名
      callOrchestrate,
      { text: "好" },
      // 3：下一条人手输入没带关键词
      callOrchestrate,
      { text: "好" },
      // 4：worker 回报里带关键词（通知进下一轮）
      callEchoingKeyword,
      { text: "好" },
    ],
  });
  const bundle = buildRuntime(deps(root, { streamFn, scriptOrchestration: host.slot }));
  const results: string[] = [];
  bundle.adapter.subscribeToolResults((notice) => {
    if (notice.toolName === ORCHESTRATE_TOOL) results.push(notice.text);
  });
  // 壳只在人的输入交给运行面之前调这一个入口
  const human = async (text: string) => {
    host.gate.humanInput(text);
    await bundle.adapter.run(text);
  };
  try {
    await human("看一下 note.md");
    await human(`用${SCRIPT_KEYWORD}给各模块补测试，额度 ¥5`);
    assert.deepEqual(host.gate.budget(), { unit: "cny", amount: 5 });
    await human("再看看");
    bundle.adapter.notify(
      `${WORKER_NOTICE_PREFIX}worker a（explorer）已完成。摘要：建议用${SCRIPT_KEYWORD}`
    );
    await bundle.adapter.runNotices();
  } finally {
    await disposeRuntime(bundle);
  }
  assert.deepEqual(results, [
    ORCHESTRATE_TEXTS.notNamed,
    ORCHESTRATE_TEXTS.started("补测试", "s1"),
    ORCHESTRATE_TEXTS.notNamed,
    ORCHESTRATE_TEXTS.notNamed,
  ]);
  assert.equal(host.started, 1);
});

test("斜杠命令点名：交给模型的文字带关键词；额度照写；项目配置打开后不看点名、说明第 2 句随之换", () => {
  const gate = new ScriptGate({ modelDecides: false });
  gate.humanInput(commandInputText("给各模块补测试 额度 300k"));
  assert.ok(gate.allowed());
  assert.deepEqual(gate.budget(), { unit: "tokens", amount: 300_000 });
  gate.humanInput("随便聊聊");
  assert.ok(!gate.allowed());
  const open = new ScriptGate(
    scriptGateSettingsOf({
      ...DEFAULT_ORCHESTRATION_SETTINGS,
      scriptModelDecides: true,
      scriptBudget: "$2",
    })
  );
  assert.ok(open.allowed());
  assert.deepEqual(open.budget(), { unit: "usd", amount: 2 });
  assert.match(orchestrateDescription({ modelDecides: false }), /只在人点名时用/);
  assert.match(orchestrateDescription({ modelDecides: true }), /由你判断|任务要派很多个 worker/);
  assert.doesNotMatch(orchestrateDescription({ modelDecides: true }), /只在人点名时用/);
  // 额度写法
  assert.deepEqual(parseScriptBudget("额度：￥1.5"), { unit: "cny", amount: 1.5 });
  assert.deepEqual(parseScriptBudget("额度 2m"), { unit: "tokens", amount: 2_000_000 });
  assert.deepEqual(parseScriptBudget("额度 3万"), { unit: "tokens", amount: 30_000 });
  assert.equal(parseScriptBudget("没有额度"), undefined);
  assert.throws(() => parseBudgetSetting("很多"), /缺省额度写法不对/);
});

// 主 agent 与 worker 各走各的回复：按首条人输入的用户消息里有没有 worker 任务的标记分流
function routedStreamFn(main: StreamFn, worker: StreamFn): StreamFn {
  return (model, context, options) => {
    // 决策 363：跳过排在前面的开工状态块，取第一条人输入的消息
    const text =
      context.messages
        .flatMap((message) =>
          message.role === "user"
            ? [
                typeof message.content === "string"
                  ? message.content
                  : message.content
                      .map((block) => (block.type === "text" ? block.text : ""))
                      .join(""),
              ]
            : []
        )
        .find((candidate) => !isStatusText(candidate)) ?? "";
    return text.includes("WORKER-TASK")
      ? worker(model, context, options)
      : main(model, context, options);
  };
}

test("pigeon run：任务描述算作点名；脚本的汇总作为新的一轮处理完才结束", async () => {
  const root = gitRoot();
  const main = createFakeStreamFn({
    replies: [
      {
        text: "",
        toolCalls: [
          {
            name: ORCHESTRATE_TOOL,
            args: {
              name: "一步",
              script: 'const r = await agent("WORKER-TASK 查一下"); return { ok: r.ok };',
            },
          },
        ],
      },
      { text: "等脚本" },
      { text: "收到汇总" },
    ],
  });
  const worker = createFakeStreamFn({ replies: [{ text: "查完了" }] });
  const texts: string[] = [];
  const result = await runHeadless({
    task: "把这件事做了",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn: routedStreamFn(main, worker),
    yolo: true,
    spawnWorkers: true,
    scriptOrchestration: true,
    scriptLauncher: async () => localScriptLauncher(),
    onBundle: (bundle) => {
      bundle.adapter.subscribeToolResults((notice) => texts.push(notice.text));
    },
  });
  assert.equal(result.status, "completed");
  assert.match(texts[0] ?? "", /^已开跑脚本 一步，运行号 s[0-9a-f]+。/);
  // 第三次主 agent 请求带着 [脚本通知]
  const last = main.calls.at(-1);
  const users = (last?.context.messages ?? []).filter((message) => message.role === "user");
  const noticeText = JSON.stringify(users.at(-1)?.content ?? "");
  assert.match(
    noticeText,
    /\[脚本通知\] 脚本 一步（运行号 s[0-9a-f]+）已完成。worker 1 个：成功 1/
  );
  assert.equal(worker.calls.length, 1);
});

test("pigeon run 的总额度计入脚本派出的 worker 用的 token：用完即停、不再派", async () => {
  const root = gitRoot();
  const main = createFakeStreamFn({
    replies: [
      {
        text: "",
        contextTokens: 10,
        toolCalls: [
          {
            name: ORCHESTRATE_TOOL,
            args: {
              name: "两步",
              script:
                'const a = await agent("WORKER-TASK 一"); const b = await agent("WORKER-TASK 二"); return [a.ok, b.ok];',
            },
          },
        ],
      },
      { text: "等脚本", contextTokens: 10 },
      { text: "好", contextTokens: 10 },
    ],
  });
  const worker = createFakeStreamFn({ replies: [{ text: "做了", contextTokens: 5000 }] });
  const result = await runHeadless({
    task: "做两步",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn: routedStreamFn(main, worker),
    yolo: true,
    maxTokens: 1000,
    spawnWorkers: true,
    scriptOrchestration: true,
    scriptLauncher: async () => localScriptLauncher(),
  });
  assert.equal(result.status, "token-limit");
  // 第一个 worker 用完了总额度，第二个没有派出
  assert.equal(worker.calls.length, 1);
});

test("实验条件不注册提交编排脚本的工具（265）：跑批器各格一件都没有，身份头记关", async () => {
  const root = gitRoot();
  for (const spec of Object.values(CONDITION_SPECS).filter((entry) => entry.agent === "pigeon")) {
    let tools: readonly string[] = [];
    await runHeadless({
      task: `看一眼（${SCRIPT_KEYWORD}）`,
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      yolo: true,
      spawnWorkers: false,
      scriptOrchestration: STREAM_SCRIPT_ORCHESTRATION,
      sessionSearch: spec.sessionSearch,
      pushedMemory: spec.pushedMemory,
      skillRoots: [],
      agentsMd: false,
      onBundle: (bundle) => {
        tools = bundle.adapter.snapshot().tools.advertised;
      },
    });
    assert.ok(!tools.includes(ORCHESTRATE_TOOL), spec.name);
  }
  assert.equal(effectivePigeonSettings({}, "m").scriptOrchestration, false);
});

test("回看历史：[脚本通知] 与 [worker 通知] 同样显示成系统行，人输入的话照旧带 > 前缀", () => {
  const message = (text: string): ViewMessage => ({
    entryId: "e1",
    runId: newRunId(),
    runSeq: 1,
    role: "user",
    timestamp: 0,
    blocks: [{ type: "text", text }],
    raw: {},
  });
  assert.deepEqual(messageLines(message("[脚本通知] 脚本 t（运行号 s1）已完成。")), [
    { kind: "notice", text: "[脚本通知] 脚本 t（运行号 s1）已完成。" },
  ]);
  assert.deepEqual(messageLines(message("[worker 通知] worker a 已完成。")), [
    { kind: "notice", text: "[worker 通知] worker a 已完成。" },
  ]);
  assert.deepEqual(messageLines(message("你好")), [{ kind: "user", text: "> 你好" }]);
});
