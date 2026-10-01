// 会话级钩子在 headless 运行入口的接线（决策 323 / 324）：SessionStart 的纯文本 stdout 并进第一条输入、
// UserPromptSubmit 退出码 2 拦下一轮都不跑、Stop 拦截后理由作为新一轮输入接着干、连续拦截到 stopHookBlockCap、
// SessionEnd 收尾被调用（reason=exit）、StopFailure 在 Run 出错收尾时被调用。
// 钩子脚本全部是真进程（临时目录 .mjs，经 node 启动），事件信息以 JSON 经标准输入交给脚本。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createFakeStreamFn, type FakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { LayeredHook } from "../state/hooks.ts";
import { emptySettingsSnapshot, type SettingsSnapshot } from "../state/settings.ts";
import { runHeadless } from "./headless-core.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-hook-headless-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-hook-headless-home-"));
  made.push(root, home);
  return { root, home };
}

function script(dir: string, name: string, lines: readonly string[]): string {
  const file = join(dir, name);
  writeFileSync(file, lines.join("\n"));
  return file;
}

// 把标准输入（事件 JSON）原样落盘，供测试核对脚本收到的字段
function captureStdinScript(target: string): readonly string[] {
  return [
    "import { writeFileSync } from 'node:fs';",
    "let data = '';",
    "process.stdin.on('data', (chunk) => (data += chunk)).on('end', () => {",
    `  writeFileSync(${JSON.stringify(target)}, data);`,
    "});",
  ];
}

function hook(
  event: LayeredHook["event"],
  command: string,
  extra: Partial<LayeredHook> = {}
): LayeredHook {
  return { event, command, host: false, layer: "project", ...extra };
}

function settingsWith(
  root: string,
  hooks: readonly LayeredHook[],
  merged: Partial<SettingsSnapshot["merged"]> = {}
): SettingsSnapshot {
  const base = emptySettingsSnapshot(root);
  return { ...base, hooks, merged: { ...base.merged, ...merged } };
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        text += block.text;
      }
    }
    return text;
  }
  return "";
}

function userTexts(call: FakeStreamFn["calls"][number] | undefined): string[] {
  const texts: string[] = [];
  for (const message of call?.context.messages ?? []) {
    if (message.role !== "user") continue;
    texts.push(blockText(message.content));
  }
  return texts;
}

test("SessionStart（startup）：stdout 纯文本并进第一条输入，脚步收到的 source 为 startup", async () => {
  const { root, home } = workspace();
  const stdinFile = join(root, "session-start.json");
  const file = script(root, "start.mjs", [
    ...captureStdinScript(stdinFile),
    "process.stdout.write('SS-CONTEXT-词');",
  ]);
  const streamFn = createFakeStreamFn({ replies: [{ text: "收到" }] });
  const result = await runHeadless({
    task: "把 beta 改成 BETA",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn,
    yolo: true,
    homeDir: home,
    // matcher 匹配 SessionStart 的 source 取值；用 "startup" 同时验证匹配对象就是 source
    settings: settingsWith(root, [hook("SessionStart", `node "${file}"`, { matcher: "startup" })]),
  });
  assert.equal(result.status, "completed");
  const first = userTexts(streamFn.calls[0])[0] ?? "";
  assert.ok(first.includes("SS-CONTEXT-词"), first);
  assert.ok(first.includes("把 beta 改成 BETA"), first);
  const sent = JSON.parse(readFileSync(stdinFile, "utf8")) as Record<string, unknown>;
  assert.equal(sent.hook_event_name, "SessionStart");
  assert.equal(sent.source, "startup");
  assert.equal(sent.cwd, root);
  assert.equal(typeof sent.session_id, "string");
});

test("UserPromptSubmit 退出码 2：一轮都不跑，status aborted，errorMessage 含脚本 stderr 的理由", async () => {
  const { root, home } = workspace();
  const file = script(root, "prompt.mjs", [
    "let data = '';",
    "process.stdin.on('data', (chunk) => (data += chunk)).on('end', () => {",
    "  process.stderr.write('UPS-这条输入不合规');",
    "  process.exit(2);",
    "});",
  ]);
  const streamFn = createFakeStreamFn({ replies: [{ text: "不会到这" }] });
  const result = await runHeadless({
    task: "做点什么",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn,
    yolo: true,
    homeDir: home,
    settings: settingsWith(root, [hook("UserPromptSubmit", `node "${file}"`)]),
  });
  assert.equal(result.status, "aborted");
  assert.equal(streamFn.calls.length, 0, "被 UserPromptSubmit 拦下时一轮都不跑");
  assert.match(result.errorMessage ?? "", /输入被钩子拦下：UPS-这条输入不合规/);
});

