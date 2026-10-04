// pigeon run 里主 agent 派 worker（决策 264–268、297、300、302、303）：真实编排器与 git 工作树、假模型。派出立即返回；
// 一次运行在全部 worker 结束、完成通知作为新的一轮处理完之后才结束；主 agent 还在跑时结束的 worker 的通知进它的下一轮；
// worker 的 token 计入本次运行的 token 上限，撞了即停掉主 agent 与在跑的 worker；撞上时间上限时在跑的 worker 停掉收尾；
// 无人值守时 worker 需请示即停下、以可恢复错误交回，其余 worker 照常；多份尝试全部结束后汇总一条通知，交回各份的改动与摘要。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn, type FakeStreamBehavior } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { restoreSessionContext } from "../pi-runtime/session-store.ts";
import { DEFAULT_ORCHESTRATION_SETTINGS } from "../state/orchestration-config.ts";
import { isStatusText } from "./status-fixtures.ts";
import { runHeadless } from "./headless-core.ts";
import { SPAWN_WORKER_TEXTS } from "./spawn-worker-tool.ts";
import { WORKER_NOTICE_PREFIX } from "./worker-notices.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

// 有一个提交的 git 仓库（worker 从主工作目录的快照开工）；.pigeon/ 不进版本
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pigeon-spawn-headless-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  // 关掉换行转换：否则全局 core.autocrlf=true 的机器上 worker 工作树检出会把 \n 变成 \r\n
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(root, file), content);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  return root;
}

// 按会话的第一条人输入的用户消息分派剧本：主会话与各 worker 各走各的回复队列
function firstUserText(context: Parameters<StreamFn>[1]): string {
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as Array<{ type: string; text?: string }>)
              .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
              .join("")
          : "";
    // 决策 363：开工状态块不是会话的第一条输入
    if (!isStatusText(text)) return text;
  }
  return "";
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
  const view = loadSessionView(join(root, ".pigeon", "state", "sessions"), sessionId);
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

// 会话里的用户消息（任务与完成通知）
function userTexts(root: string, sessionId: string): string[] {
  const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(loaded !== undefined);
  return (
    restoreSessionContext(loaded.main)
      .messages.filter((message) => message.role === "user")
      .map((message) => {
        const content = (message as { content: unknown }).content;
        return typeof content === "string"
          ? content
          : (content as Array<{ type: string; text?: string }>)
              .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
              .join("");
      })
      // 决策 363：开工状态块不是输入
      .filter((text) => !isStatusText(text))
  );
}

// 主会话派出的 worker 的收尾状态（按名字）
function childStatuses(root: string, sessionId: string): Record<string, string | undefined> {
  const view = loadSessionView(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(view !== undefined);
  return Object.fromEntries(
    view.children.map((child) => [child.spawned.name, child.settled?.status])
  );
}

const spawned = (name: string, role = "explorer") =>
  `已派出 worker ${name}（${role}），分支 pigeon/${name}。它结束时会有通知；需要结果才能往下做时用 wait_workers 等。`;

// 决策 279：每段返回文字末尾另起一行写起点与取用方式（提交号随仓库变）；比对定稿文字时去掉这一行，格式另在一处专门核对
const START_LINE =
  /\n起点：(提交|快照) [0-9a-f]{12}（(派出时没有未提交的文件|含派出时 \d+ 个未提交的文件)）；要把它的改动叠进你的工作目录，调用 take_worker（worker=[a-z0-9-]+）。/g;
// 通知末行的 worker 会话号（续接时据它判定通知是否已递出）同样随会话变，格式另在 spawn-worker-tool.test 核对
const MARKER_LINE = /\n（worker 会话 sess_[0-9A-Z]+）/g;
const withoutMarker = (text: string): string => text.replace(MARKER_LINE, "");
const withoutStart = (text: string): string =>
  text.replace(START_LINE, "").replace(MARKER_LINE, "");

const readLoop = {
  replies: [
    { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }], contextTokens: 300 },
  ],
};

