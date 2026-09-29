// 终端界面启动时后台补做复盘（决策 283、284）：
// - 补做读退出那一刻的代码：本机会话从退出快照检出临时工作树（不是之后改过的工作目录），沙箱会话从交回的分支检出，
//   无快照的读当前工作目录并在复盘记录里注明；用完删除临时工作树与退出快照引用；
// - 复盘记录写明覆盖到来源会话的哪一条记录，另记读代码的来处；种类记收尾，模板不变，只放行两件工具；
// - 三道闸：上线之前的会话不补；超过 7 天的记下跳过、以后不再补；每次最多补 5 个、从最新的开始；
// - 租约：两个进程同时启动不重复补同一会话；补做失败记下原因与次数，下次启动重试。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  acquireBackfillLease,
  readBackfillRecord,
  releaseBackfillLease,
  reviewBackfillDir,
} from "../persistence/review-backfill-store.ts";
import type { SessionId } from "../state/ids.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import { type BackfillProgress, runReviewBackfill } from "./review-backfill.ts";
import { exitSnapshotRef, recordTuiExit } from "./tui-exit.ts";
import {
  git,
  initRepo,
  mainEntries,
  openTuiSession,
  reviewsOf,
  routedModel,
  tempRoot,
  textOf,
} from "./tui-session-fixtures.ts";

const DAY = 24 * 60 * 60_000;

// 上线时刻记成 0：夹具里建的会话都算上线之后
function launchedLongAgo(root: string): void {
  mkdirSync(reviewBackfillDir(root), { recursive: true });
  writeFileSync(join(reviewBackfillDir(root), "since.json"), '{"version":1,"since":0}\n');
}

async function sessionsWithExit(root: string, count: number): Promise<SessionId[]> {
  const ids: SessionId[] = [];
  for (let index = 0; index < count; index += 1) {
    const session = await openTuiSession({
      root,
      streamFn: routedModel({}).streamFn,
      task: `第 ${index + 1} 个会话`,
    });
    await session.close();
    ids.push(session.sessionId);
    // 最后动静的时刻彼此分开
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return ids;
}

function backfillRequest(
  root: string,
  streamFn: Parameters<typeof runReviewBackfill>[0]["streamFn"]
) {
  return {
    governanceRoot: root,
    streamFn,
    provider: "custom",
    modelId: "custom",
    homeDir: root,
  };
}

// 复盘里 read_file 读到的工具结果文字
function readResults(entries: ReturnType<typeof mainEntries>): string[] {
  return entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as { role: string; toolName?: string; content?: unknown })
    .filter((message) => message.role === "toolResult" && message.toolName === "read_file")
    .map((message) => textOf(message));
}

const READ_A = { name: "read_file", args: { path: "a.txt" } };

test("补做读退出快照里的文件而不是之后改过的；复盘记录写明覆盖到哪一条与读取来处；用完删除临时工作树与快照引用", async () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-snap-");
  try {
    initRepo(root, { "a.txt": "提交里的内容\n" });
    launchedLongAgo(root);
    const session = await openTuiSession({
      root,
      streamFn: routedModel({}).streamFn,
      task: "改 a",
    });
    writeFileSync(join(root, "a.txt"), "退出时的内容\n");
    await session.close();
    writeFileSync(join(root, "a.txt"), "退出之后又改了\n");
    const { streamFn, calls } = routedModel({
      review: [{ text: "核对一下", toolCalls: [READ_A] }, { text: "不改" }],
    });
    const progress: string[] = [];
    const observed: BackfillProgress[] = [];
    const summary = await runReviewBackfill({
      ...backfillRequest(root, streamFn),
      progress: (line) => progress.push(line),
      observe: (step) => observed.push(step),
    });
    assert.deepEqual(summary.completed, [session.sessionId]);
    assert.deepEqual(progress, ["后台补做复盘：已完成 1/1"]);
    // 结构化进度（286）：开始前、开始补第 1 个、补完；花费取复盘会话记录（假模型的回复有 token 没有价格）
    assert.deepEqual(
      observed.map((step) => [step.planned, step.current, step.completed, step.failed]),
      [
        [1, undefined, 0, 0],
        [1, 1, 0, 0],
        [1, undefined, 1, 0],
      ]
    );
    const spent = observed.at(-1)?.cost;
    assert.equal(spent?.cost, 0);
    assert.ok((spent?.unpricedTokens ?? 0) > 0, JSON.stringify(spent));
    // 复盘指令为收尾版本，模板不变
    const instruction = textOf(calls.find((call) => call.kind === "review")?.messages.at(-1) ?? {});
    assert.ok(instruction.startsWith("【复盘 v1】这次会话的工作已经结束。"));
    assert.ok(instruction.includes("\n验证门的最终结论：本次没有运行验证门\n"));
    const [review] = reviewsOf(root, session.sessionId);
    assert.ok(review !== undefined);
    const readText = readResults(review.entries).join("\n");
    assert.ok(readText.includes("退出时的内容"), readText);
    assert.ok(!readText.includes("退出之后又改了"));
    // 覆盖到来源会话主分支上最后一条消息
    const lastSource = mainEntries(root, session.sessionId).findLast(
      (entry) => entry.type === "message"
    );
    assert.ok(lastSource !== undefined);
    const exit = mainEntries(root, session.sessionId).find(
      (entry) => entry.type === "custom" && entry.customType === SessionEntryType.Exit
    )?.data as { workdir: { commit: string } };
    assert.deepEqual(review.start.memoryReview, {
      kind: "closing",
      template: "v1",
      covers: { entryId: lastSource.id, seq: lastSource.seq },
      backfill: { readFrom: { kind: "exit-snapshot", commit: exit.workdir.commit } },
    });
    // 临时工作树已删、登记已清，退出快照引用已删
    assert.equal(git(root, ["worktree", "list", "--porcelain"]).split("worktree ").length - 1, 1);
    assert.throws(() => git(root, ["rev-parse", "--verify", exitSnapshotRef(session.sessionId)]));
    // 再启动一次：已复盘，不再补
    const again = await runReviewBackfill(backfillRequest(root, routedModel({}).streamFn));
    assert.equal(again.planned, 0);
    assert.equal(reviewsOf(root, session.sessionId).length, 1);
  } finally {
    cleanup();
  }
});