test("Stop 拦截一次后放行：第一次退出码 2 的理由成为第二轮输入，随后 completed", async () => {
  const { root, home } = workspace();
  const counterFile = join(root, "stop-count.txt");
  const file = script(root, "stop.mjs", [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "let data = '';",
    "process.stdin.on('data', (chunk) => (data += chunk)).on('end', () => {",
    "  const counter = process.argv[2];",
    "  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;",
    "  writeFileSync(counter, String(n + 1));",
    "  if (n === 0) {",
    "    process.stderr.write('接着干-STOP理由');",
    "    process.exit(2);",
    "  }",
    "});",
  ]);
  const streamFn = createFakeStreamFn({ replies: [{ text: "一轮回复" }] });
  const result = await runHeadless({
    task: "干活",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn,
    yolo: true,
    homeDir: home,
    settings: settingsWith(root, [hook("Stop", `node "${file}" "${counterFile}"`)]),
  });
  assert.equal(result.status, "completed");
  assert.equal(streamFn.calls.length, 2, "第一次 Stop 拦截后开了第二个 Run");
  const secondUsers = userTexts(streamFn.calls[1]);
  assert.ok(
    secondUsers.some((text) => text.includes("接着干-STOP理由")),
    JSON.stringify(secondUsers)
  );
  assert.equal(
    readFileSync(counterFile, "utf8"),
    "2",
    "Stop 脚本被调用两次（第一次拦、第二次放行）"
  );
});

test("Stop 连续拦截到上限：stopHookBlockCap=2 → status stop-hook-limit、共开 1+2 个 Run", async () => {
  const { root, home } = workspace();
  const file = script(root, "stop-always.mjs", [
    "let data = '';",
    "process.stdin.on('data', (chunk) => (data += chunk)).on('end', () => {",
    "  process.stderr.write('永不停止');",
    "  process.exit(2);",
    "});",
  ]);
  const streamFn = createFakeStreamFn({ replies: [{ text: "一轮" }] });
  const result = await runHeadless({
    task: "干活",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn,
    yolo: true,
    homeDir: home,
    settings: settingsWith(root, [hook("Stop", `node "${file}"`)], { stopHookBlockCap: 2 }),
  });
  assert.equal(result.status, "stop-hook-limit");
  assert.equal(streamFn.calls.length, 3, "初始 1 个 Run + 上限 2 次拦截各开一个");
  // 上限那一次不再理会：理由不进入再下一轮
  assert.ok(userTexts(streamFn.calls[2]).some((text) => text.includes("永不停止")));
});

test("SessionEnd：运行结束后脚本被调用一次，脚步收到的 reason 为 exit", async () => {
  const { root, home } = workspace();
  const stdinFile = join(root, "session-end.json");
  const file = script(root, "end.mjs", captureStdinScript(stdinFile));
  const result = await runHeadless({
    task: "干完就收",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn: createFakeStreamFn({ replies: [{ text: "完成" }] }),
    yolo: true,
    homeDir: home,
    settings: settingsWith(root, [hook("SessionEnd", `node "${file}"`, { timeoutMs: 20_000 })]),
  });
  assert.equal(result.status, "completed");
  assert.ok(existsSync(stdinFile), "运行结束后 SessionEnd 脚本应被调用");
  const sent = JSON.parse(readFileSync(stdinFile, "utf8")) as Record<string, unknown>;
  assert.equal(sent.hook_event_name, "SessionEnd");
  assert.equal(sent.reason, "exit");
});

test("StopFailure：Run 以 failed 收尾时脚本被调用，error 字段非空", async () => {
  const { root, home } = workspace();
  const stdinFile = join(root, "stop-failure.json");
  const file = script(root, "stop-failure.mjs", captureStdinScript(stdinFile));
  const result = await runHeadless({
    task: "干不了",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn: createFakeStreamFn({
      replies: [{ text: "不会用到" }],
      failOnCall: 1,
      failureMessage: "模拟 provider 故障",
    }),
    yolo: true,
    homeDir: home,
    settings: settingsWith(root, [hook("StopFailure", `node "${file}"`)]),
  });
  assert.equal(result.status, "failed");
  assert.ok(existsSync(stdinFile), "Run 出错收尾时 StopFailure 脚本应被调用");
  const sent = JSON.parse(readFileSync(stdinFile, "utf8")) as Record<string, unknown>;
  assert.equal(sent.hook_event_name, "StopFailure");
  assert.ok(typeof sent.error === "string" && sent.error.length > 0, JSON.stringify(sent));
  assert.match(String(sent.error), /模拟 provider 故障/);
});
