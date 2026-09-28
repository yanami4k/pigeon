// 主 agent 派 worker 的端到端（决策 264、267）：pigeon run 子进程里，主 agent 同一次回复派出两个 worker，二者并行完成，
// 结果作为工具返回值交回，主 agent 再用 run_command 合并其中一个分支。另钉住缺省入口：pigeon 不带子命令进终端界面，
// pigeon --line 进命令行对话，--help 列出入口。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseLaunchFlags, spawnWorkerLimitsOf } from "../application/launch-flags.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { routeTopLevel, TOP_LEVEL_HELP, TUI_ENTRY } from "./index.ts";

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
const FIXTURES = pathToFileURL(
  fileURLToPath(new URL("../pi-runtime/fixtures.ts", import.meta.url))
).href;

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function runCli(args: string[], input = "") {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input,
    timeout: 120_000,
    windowsHide: true,
  });
}

// 假模型模块：按会话的第一条用户消息分派剧本。worker A 的第一次请求要等 worker B 发出第一次请求才继续——
// 两个派出串行执行时 A 等不到 B，超时后在摘要里记"串行"
function writeStreamFnModule(dir: string): string {
  const file = join(dir, "fake-stream-fn.mjs");
  const merge =
    "cd .pigeon/worktrees/*-fix-a && git add -A && git commit -qm fix-a && cd ../../.. && git merge -q --no-edit pigeon/fix-a";
  writeFileSync(
    file,
    `import { createFakeStreamFn } from ${JSON.stringify(FIXTURES)};
const main = createFakeStreamFn({ replies: [
  { text: "派两个", toolCalls: [
    { name: "spawn_worker", args: { role: "implementer", task: "WORKER-A 把 a.txt 里的 a 改成 A", name: "fix-a" } },
    { name: "spawn_worker", args: { role: "implementer", task: "WORKER-B 把 b.txt 里的 b 改成 B", name: "fix-b" } },
  ] },
  { text: "合并 A", toolCalls: [{ name: "run_command", args: { command: ${JSON.stringify(merge)} } }] },
  { text: "合并完成" },
] });
const aReplies = [
  { text: "改", toolCalls: [{ name: "edit_file", args: { path: "a.txt", old_string: "a", new_string: "A" } }] },
  { text: "A 改好了" },
];
const a = createFakeStreamFn({ replies: aReplies });
const b = createFakeStreamFn({ replies: [
  { text: "改", toolCalls: [{ name: "edit_file", args: { path: "b.txt", old_string: "b", new_string: "B" } }] },
  { text: "B 改好了" },
] });
let bStarted;
const bStartedP = new Promise((resolve) => { bStarted = resolve; });
let aFirst = true;
function firstUser(context) {
  const user = context.messages.find((m) => m.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content.map((c) => c.text ?? "").join("");
}
export default async function (model, context, options) {
  const text = firstUser(context);
  if (text.includes("WORKER-B")) { bStarted(); return b(model, context, options); }
  if (text.includes("WORKER-A")) {
    if (aFirst) {
      aFirst = false;
      const parallel = await Promise.race([bStartedP.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
      aReplies[1].text = parallel ? "A 改好了（并行）" : "A 改好了（串行）";
    }
    return a(model, context, options);
  }
  return main(model, context, options);
}
`
  );
  return file;
}

test("pigeon run：主 agent 同一次回复派两个 worker，并行完成、结果交回，再用 run_command 合并其中一个分支", {
  skip: process.platform === "win32" ? "合并命令用 sh 的通配与串联" : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-spawn-cli-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\nfake-stream-fn.mjs\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  const streamFn = writeStreamFnModule(root);
  const child = runCli([
    "run",
    "MAIN 并行改 a 与 b，再合并 a",
    "--root",
    root,
    "--stream-fn",
    streamFn,
    "--yolo",
    "--json",
    "--no-pushed-memory",
  ]);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const lines = child.stdout.trim().split(/\r?\n/);
  const result = JSON.parse(lines[lines.length - 1] ?? "") as { status: string; sessionId: string };
  assert.equal(result.status, "completed");
  const view = loadSessionView(join(root, ".pigeon", "sessions"), result.sessionId);
  assert.ok(view !== undefined);
  const calls = view.runs.flatMap((run) => run.toolCalls);
  const textOf = (call: (typeof calls)[number]) =>
    ((call.result?.raw as { content?: Array<{ text?: string }> } | undefined)?.content ?? [])
      .map((block) => block.text ?? "")
      .join("");
  assert.deepEqual(calls.filter((call) => call.toolName === "spawn_worker").map(textOf), [
    "worker fix-a（implementer）已完成。分支：pigeon/fix-a。改动的文件（1）：a.txt。摘要：A 改好了（并行）",
    "worker fix-b（implementer）已完成。分支：pigeon/fix-b。改动的文件（1）：b.txt。摘要：B 改好了",
  ]);
  const merge = calls.find((call) => call.toolName === "run_command");
  assert.ok(merge !== undefined);
  assert.notEqual(merge.result?.isError, true, textOf(merge));
  // 合并了 A，没有合并 B
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "A\n");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "b\n");
  assert.match(git(root, ["log", "--format=%s"]), /^fix-a$/m);
});