test("沙箱会话读交回的分支", async () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-sandbox-");
  try {
    initRepo(root, { "a.txt": "宿主上的内容\n" });
    launchedLongAgo(root);
    const session = await openTuiSession({
      root,
      streamFn: routedModel({}).streamFn,
      task: "干活",
    });
    // 交回分支：沙箱里改过 a.txt
    const branch = `pigeon/sandbox-${session.sessionId}`;
    git(root, ["checkout", "-q", "-b", branch]);
    writeFileSync(join(root, "a.txt"), "沙箱里的内容\n");
    git(root, ["commit", "-q", "-am", "sandbox"]);
    const commit = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-q", "-"]);
    // 会话在沙箱里：退出时不另拍，记交回的分支与提交
    await closeSessionAsSandbox(root, session, { branch, commit });
    const { streamFn } = routedModel({
      review: [{ text: "核对", toolCalls: [READ_A] }, { text: "不改" }],
    });
    const summary = await runReviewBackfill(backfillRequest(root, streamFn));
    assert.deepEqual(summary.completed, [session.sessionId]);
    const [review] = reviewsOf(root, session.sessionId);
    assert.ok(review !== undefined);
    const readText = readResults(review.entries).join("\n");
    assert.ok(readText.includes("沙箱里的内容"), readText);
    assert.deepEqual(review.start.memoryReview?.backfill, {
      readFrom: { kind: "sandbox-branch", branch, commit },
    });
  } finally {
    cleanup();
  }
});

// 沙箱会话的退出：释放运行面后按交回结果记退出条目（与 closeTuiSession 的沙箱分支同一写法）
async function closeSessionAsSandbox(
  root: string,
  session: { sessionId: SessionId; close(): Promise<void> },
  exported: { branch: string; commit: string }
): Promise<void> {
  // 先按本机收尾释放运行面（会记一条本机快照），再记沙箱退出条目：补做取最后一条退出条目
  await session.close();
  await recordTuiExit({
    governanceRoot: root,
    sessionId: session.sessionId,
    sandbox: { exported: { ...exported, changed: true, viewCommand: "git log" } },
  });
}

test("没有退出快照（非 git 工作区）：读当前工作目录，并在复盘记录里注明", async () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-nogit-");
  try {
    writeFileSync(join(root, "a.txt"), "工作目录里的内容\n");
    launchedLongAgo(root);
    const session = await openTuiSession({ root, streamFn: routedModel({}).streamFn, task: "看" });
    await session.close();
    const { streamFn } = routedModel({
      review: [{ text: "核对", toolCalls: [READ_A] }, { text: "不改" }],
    });
    const summary = await runReviewBackfill(backfillRequest(root, streamFn));
    assert.deepEqual(summary.completed, [session.sessionId]);
    const [review] = reviewsOf(root, session.sessionId);
    const readFrom = review?.start.memoryReview?.backfill?.readFrom;
    assert.equal(readFrom?.kind, "workdir");
    assert.ok(readFrom?.kind === "workdir" && readFrom.reason.startsWith("退出时没有快照："));
    assert.ok(
      readResults(review?.entries ?? [])
        .join("\n")
        .includes("工作目录里的内容")
    );
  } finally {
    cleanup();
  }
});

