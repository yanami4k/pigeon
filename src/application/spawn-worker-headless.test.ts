// pigeon run 里主 agent 派 worker（决策 264–268）：真实编排器与 git 工作树、假模型。worker 的 token 计入本次运行的
// token 上限，撞了即停掉主 agent 与在跑的 worker、交回额度用完的文字；主 agent 撞上自己的时间上限时正在等的 worker
// 一并取消；多份尝试按验证命令给每份标签。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { createFakeStreamFn, type FakeStreamBehavior } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { runHeadlessOnce } from "./headless-core.ts";
import { SPAWN_WORKER_TEXTS } from "./spawn-worker-tool.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

// 有一个提交的 git 仓库（worker 从当前提交开工）；.pigeon/ 不进版本
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pigeon-spawn-headless-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(root, file), content);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  return root;
}

// 按会话的第一条用户消息分派剧本：主会话与各 worker 各走各的回复队列
function firstUserText(context: Parameters<StreamFn>[1]): string {
  const user = context.messages.find((message) => message.role === "user");
  if (user === undefined) return "";
  const content = (user as { content: unknown }).content;
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>)
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
}

function routed(
  scripts: Array<[marker: string, behavior: FakeStreamBehavior | StreamFn, delayMs?: number]>
): StreamFn {
  const fns = scripts.map(
    ([marker, behavior, delayMs]) =>
      [
        marker,
        typeof behavior === "function" ? behavior : createFakeStreamFn(behavior),
        delayMs,
      ] as const
  );
  return (async (model, context, options) => {
    const text = firstUserText(context);
    const match = fns.find(([marker]) => text.includes(marker));
    if (match === undefined) {
      throw new Error(`没有剧本：${text}`);
    }
    if (match[2] !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, match[2]));
    }
    return match[1](model, context, options);
  }) as StreamFn;
}

// 同一剧本的几个会话各按自己的进度回复：还没有工具结果时回 first，有了回 then（多份尝试共用同一任务说明）
function staged(first: FakeStreamBehavior, then: FakeStreamBehavior): StreamFn {
  const opening = createFakeStreamFn(first);
  const closing = createFakeStreamFn(then);
  return ((model, context, options) =>
    context.messages.some((message) => message.role === "toolResult")
      ? closing(model, context, options)
      : opening(model, context, options)) as StreamFn;
}

// 主会话里 spawn_worker 的工具结果文字
function spawnResults(root: string, sessionId: string): string[] {
  const view = loadSessionView(join(root, ".pigeon", "sessions"), sessionId);
  assert.ok(view !== undefined);
  return view.runs
    .flatMap((run) => run.toolCalls)
    .filter((call) => call.toolName === "spawn_worker")
    .map((call) => {
      const raw = call.result?.raw as
        | { content?: Array<{ type: string; text?: string }> }
        | undefined;
      return (raw?.content ?? []).map((block) => block.text ?? "").join("");
    });
}

// 决策 279：每段返回文字末尾另起一行写起点与取用方式（提交号随仓库变）；比对定稿文字时去掉这一行，格式另在一处专门核对
const START_LINE =
  /\n起点：(提交|快照) [0-9a-f]{12}（(派出时没有未提交的文件|含派出时 \d+ 个未提交的文件)）；要把它的改动叠进你的工作目录，调用 take_worker（worker=[a-z0-9-]+）。/g;
const withoutStart = (text: string): string => text.replace(START_LINE, "");

const readLoop = {
  replies: [
    { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }], contextTokens: 300 },
  ],
};

test("worker 的 token 计入本次运行的 token 上限：撞了即停掉主 agent 与 worker，交回额度用完的文字", async () => {
  const root = repo({ "a.txt": "a\n" });
  const result = await runHeadlessOnce({
    task: "MAIN 派一个去读",
    governanceRoot: root,
    workspaceRoot: root,
    yolo: true,
    spawnWorkers: true,
    maxTokens: 1000,
    streamFn: routed([
      [
        "MAIN",
        {
          replies: [
            {
              text: "派",
              contextTokens: 10,
              toolCalls: [
                {
                  name: "spawn_worker",
                  args: { role: "explorer", task: "WORKER 一直读", name: "reader" },
                },
              ],
            },
            { text: "收到", contextTokens: 10 },
          ],
        },
      ],
      ["WORKER", readLoop],
    ]),
  });
  // 主会话自己只用了 10：撞上限全靠 worker 的 token
  assert.equal(result.status, "token-limit");
  assert.deepEqual(spawnResults(root, result.sessionId), [SPAWN_WORKER_TEXTS.budgetExhausted]);
});