test("缺省入口：pigeon 不带子命令进终端界面，--line 进命令行对话，子命令照旧", () => {
  assert.deepEqual(routeTopLevel([]), { kind: "tui", argv: [] });
  assert.deepEqual(routeTopLevel(["--yolo", "--root", "x"]), {
    kind: "tui",
    argv: ["--yolo", "--root", "x"],
  });
  assert.deepEqual(routeTopLevel(["--line", "--yolo"]), { kind: "line", argv: ["--yolo"] });
  assert.deepEqual(routeTopLevel(["--yolo", "--line"]), { kind: "line", argv: ["--yolo"] });
  for (const sub of ["run", "resume", "trace", "replay", "session", "sandbox", "eval"]) {
    assert.deepEqual(routeTopLevel([sub, "--line"]), { kind: "subcommand" }, sub);
  }
  assert.deepEqual(routeTopLevel(["--help"]), { kind: "help" });
  assert.ok(TUI_ENTRY.endsWith(join("tui", "main.ts")));
});

test("pigeon --help 列出终端界面、--line 与各子命令", () => {
  const child = runCli(["--help"]);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), TOP_LEVEL_HELP.trim());
  assert.match(child.stdout, /pigeon --line/);
  assert.match(child.stdout, /--no-spawn-workers/);
});

test("pigeon 带未知参数：交给终端界面报错，提示里有命令行对话的入口", () => {
  const child = runCli(["--no-such-flag"]);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /未知参数：--no-such-flag/);
  assert.match(child.stderr, /用法：pigeon \[--yolo\]/);
  assert.match(child.stderr, /命令行对话用 pigeon --line/);
});

test("pigeon --line：进命令行对话（读到输入结束即退出）；它不接受 --no-spawn-workers", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-line-"));
  roots.push(root);
  const stream = join(root, "fake.mjs");
  writeFileSync(
    stream,
    `import { createFakeStreamFn } from ${JSON.stringify(FIXTURES)};\nexport default createFakeStreamFn({ replies: [{ text: "好" }] });\n`
  );
  const child = runCli(["--line", "--root", root, "--stream-fn", stream], "");
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const rejected = runCli(["--line", "--root", root, "--stream-fn", stream, "--no-spawn-workers"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /未知参数：--no-spawn-workers（pigeon --line 支持/);
});

test("启动参数：--no-spawn-workers 只在能派 worker 的入口接受，缺省开着", () => {
  assert.equal(parseLaunchFlags([], { usage: "u", spawnWorkers: true }).spawnWorkers, true);
  assert.equal(
    parseLaunchFlags(["--no-spawn-workers"], { usage: "u", spawnWorkers: true }).spawnWorkers,
    false
  );
  assert.throws(() => parseLaunchFlags(["--no-spawn-workers"], { usage: "u" }), /未知参数/);
});

test("启动参数：--worker-concurrency 与 --worker-limit 调两个上限，缺省 4 与 16；只在能派 worker 的入口接受", () => {
  assert.deepEqual(spawnWorkerLimitsOf(parseLaunchFlags([], { usage: "u", spawnWorkers: true })), {
    maxConcurrent: 4,
    maxAgentSpawns: 16,
  });
  assert.deepEqual(
    spawnWorkerLimitsOf(
      parseLaunchFlags(["--worker-concurrency", "2", "--worker-limit", "5"], {
        usage: "u",
        spawnWorkers: true,
      })
    ),
    { maxConcurrent: 2, maxAgentSpawns: 5 }
  );
  for (const bad of ["0", "1.5", "x"]) {
    assert.throws(
      () => parseLaunchFlags(["--worker-limit", bad], { usage: "u", spawnWorkers: true }),
      /--worker-limit 需要正整数/
    );
  }
  assert.throws(() => parseLaunchFlags(["--worker-concurrency", "2"], { usage: "u" }), /未知参数/);
});

test("pigeon run --worker-limit 1：同一次回复派两个，第二个按冻结文字拒绝", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-spawn-limit-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\nfake.mjs\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  const stream = join(root, "fake.mjs");
  writeFileSync(
    stream,
    `import { createFakeStreamFn } from ${JSON.stringify(FIXTURES)};
const main = createFakeStreamFn({ replies: [
  { text: "派两个", toolCalls: [
    { name: "spawn_worker", args: { role: "explorer", task: "WORKER 看 a", name: "look-a" } },
    { name: "spawn_worker", args: { role: "explorer", task: "WORKER 看 b", name: "look-b" } },
  ] },
  { text: "收到" },
] });
const worker = createFakeStreamFn({ replies: [{ text: "看过了" }] });
export default (model, context, options) => {
  const user = context.messages.find((m) => m.role === "user");
  const text = typeof user.content === "string" ? user.content : user.content.map((c) => c.text ?? "").join("");
  return (text.includes("WORKER") ? worker : main)(model, context, options);
};
`
  );
  const child = runCli([
    "run",
    "MAIN 派两个",
    "--root",
    root,
    "--stream-fn",
    stream,
    "--yolo",
    "--json",
    "--no-pushed-memory",
    "--worker-limit",
    "1",
  ]);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const lines = child.stdout.trim().split(/\r?\n/);
  const result = JSON.parse(lines[lines.length - 1] ?? "") as { sessionId: string };
  const view = loadSessionView(join(root, ".pigeon", "sessions"), result.sessionId);
  assert.ok(view !== undefined);
  const texts = view.runs
    .flatMap((run) => run.toolCalls)
    .filter((call) => call.toolName === "spawn_worker")
    .map((call) =>
      ((call.result?.raw as { content?: Array<{ text?: string }> } | undefined)?.content ?? [])
        .map((block) => block.text ?? "")
        .join("")
    );
  assert.deepEqual(texts, [
    "worker look-a（explorer）已完成。分支：pigeon/look-a。改动的文件（0）：无。摘要：看过了",
    "本次运行派出的 worker 已达 1 个上限。不要再派；用已有的结果，或自己完成。",
  ]);
});