test("闸一：上线之前产生的会话不补；首次以新版本启动时记下上线时刻", async () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-since-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    const [old] = await sessionsWithExit(root, 1);
    // 首次启动：此前的会话都算上线之前
    const { streamFn, calls } = routedModel({});
    const first = await runReviewBackfill(backfillRequest(root, streamFn));
    assert.equal(first.planned, 0);
    assert.equal(calls.length, 0);
    const since = JSON.parse(readFileSync(join(reviewBackfillDir(root), "since.json"), "utf8"));
    assert.equal(typeof since.since, "number");
    // 上线之后的会话照补，之前的仍不补
    await new Promise((resolve) => setTimeout(resolve, 15));
    const [fresh] = await sessionsWithExit(root, 1);
    const second = await runReviewBackfill(backfillRequest(root, routedModel({}).streamFn));
    assert.deepEqual(second.completed, [fresh]);
    assert.equal(reviewsOf(root, old as string).length, 0);
  } finally {
    cleanup();
  }
});

test("闸二：超过 7 天的会话视为过时，记下跳过，以后不再补", async () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-stale-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    launchedLongAgo(root);
    writeFileSync(join(root, "a.txt"), "没提交的改动\n");
    const [id] = await sessionsWithExit(root, 1);
    assert.ok(id !== undefined);
    assert.doesNotThrow(() => git(root, ["rev-parse", "--verify", exitSnapshotRef(id)]));
    const later = Date.now() + 8 * DAY;
    const { streamFn, calls } = routedModel({});
    const summary = await runReviewBackfill({
      ...backfillRequest(root, streamFn),
      now: () => later,
    });
    assert.deepEqual(summary.stale, [id]);
    assert.equal(summary.planned, 0);
    assert.equal(calls.length, 0);
    assert.equal(readBackfillRecord(root, id)?.status, "stale");
    assert.throws(() => git(root, ["rev-parse", "--verify", exitSnapshotRef(id)]));
    // 之后即使时钟回到 7 天之内（或配置调大），记过跳过的也不再补
    const again = await runReviewBackfill(backfillRequest(root, routedModel({}).streamFn));
    assert.equal(again.planned, 0);
    assert.deepEqual(again.stale, []);
    assert.equal(reviewsOf(root, id).length, 0);
  } finally {
    cleanup();
  }
});

test("闸三：每次启动最多补 5 个，从最新的开始，其余留到下次", async () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-limit-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    launchedLongAgo(root);
    const ids = await sessionsWithExit(root, 6);
    const progress: string[] = [];
    const first = await runReviewBackfill({
      ...backfillRequest(root, routedModel({}).streamFn),
      progress: (line) => progress.push(line),
    });
    assert.equal(first.planned, 5);
    assert.deepEqual(first.completed, ids.slice(1).reverse());
    assert.equal(progress.at(-1), "后台补做复盘：已完成 5/5");
    assert.equal(reviewsOf(root, ids[0] as string).length, 0);
    const second = await runReviewBackfill(backfillRequest(root, routedModel({}).streamFn));
    assert.deepEqual(second.completed, [ids[0]]);
  } finally {
    cleanup();
  }
});

test("三个数可在配置里改", async () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-config-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    launchedLongAgo(root);
    writeFileSync(
      join(root, ".pigeon", "memory-review.json"),
      '{"version":1,"maxPerLaunch":1,"maxAgeDays":30}\n'
    );
    const ids = await sessionsWithExit(root, 2);
    const summary = await runReviewBackfill({
      ...backfillRequest(root, routedModel({}).streamFn),
      now: () => Date.now() + 8 * DAY,
    });
    assert.deepEqual(summary.stale, []);
    assert.deepEqual(summary.completed, [ids[1]]);
  } finally {
    cleanup();
  }
});