test("主 agent 撞上自己的时间上限：正在等的 worker 一并取消", async () => {
  const root = repo({ "a.txt": "a\n" });
  const result = await runHeadlessOnce({
    task: "MAIN 派一个慢的",
    governanceRoot: root,
    workspaceRoot: root,
    yolo: true,
    spawnWorkers: true,
    wallClockMs: 800,
    streamFn: routed([
      [
        "MAIN",
        {
          replies: [
            {
              text: "派",
              toolCalls: [
                {
                  name: "spawn_worker",
                  args: { role: "explorer", task: "WORKER 慢慢读", name: "slow" },
                },
              ],
            },
            { text: "收到" },
          ],
        },
      ],
      ["WORKER", readLoop, 100],
    ]),
  });
  assert.equal(result.status, "wall-clock-limit");
  assert.deepEqual(spawnResults(root, result.sessionId).map(withoutStart), [
    "worker slow（explorer）被取消。分支 pigeon/slow 上可能有部分改动。",
  ]);
});

test("pigeon run 的一次运行是一整次交办：回炉各轮与首轮共用 agent 派出的个数上限", async () => {
  const root = repo({ "a.txt": "a\n", "fail.mjs": "process.exit(1);\n" });
  const spawnOnce = {
    text: "派",
    toolCalls: [{ name: "spawn_worker", args: { role: "explorer", task: "WORKER 看看" } }],
  };
  const result = await runHeadlessOnce({
    task: "MAIN 看看",
    governanceRoot: root,
    workspaceRoot: root,
    yolo: true,
    spawnWorkers: true,
    spawnWorkerLimits: { maxConcurrent: 4, maxAgentSpawns: 1 },
    verify: { command: "node fail.mjs", timeoutMs: 60_000, source: "flag" },
    repairRounds: 1,
    streamFn: routed([
      ["MAIN", { replies: [spawnOnce, { text: "首轮完" }, spawnOnce, { text: "回炉完" }] }],
      ["WORKER", { replies: [{ text: "看过了" }] }],
    ]),
  });
  assert.equal(result.repair?.rounds, 1);
  const results = spawnResults(root, result.sessionId);
  assert.deepEqual(results.map(withoutStart), [
    "worker explorer-1（explorer）已完成。分支：pigeon/explorer-1。改动的文件（0）：无。摘要：看过了",
    SPAWN_WORKER_TEXTS.spawnLimit(1),
  ]);
  // 决策 279：仓库干净时起点就是 HEAD，末行写明派出时没有未提交的文件与取用方式
  assert.equal(
    results[0]?.split("\n").at(-1),
    `起点：提交 ${git(root, ["rev-parse", "HEAD"]).slice(0, 12)}（派出时没有未提交的文件）；要把它的改动叠进你的工作目录，调用 take_worker（worker=explorer-1）。`
  );
});

test("多份尝试：各份在自己的工作树里按验证命令标签，每份一段交回", async () => {
  const root = repo({
    "a.txt": "x\n",
    "check.mjs":
      'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("a.txt", "utf8") === "A\\n" ? 0 : 1);\n',
  });
  const result = await runHeadlessOnce({
    task: "MAIN 派两份",
    governanceRoot: root,
    workspaceRoot: root,
    yolo: true,
    spawnWorkers: true,
    verify: { command: "node check.mjs", timeoutMs: 60_000, source: "flag" },
    streamFn: routed([
      [
        "MAIN",
        {
          replies: [
            {
              text: "派两份",
              toolCalls: [
                {
                  name: "spawn_worker",
                  args: { role: "implementer", task: "WORKER 把 x 改成 A", attempts: 2 },
                },
              ],
            },
            { text: "收到" },
          ],
        },
      ],
      [
        "WORKER",
        staged(
          {
            replies: [
              {
                text: "改",
                toolCalls: [
                  { name: "edit_file", args: { path: "a.txt", old_string: "x", new_string: "A" } },
                ],
              },
            ],
          },
          { replies: [{ text: "改好了" }] }
        ),
      ],
    ]),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(spawnResults(root, result.sessionId).map(withoutStart), [
    [
      "第 1 份（通过）：worker implementer-1（implementer）已完成。分支：pigeon/implementer-1。改动的文件（1）：a.txt。摘要：改好了",
      "第 2 份（通过）：worker implementer-2（implementer）已完成。分支：pigeon/implementer-2。改动的文件（1）：a.txt。摘要：改好了",
    ].join("\n\n"),
  ]);
});