test("pigeon run 等全部 worker 结束、完成通知作为新的一轮处理完才结束", async () => {
  const root = repo({ "a.txt": "a\n" });
  let mainCalls = 0;
  const main = createFakeStreamFn({
    replies: [
      {
        text: "派",
        toolCalls: [
          { name: "spawn_worker", args: { role: "explorer", task: "WORKER 慢慢看", name: "slow" } },
        ],
      },
      { text: "先收工" },
      { text: "收到通知，做完了" },
    ],
  });
  const result = await runHeadless({
    task: "MAIN 派一个慢的",
    governanceRoot: root,
    workspaceRoot: root,
    yolo: true,
    spawnWorkers: true,
    streamFn: routed([
      [
        "MAIN",
        ((model, context, options) => {
          mainCalls += 1;
          return main(model, context, options);
        }) as StreamFn,
      ],
      ["WORKER", { replies: [{ text: "看完了" }] }, 400],
    ]),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(spawnResults(root, result.sessionId), [spawned("slow")]);
  // 主 agent 自己的运行先结束；worker 结束后通知开了第二个运行
  const view = loadSessionView(join(root, ".pigeon", "state", "sessions"), result.sessionId);
  assert.equal(view?.runs.length, 2);
  assert.equal(mainCalls, 3);
  const users = userTexts(root, result.sessionId);
  assert.equal(users.length, 2);
  assert.equal(
    withoutStart(users[1] ?? ""),
    `${WORKER_NOTICE_PREFIX}worker slow（explorer）已完成。分支：pigeon/slow。改动的文件（0）：无。摘要：看完了`
  );
  assert.deepEqual(childStatuses(root, result.sessionId), { slow: "completed" });
});

test("主 agent 还在跑时结束的 worker：通知进它这次运行的下一轮，不另开运行", async () => {
  const root = repo({ "a.txt": "a\n" });
  const contexts: string[][] = [];
  const main = createFakeStreamFn({
    replies: [
      {
        text: "派",
        toolCalls: [
          { name: "spawn_worker", args: { role: "explorer", task: "WORKER 快看", name: "quick" } },
        ],
      },
      { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { text: "看到通知了" },
    ],
  });
  const result = await runHeadless({
    task: "MAIN 派一个快的",
    governanceRoot: root,
    workspaceRoot: root,
    yolo: true,
    spawnWorkers: true,
    streamFn: routed([
      [
        "MAIN",
        ((model, context, options) => {
          contexts.push(
            context.messages
              .filter((message) => message.role === "user")
              .map((message) => JSON.stringify((message as { content: unknown }).content))
          );
          return main(model, context, options);
        }) as StreamFn,
        // 主 agent 每轮都慢：worker 在它第二轮进行中就结束（窗口取宽些，慢机器上 worker 的收尾也来得及落在这轮里）
        1500,
      ],
      ["WORKER", { replies: [{ text: "快看完了" }] }],
    ]),
  });
  assert.equal(result.status, "completed");
  const view = loadSessionView(join(root, ".pigeon", "state", "sessions"), result.sessionId);
  assert.equal(view?.runs.length, 1);
  assert.equal(contexts.length, 3);
  // 第二轮还看不到通知，第三轮（read_file 之后的下一轮）看到
  assert.ok(!contexts[1]?.some((text) => text.includes("worker 通知")));
  assert.ok(
    contexts[2]?.some((text) => text.includes("worker 通知")),
    contexts[2]?.join("\n")
  );
});

test("worker 的 token 计入本次运行的 token 上限：撞了即停掉主 agent 与在跑的 worker", async () => {
  const root = repo({ "a.txt": "a\n" });
  const result = await runHeadless({
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
  // 主会话自己只用了 20：撞上限全靠 worker 的 token
  assert.equal(result.status, "token-limit");
  assert.deepEqual(spawnResults(root, result.sessionId), [spawned("reader")]);
  assert.deepEqual(childStatuses(root, result.sessionId), { reader: "cancelled" });
});

test("撞上时间上限：在跑的 worker 停掉并收尾，收尾记录写进本会话", async () => {
  const root = repo({ "a.txt": "a\n" });
  const result = await runHeadless({
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
  assert.deepEqual(spawnResults(root, result.sessionId), [spawned("slow")]);
  assert.deepEqual(childStatuses(root, result.sessionId), { slow: "cancelled" });
});

test("无人值守：worker 要跑命令即停下、以可恢复错误交回，其余 worker 照常完成（改自己工作树不请示）", async () => {
  const root = repo({ "a.txt": "a\n" });
  const result = await runHeadless({
    task: "MAIN 派两个",
    governanceRoot: root,
    workspaceRoot: root,
    // 不开放手模式：run_command 要请示
    yolo: false,
    spawnWorkers: true,
    streamFn: routed([
      [
        "MAIN",
        {
          replies: [
            {
              text: "派两个",
              toolCalls: [
                {
                  name: "spawn_worker",
                  args: { role: "tester", task: "WORKER-T 跑测试", name: "runner" },
                },
                {
                  name: "spawn_worker",
                  args: { role: "implementer", task: "WORKER-I 改 a", name: "editor" },
                },
              ],
            },
            { text: "收到" },
          ],
        },
      ],
      [
        "WORKER-T",
        {
          replies: [
            { text: "跑", toolCalls: [{ name: "run_command", args: { command: "node -v" } }] },
            { text: "跑完" },
          ],
        },
      ],
      [
        "WORKER-I",
        staged(
          {
            replies: [
              {
                text: "改",
                toolCalls: [
                  { name: "edit_file", args: { path: "a.txt", old_string: "a", new_string: "A" } },
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
  assert.deepEqual(childStatuses(root, result.sessionId), {
    runner: "failed",
    editor: "completed",
  });
  const notices = userTexts(root, result.sessionId).filter((text) =>
    text.startsWith(WORKER_NOTICE_PREFIX)
  );
  assert.ok(
    notices.some((text) =>
      text.includes(
        "worker runner（tester）停在等审批：要跑命令 node -v，无人值守运行没有人审批。分支 pigeon/runner 上有已做的部分；人补批后它可以接着做。"
      )
    ),
    notices.join("\n")
  );
  // 决策 302：implementer 改自己工作树里的文件没有请示，照常完成
  assert.ok(
    notices.some((text) => text.includes("worker editor（implementer）已完成。")),
    notices.join("\n")
  );
});

test("给了总数上限：pigeon run 的一次运行是一整次交办，通知轮里再派也算进同一次运行的派出个数", async () => {
  const root = repo({ "a.txt": "a\n" });
  const spawnOnce = {
    text: "派",
    toolCalls: [{ name: "spawn_worker", args: { role: "explorer", task: "WORKER 看看" } }],
  };
  const spawnAgain = {
    text: "再派",
    toolCalls: [{ name: "spawn_worker", args: { role: "explorer", task: "WORKER 再看看" } }],
  };
  const result = await runHeadless({
    task: "MAIN 看看",
    governanceRoot: root,
    workspaceRoot: root,
    yolo: true,
    spawnWorkers: true,
    orchestration: { ...DEFAULT_ORCHESTRATION_SETTINGS, maxWorkersPerRun: 1 },
    streamFn: routed([
      // 任务轮派一个；worker 完成通知进新一轮后再派一个——同一次运行，撞上限
      ["MAIN", { replies: [spawnOnce, { text: "等通知" }, spawnAgain, { text: "收工" }] }],
      ["WORKER", { replies: [{ text: "看过了" }] }],
    ]),
  });
  assert.equal(result.status, "completed");
  const results = spawnResults(root, result.sessionId);
  assert.deepEqual(results, [spawned("explorer-1"), SPAWN_WORKER_TEXTS.spawnLimit(1)]);
  // 决策 279：仓库干净时起点就是 HEAD，通知末行写明派出时没有未提交的文件与取用方式
  const notice = userTexts(root, result.sessionId).find((text) =>
    text.includes("explorer-1（explorer）已完成")
  );
  assert.equal(
    withoutMarker(notice ?? "")
      .split("\n")
      .at(-1),
    `起点：提交 ${git(root, ["rev-parse", "HEAD"]).slice(0, 12)}（派出时没有未提交的文件）；要把它的改动叠进你的工作目录，调用 take_worker（worker=explorer-1）。`
  );
});

test("多份尝试：各份在自己的工作树里改，全部结束后汇总一条通知交回各份的改动与摘要", async () => {
  const root = repo({ "a.txt": "x\n" });
  const result = await runHeadless({
    task: "MAIN 派两份",
    governanceRoot: root,
    workspaceRoot: root,
    yolo: true,
    spawnWorkers: true,
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
  assert.deepEqual(spawnResults(root, result.sessionId), [
    "已并行派出 2 份：implementer-1、implementer-2。全部结束后会有一条通知，交回各份的改动与摘要。",
  ]);
  const notices = userTexts(root, result.sessionId).filter((text) =>
    text.startsWith(WORKER_NOTICE_PREFIX)
  );
  assert.equal(notices.length, 1);
  assert.equal(
    withoutStart(notices[0] ?? ""),
    WORKER_NOTICE_PREFIX +
      [
        "第 1 份：worker implementer-1（implementer）已完成。分支：pigeon/implementer-1。改动的文件（1）：a.txt。摘要：改好了",
        "第 2 份：worker implementer-2（implementer）已完成。分支：pigeon/implementer-2。改动的文件（1）：a.txt。摘要：改好了",
      ].join("\n\n")
  );
});

test("放开嵌套（2 层）：主会话派的 worker 再派下一层并等它结束，通知进上层 worker 的会话；派出与收尾记在各自的派出方", async () => {
  const root = repo({ "a.txt": "a\n" });
  const result = await runHeadless({
    task: "MAIN 拆两层",
    governanceRoot: root,
    workspaceRoot: root,
    yolo: true,
    spawnWorkers: true,
    orchestration: { ...DEFAULT_ORCHESTRATION_SETTINGS, maxDepth: 2 },
    streamFn: routed([
      [
        "WORKER-P",
        {
          replies: [
            {
              text: "再派",
              toolCalls: [
                {
                  name: "spawn_worker",
                  args: { role: "explorer", task: "WORKER-C 查一下", name: "child" },
                },
              ],
            },
            { text: "下一层结束了" },
          ],
        },
      ],
      ["WORKER-C", { replies: [{ text: "查完了" }] }],
      [
        "MAIN",
        {
          replies: [
            {
              text: "派",
              toolCalls: [
                {
                  name: "spawn_worker",
                  args: { role: "implementer", task: "WORKER-P 拆给下一层", name: "parent" },
                },
              ],
            },
            { text: "收到" },
          ],
        },
      ],
    ]),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(childStatuses(root, result.sessionId), { parent: "completed" });
  const view = loadSessionView(join(root, ".pigeon", "state", "sessions"), result.sessionId);
  const parentId = view?.children[0]?.spawned.childSessionId;
  assert.ok(parentId !== undefined);
  assert.deepEqual(childStatuses(root, parentId), { child: "completed" });
  const parentNotices = userTexts(root, parentId).filter((text) =>
    text.startsWith(WORKER_NOTICE_PREFIX)
  );
  assert.equal(parentNotices.length, 1);
  assert.ok(parentNotices[0]?.includes("worker child（explorer）已完成。"), parentNotices[0]);
  const mainNotices = userTexts(root, result.sessionId).filter((text) =>
    text.startsWith(WORKER_NOTICE_PREFIX)
  );
  assert.equal(mainNotices.length, 1);
  assert.ok(mainNotices[0]?.includes("worker parent（implementer）已完成。"), mainNotices[0]);
});
