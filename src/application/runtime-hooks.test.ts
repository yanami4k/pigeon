// 运行面装配到钩子的接线（决策 324）：钩子输入的 permission_mode 取运行面的审批档；
// continue:false 在混合批次里停住整轮（只发一次模型请求、后续调用的钩子不执行、不弹审批）；
// 钩子记录的 Run 归属——Run 之外只有收尾类钩子挂刚结束的 Run，其余为会话级。
// 钩子脚本是真进程（临时目录 .mjs，经 node 启动）。
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { LayeredHook } from "../state/hooks.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { emptySettingsSnapshot, type SettingsSnapshot } from "../state/settings.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function hook(event: LayeredHook["event"], command: string): LayeredHook {
  return { event, command, host: false, layer: "project" };
}

function settingsWith(root: string, hooks: readonly LayeredHook[]): SettingsSnapshot {
  return { ...emptySettingsSnapshot(root), hooks };
}

// 本会话文件里的钩子记录（pigeon.hook 条目的 data）
function hookEntries(root: string, sessionId: SessionId): Array<Record<string, unknown>> {
  const sessionsDir = sessionsDirOf(root);
  const files = readdirSync(sessionsDir, { recursive: true })
    .map(String)
    .filter((name) => name.includes(sessionId) && name.endsWith(".jsonl"));
  assert.equal(files.length, 1, JSON.stringify(files));
  return readFileSync(join(sessionsDir, files[0] ?? ""), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { customType?: string; data?: Record<string, unknown> })
    .filter((entry) => entry.customType === "pigeon.hook")
    .map((entry) => entry.data ?? {});
}

test("钩子输入带运行面的审批档：非 yolo 为 prompt（经 buildRuntime 装配，不由测试注入）", async () => {
  const root = temp("pigeon-rt-hooks-");
  writeFileSync(join(root, "a.ts"), "alpha\n");
  const captured = join(root, "pre.json");
  const file = join(root, "pre.mjs");
  writeFileSync(
    file,
    [
      "import { writeFileSync } from 'node:fs';",
      "let data = '';",
      "process.stdin.on('data', (chunk) => (data += chunk)).on('end', () => {",
      `  writeFileSync(${JSON.stringify(captured)}, data);`,
      "});",
    ].join("\n")
  );
  const bundle = buildRuntime({
    streamFn: createFakeStreamFn({
      replies: [
        { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
        { text: "完" },
      ],
    }),
    workspaceRoot: root,
    settings: settingsWith(root, [hook("PreToolUse", `node "${file}"`)]),
    sessionId: newSessionId(),
    yolo: false,
    provider: "fake",
    modelId: "fake",
  });
  try {
    await bundle.adapter.run("读一下");
  } finally {
    await disposeRuntime(bundle);
  }
  const sent = JSON.parse(readFileSync(captured, "utf8")) as Record<string, unknown>;
  assert.equal(sent.permission_mode, "prompt");
});

test("混合批次里 PreToolUse continue:false：只发一次模型请求、后续调用的钩子不执行、不弹审批", async () => {
  const root = temp("pigeon-rt-hooks-batch-");
  for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(root, name), `${name}\n`);
  const seen = join(root, "seen.txt");
  const file = join(root, "pre-stop.mjs");
  // 记下每次被调用时的路径；b.ts 要求停止
  writeFileSync(
    file,
    [
      "import { appendFileSync } from 'node:fs';",
      "let data = '';",
      "process.stdin.on('data', (chunk) => (data += chunk)).on('end', () => {",
      "  const path = JSON.parse(data).tool_input.path;",
      `  appendFileSync(${JSON.stringify(seen)}, path + '\\n');`,
      "  if (path === 'b.ts') process.stdout.write(JSON.stringify({ continue: false, stopReason: '停-混合批' }));",
      "});",
    ].join("\n")
  );
  const asked: string[] = [];
  const streamFn = createFakeStreamFn({
    replies: [
      {
        text: "三连",
        toolCalls: [
          { name: "read_file", args: { path: "a.ts" } },
          { name: "read_file", args: { path: "b.ts" } },
          { name: "edit_file", args: { path: "c.ts", old_string: "c", new_string: "C" } },
        ],
      },
      { text: "不应再问" },
    ],
  });
  const bundle = buildRuntime({
    streamFn,
    workspaceRoot: root,
    settings: settingsWith(root, [hook("PreToolUse", `node "${file}"`)]),
    sessionId: newSessionId(),
    yolo: false,
    provider: "fake",
    modelId: "fake",
    editMode: "replace",
    createApprovalHandler: () => async (request) => {
      asked.push(request.toolName);
      return { approved: true };
    },
  });
  let result: Awaited<ReturnType<typeof bundle.adapter.run>>;
  try {
    result = await bundle.adapter.run("读改");
  } finally {
    await disposeRuntime(bundle);
  }
  assert.equal(streamFn.calls.length, 1, "整轮在这批工具后停下");
  assert.deepEqual(readFileSync(seen, "utf8").trim().split("\n"), ["a.ts", "b.ts"]);
  assert.deepEqual(asked, [], "停下后的调用不再请示");
  assert.equal(readFileSync(join(root, "c.ts"), "utf8"), "c.ts\n", "c.ts 未被改动");
  assert.equal(result.status, "aborted");
  assert.match(result.errorMessage ?? "", /钩子要求停止：停-混合批/);
});

