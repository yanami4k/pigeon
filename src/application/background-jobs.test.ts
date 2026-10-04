// 后台作业的应用层接法（决策 365）：结束通知同一轮的合并成一条、已由 job_output 交回的撤回不重复；无人值守收尾先等作业、
// 把通知交给模型，总时限到了停掉余下的并拒绝新开；续跑时认出上一进程丢失的作业；装配冒烟——headless 收尾等作业跑完、
// 通知进模型的下一轮，墙钟到了中止并停掉作业、记下来由
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import { type BackgroundJob, JobPool, SessionJobs } from "../tools/background-jobs.ts";
import { CommandOutputStore } from "../tools/command-output.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import {
  backgroundJobEntry,
  JOB_NOTICE_PREFIX,
  JobNotices,
  previousJobsOf,
  settleBackgroundJobs,
} from "./background-jobs.ts";
import { runHeadless } from "./headless-core.ts";

// 通知队列的替身：递出由测试控制
function noticeTarget() {
  const queued = new Map<string, string>();
  const delivered = new Set<string>();
  let seq = 0;
  let runs = 0;
  return {
    queued,
    notify(text: string) {
      const key = `n${++seq}`;
      queued.set(key, text);
      return key;
    },
    withdrawNotice: (key: string) => !delivered.has(key) && queued.delete(key),
    noticeDelivered: (key: string) => delivered.has(key),
    pendingNotices: () => [...queued.keys()].filter((key) => !delivered.has(key)).length,
    deliverAll() {
      for (const key of queued.keys()) delivered.add(key);
    },
    pending: () => [...queued].filter(([key]) => !delivered.has(key)).map(([, text]) => text),
    runNotices: async () => {
      runs += 1;
      for (const key of queued.keys()) delivered.add(key);
      return { runs };
    },
    runs: () => runs,
  };
}

function fakeJob(id: string): BackgroundJob {
  return {
    id,
    command: `cmd-${id}`,
    startedAt: 0,
    state: "exited",
    endedAt: 1000,
    exit: { exitCode: 0 },
    killedBy: undefined,
    outputUri: `pigeon://outputs/s/${id}`,
    outputSaved: true,
    outputError: undefined,
    outputBytes: 0,
    outputDropped: 0,
    fileChanges: undefined,
    readOffset: 0,
    reported: false,
    output: { read: () => ({ text: "", skipped: 0, end: 0 }) },
  } as unknown as BackgroundJob;
}

test("结束通知：还没递出时又结束的合并成一条；job_output 交回的撤回；已递出的不再重复", () => {
  const settled = new Set<(job: BackgroundJob) => void>();
  const reported = new Set<(job: BackgroundJob) => void>();
  const jobs = {
    onSettled: (fn: (job: BackgroundJob) => void) => {
      settled.add(fn);
      return () => settled.delete(fn);
    },
    onReported: (fn: (job: BackgroundJob) => void) => {
      reported.add(fn);
      return () => reported.delete(fn);
    },
  } as unknown as SessionJobs;
  const target = noticeTarget();
  let woken = 0;
  new JobNotices(jobs, target, { wake: () => (woken += 1) });
  const [j1, j2, j3] = [fakeJob("j1"), fakeJob("j2"), fakeJob("j3")] as [
    BackgroundJob,
    BackgroundJob,
    BackgroundJob,
  ];
  for (const fn of settled) fn(j1);
  for (const fn of settled) fn(j2);
  assert.equal(target.pending().length, 1);
  assert.match(target.pending()[0] ?? "", /^\[后台作业通知\] 2 个后台作业已结束[\s\S]*j1[\s\S]*j2/);
  j1.reported = true;
  for (const fn of reported) fn(j1);
  assert.equal(target.pending().length, 1);
  assert.doesNotMatch(target.pending()[0] ?? "", /j1/);
  target.deliverAll();
  for (const fn of settled) fn(j3);
  assert.deepEqual(
    target.pending().map((text) => [/j2/.test(text), /j3/.test(text)]),
    [[false, true]]
  );
  assert.equal(j2.reported, true);
  assert.equal(woken, 3);
});

function localJobs(state: string, root: string) {
  return new SessionJobs({
    sessionId: "s1",
    host: createLocalWorkspaceHost(root),
    store: new CommandOutputStore({
      base: state,
      outputsRoot: join(state, "outputs"),
      sessionId: "s1",
      maxBytes: 1024 * 1024,
    }),
    pool: new JobPool({ total: 4 }),
    perSession: 2,
    outputMaxBytes: 1024 * 1024,
  });
}