test("补做失败：记下原因与次数、交还租约，下次启动重试", async () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-retry-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    launchedLongAgo(root);
    const [id] = await sessionsWithExit(root, 1);
    assert.ok(id !== undefined);
    const progress: string[] = [];
    const failing = await runReviewBackfill({
      ...backfillRequest(root, routedModel({ reviewFailOnCall: 1 }).streamFn),
      progress: (line) => progress.push(line),
    });
    assert.deepEqual(failing.completed, []);
    assert.equal(failing.failed.length, 1);
    assert.deepEqual(progress, ["后台补做复盘：已完成 1/1（其中 1 个失败，留待下次启动重试）"]);
    const record = readBackfillRecord(root, id);
    assert.equal(record?.status, "failed");
    assert.ok(record?.status === "failed" && record.failures === 1);
    assert.ok(record?.status === "failed" && record.lastError.includes("模拟复盘请求失败"));
    assert.equal(existsSync(join(reviewBackfillDir(root), "leases", `${id}.json`)), false);
    const again = await runReviewBackfill(
      backfillRequest(root, routedModel({ reviewFailOnCall: 1 }).streamFn)
    );
    const second = readBackfillRecord(root, id);
    assert.equal(again.failed.length, 1);
    assert.ok(second?.status === "failed" && second.failures === 2);
    const ok = await runReviewBackfill(backfillRequest(root, routedModel({}).streamFn));
    assert.deepEqual(ok.completed, [id]);
    assert.equal(readBackfillRecord(root, id), undefined);
  } finally {
    cleanup();
  }
});

test("租约：有效租约挡住别的持有者，过期即失效可接手，只交还自己的", () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-lease-");
  try {
    const base = { governanceRoot: root, sessionId: "s1", leaseMs: 1000 };
    const a = acquireBackfillLease({ ...base, holder: "a", now: 0 });
    assert.equal(a?.holder, "a");
    assert.equal(acquireBackfillLease({ ...base, holder: "b", now: 999 }), undefined);
    // b 交还不掉 a 的
    releaseBackfillLease({ governanceRoot: root, sessionId: "s1", holder: "b" });
    assert.equal(acquireBackfillLease({ ...base, holder: "b", now: 500 }), undefined);
    // 过期：b 接手
    assert.equal(acquireBackfillLease({ ...base, holder: "b", now: 1001 })?.holder, "b");
    releaseBackfillLease({ governanceRoot: root, sessionId: "s1", holder: "b" });
    assert.equal(acquireBackfillLease({ ...base, holder: "c", now: 1002 })?.holder, "c");
  } finally {
    cleanup();
  }
});

const run = promisify(execFile);

// 子进程：等放行文件出现后补做，打印补成的会话号
const CHILD = `
import { existsSync, writeFileSync } from "node:fs";
const [root, readyFile, goFile, backfillUrl, fixturesUrl] = process.argv.slice(1);
const { runReviewBackfill } = await import(backfillUrl);
const { routedModel } = await import(fixturesUrl);
writeFileSync(readyFile, "ready");
while (!existsSync(goFile)) await new Promise((r) => setTimeout(r, 10));
const summary = await runReviewBackfill({
  governanceRoot: root, streamFn: routedModel({ reviewDelayMs: 300 }).streamFn,
  provider: "custom", modelId: "custom", homeDir: root,
});
process.stdout.write(JSON.stringify(summary.completed));
`;

test("两个进程同时启动：同一会话只补一次", async () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-race-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    launchedLongAgo(root);
    const ids = await sessionsWithExit(root, 3);
    const here = import.meta.dirname;
    const urls = [
      pathToFileURL(join(here, "review-backfill.ts")).href,
      pathToFileURL(join(here, "tui-session-fixtures.ts")).href,
    ];
    const goFile = join(root, "go");
    const children = [0, 1].map((index) =>
      run(
        process.execPath,
        ["--input-type=module", "-e", CHILD, root, join(root, `ready-${index}`), goFile, ...urls],
        { cwd: root, timeout: 120_000 }
      )
    );
    while (![0, 1].every((index) => existsSync(join(root, `ready-${index}`)))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(goFile, "go");
    const outputs = await Promise.all(children);
    const done = outputs.flatMap((output) => JSON.parse(output.stdout) as string[]);
    assert.deepEqual([...done].sort(), [...ids].sort(), "每个会话恰好补一次");
    for (const id of ids) {
      assert.equal(reviewsOf(root, id).length, 1, `会话 ${id} 被补了不止一次`);
    }
  } finally {
    cleanup();
  }
});

test("本进程的当前会话不补", async () => {
  const { root, cleanup } = tempRoot("pigeon-backfill-exclude-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    launchedLongAgo(root);
    const [current] = await sessionsWithExit(root, 1);
    const summary = await runReviewBackfill({
      ...backfillRequest(root, routedModel({}).streamFn),
      currentSessionId: current as SessionId,
    });
    assert.equal(summary.planned, 0);
  } finally {
    cleanup();
  }
});