test("钩子记录的 Run 归属：Run 外只有 Stop / StopFailure / SubagentStop / 自动压缩的 PostCompact 挂刚结束的 Run", async () => {
  const root = temp("pigeon-rt-hooks-runid-");
  const noop = join(root, "noop.mjs");
  writeFileSync(
    noop,
    "let data = '';\nprocess.stdin.on('data', (chunk) => (data += chunk)).on('end', () => {});\n"
  );
  const events: LayeredHook["event"][] = [
    "Stop",
    "StopFailure",
    "SubagentStop",
    "PostCompact",
    "UserPromptSubmit",
    "SessionEnd",
    "Notification",
    "PreCompact",
  ];
  const sessionId = newSessionId();
  const bundle = buildRuntime({
    streamFn: createFakeStreamFn({ replies: [{ text: "完" }] }),
    workspaceRoot: root,
    settings: settingsWith(
      root,
      events.map((event) => hook(event, `node "${noop}"`))
    ),
    sessionId,
    yolo: true,
    provider: "fake",
    modelId: "fake",
  });
  let runId: string;
  try {
    // Run 之前的钩子：会话级
    await bundle.hooks.runEvent("UserPromptSubmit", "", { prompt: "第一条" });
    runId = (await bundle.adapter.run("第一条")).runId;
    // Run 结束之后：收尾类挂刚结束的 Run
    await bundle.hooks.runEvent("Stop", "", { stop_hook_active: false });
    await bundle.hooks.runEvent("StopFailure", "", { error: "x" });
    await bundle.hooks.runEvent("SubagentStop", "", {});
    await bundle.hooks.runEvent("PostCompact", "auto", { trigger: "auto" });
    // 下一条消息、手动压缩、通知与会话结束：会话级
    await bundle.hooks.runEvent("UserPromptSubmit", "", { prompt: "第二条" });
    await bundle.hooks.runEvent("PreCompact", "manual", { trigger: "manual" });
    await bundle.hooks.runEvent("PostCompact", "manual", { trigger: "manual" });
    await bundle.hooks.runEvent("Notification", "permission_prompt", { message: "m" });
    await bundle.hooks.runEvent("SessionEnd", "exit", { reason: "exit" });
  } finally {
    await disposeRuntime(bundle);
  }
  const owners = hookEntries(root, sessionId).map((entry) => [entry.event, entry.runId ?? null]);
  assert.deepEqual(owners, [
    ["UserPromptSubmit", null],
    ["Stop", runId],
    ["StopFailure", runId],
    ["SubagentStop", runId],
    ["PostCompact", runId],
    ["UserPromptSubmit", null],
    ["PreCompact", null],
    ["PostCompact", null],
    ["Notification", null],
    ["SessionEnd", null],
  ]);
});

test("continue:false 停下时排队的通知不让循环继续，也不丢：留到下一次运行递出", async () => {
  const root = temp("pigeon-rt-hooks-notice-");
  writeFileSync(join(root, "a.ts"), "alpha\n");
  const file = join(root, "pre-stop.mjs");
  writeFileSync(
    file,
    [
      "let data = '';",
      "process.stdin.on('data', (chunk) => (data += chunk)).on('end', () => {",
      "  process.stdout.write(JSON.stringify({ continue: false, stopReason: '停-通知' }));",
      "});",
    ].join("\n")
  );
  const streamFn = createFakeStreamFn({
    replies: [
      { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { text: "下一次" },
    ],
  });
  const bundle = buildRuntime({
    streamFn,
    workspaceRoot: root,
    settings: settingsWith(root, [hook("PreToolUse", `node "${file}"`)]),
    sessionId: newSessionId(),
    yolo: true,
    provider: "fake",
    modelId: "fake",
  });
  try {
    // 这一轮收尾时递一条通知（照 worker 完成通知的时机：轮末转入上游的 steer 队列）
    const off = bundle.adapter.subscribeRounds(() => {
      bundle.adapter.notify("NOTICE-停下时排队");
      off();
    });
    const stopped = await bundle.adapter.run("读一下");
    assert.equal(stopped.status, "aborted");
    assert.equal(streamFn.calls.length, 1, "排队的通知不让停下的循环再问模型");
    assert.equal(bundle.adapter.pendingNotices(), 1, "通知留待下一次运行");
    await bundle.adapter.run("接着");
    const texts = JSON.stringify(streamFn.calls[1]?.context.messages ?? []);
    assert.ok(texts.includes("NOTICE-停下时排队"), texts);
  } finally {
    await disposeRuntime(bundle);
  }
});