test("无人值守收尾：先交一条「仍在跑」让模型处理一轮，再等作业结束、把通知交给模型；总时限到了停掉余下的作业并拒绝新开", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-closeout-"));
  const script = (name: string, body: string) => {
    writeFileSync(join(dir, name), body);
    return { program: process.execPath, args: [join(dir, name)], verbatim: false };
  };
  const jobs = localJobs(dir, dir);
  const target = noticeTarget();
  new JobNotices(jobs, target);
  try {
    await jobs.start({
      command: "quick",
      plan: script("q.mjs", "setTimeout(() => {}, 300);"),
      env: process.env,
    });
    const first = await settleBackgroundJobs({
      jobs,
      target,
      stopped: () => false,
      closeoutMs: 30_000,
    });
    assert.deepEqual(first, { last: { runs: 2 } });
    assert.match(
      [...target.queued.values()][0] ?? "",
      /本次运行即将收尾，1 个后台作业仍在跑：j1（quick/
    );
    const late = localJobs(dir, dir);
    const lateTarget = noticeTarget();
    new JobNotices(late, lateTarget);
    await late.start({
      command: "long",
      plan: script("l2.mjs", "setTimeout(() => {}, 300_000);"),
      env: process.env,
    });
    await settleBackgroundJobs({
      jobs: late,
      target: lateTarget,
      stopped: () => false,
      closeoutMs: 300,
    });
    assert.equal(late.get("j1").killedBy, "closeout");
    assert.equal(lateTarget.runs(), 2);
    await assert.rejects(
      late.start({ command: "again", plan: script("a.mjs", ""), env: process.env }),
      /总时限已到/
    );
    await late.killAll("aborted");
  } finally {
    await jobs.killAll("aborted");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("续跑：只有启动、没有结束记录的作业算丢失；作业号接着用过的最大号", () => {
  const entry = (event: Parameters<typeof backgroundJobEntry>[0]) => ({
    type: "custom",
    ...backgroundJobEntry(event),
  });
  const started = (jobId: string) =>
    entry({
      phase: "started",
      jobId,
      command: `cmd ${jobId}`,
      marker: "m",
      output: "pigeon://outputs/s/1",
    });
  assert.deepEqual(
    previousJobsOf([
      started("j1"),
      started("j2"),
      entry({ phase: "ended", jobId: "j2", state: "exited", exitCode: 0, outputBytes: 0 }),
      { type: "custom", customType: SessionEntryType.BackgroundJob, data: { event: "started" } },
    ]),
    { lost: [{ jobId: "j1", command: "cmd j1" }], lastId: 2 }
  );
});

// 装配冒烟：headless 主会话开后台作业
function backgroundRun(root: string, body: string) {
  const script = join(root, "..", `${root.split(/[\\/]/).pop()}-job.mjs`);
  writeFileSync(script, body);
  return createFakeStreamFn({
    replies: [
      {
        text: "",
        toolCalls: [
          {
            name: "run_command",
            args: { command: `"${process.execPath}" "${script}"`, background: true },
          },
        ],
      },
      { text: "等作业结束" },
      { text: "先等着" },
      { text: "收到" },
    ],
  });
}

function jobEntries(root: string, sessionId: string) {
  const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
  return (loaded?.main ?? [])
    .filter(
      (entry) => (entry as { customType?: unknown }).customType === SessionEntryType.BackgroundJob
    )
    .map((entry) => (entry as unknown as { data: { event: string; reason?: string } }).data);
}

test("装配：headless 收尾先让模型处理一轮「仍在跑」，再等作业跑完、结束通知进模型的下一轮；两件工具随 run_command 注册", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-jobs-headless-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-jobs-home-"));
  try {
    const streamFn = backgroundRun(root, 'setTimeout(() => console.log("bg-done"), 1500);');
    const result = await runHeadless({
      task: "跑个后台作业",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
    });
    assert.equal(result.status, "completed");
    assert.equal(streamFn.calls.length, 4);
    assert.match(
      JSON.stringify(streamFn.calls[2]?.context.messages.at(-1)),
      /本次运行即将收尾，1 个后台作业仍在跑/
    );
    const lastInput = JSON.stringify(streamFn.calls[3]?.context.messages.at(-1));
    assert.ok(
      lastInput.includes(JOB_NOTICE_PREFIX.trim()) && lastInput.includes("bg-done"),
      lastInput
    );
    const tools = (streamFn.calls[0]?.context.tools ?? []).map((tool) => tool.name);
    assert.ok(tools.includes("job_output") && tools.includes("job_kill"), tools.join(","));
    assert.deepEqual(
      jobEntries(root, result.sessionId).map((data) => data.event),
      ["started", "ended"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("装配：收尾等待计入墙钟，墙钟到了中止运行、停掉作业并记下来由", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-jobs-wall-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-jobs-wall-home-"));
  try {
    const streamFn = backgroundRun(root, "setTimeout(() => {}, 300_000);");
    const result = await runHeadless({
      task: "跑个停不下的作业",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      wallClockMs: 1500,
    });
    assert.notEqual(result.status, "completed");
    assert.deepEqual(
      jobEntries(root, result.sessionId).map((data) => [data.event, data.reason]),
      [
        ["started", undefined],
        ["ended", "aborted"],
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
