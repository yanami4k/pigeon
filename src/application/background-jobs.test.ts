// 后台作业的应用层接法（决策 365）：结束通知同一轮的合并成一条、已由 job_output 交回的撤回不重复；无人值守收尾先交
// 「仍在跑」让模型处理一轮、再等作业，总时限按每次运行各自计、到了停掉余下的并拒绝新开，总时限为 0 即直接停掉；续跑时
// 认出上一进程丢失的作业；装配冒烟——headless 收尾、墙钟到了中止并停掉作业、运行出错不进收尾
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import { JobPool, SessionJobs } from "../tools/background-jobs.ts";
import { CommandOutputStore } from "../tools/command-output.ts";
import type { HostJobExit, WorkspaceHost } from "../tools/workspace-host.ts";
import {
  backgroundJobEntry,
  JOB_NOTICE_PREFIX,
  JobNotices,
  previousJobsOf,
  settleBackgroundJobs,
} from "./background-jobs.ts";
import { runHeadless } from "./headless-core.ts";

// 通知队列的替身：递出由测试控制；runNotices 递出全部并回调
function noticeTarget(onRun: (runs: number) => void = () => {}) {
  const queued = new Map<string, string>();
  const delivered = new Set<string>();
  let seq = 0;
  let runs = 0;
  return {
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
    all: () => [...queued.values()],
    runNotices: async () => {
      runs += 1;
      for (const key of queued.keys()) delivered.add(key);
      onRun(runs);
      return { runs };
    },
    runs: () => runs,
  };
}

// 替身执行端：作业何时结束由测试决定（finish），停止即以 SIGKILL 结束
function controlledJobs() {
  const state = mkdtempSync(join(tmpdir(), "pigeon-jobs-app-"));
  const ends: Array<(exit: HostJobExit) => void> = [];
  const host = {
    platform: "linux",
    root: "/w",
    startJob: () => {
      let end: (exit: HostJobExit) => void = () => {};
      const done = new Promise<HostJobExit>((resolve) => {
        end = resolve;
      });
      ends.push(end);
      return {
        done,
        kill: async () => {
          end({ exitCode: null, signal: "SIGKILL" });
          await done;
        },
        record: async () => undefined,
      };
    },
  } as unknown as WorkspaceHost;
  const jobs = new SessionJobs({
    sessionId: "s1",
    host,
    store: new CommandOutputStore({
      base: state,
      outputsRoot: join(state, "outputs"),
      sessionId: "s1",
      maxBytes: 1024 * 1024,
    }),
    pool: new JobPool({ total: 8 }),
    perSession: 4,
    outputMaxBytes: 1024 * 1024,
  });
  const start = (command: string) =>
    jobs.start({ command, plan: { program: command, args: [], verbatim: false }, env: {} });
  const finish = async (index: number) => {
    ends[index]?.({ exitCode: 0 });
    await jobs.wait(jobs.get(`j${index + 1}`), 5000);
  };
  return {
    jobs,
    start,
    finish,
    cleanup: async () => {
      await jobs.killAll("aborted");
      rmSync(state, { recursive: true, force: true });
    },
  };
}

test("结束通知：还没递出时又结束的合并成一条；经 markReported 交回的撤回；已递出的不再重复", async () => {
  const c = controlledJobs();
  try {
    const target = noticeTarget();
    let woken = 0;
    new JobNotices(c.jobs, target, { wake: () => (woken += 1) });
    for (const name of ["cmd-a", "cmd-b", "cmd-c"]) await c.start(name);
    await c.finish(0);
    await c.finish(1);
    assert.equal(target.pending().length, 1);
    const merged = target.pending()[0] ?? "";
    assert.ok(
      merged.startsWith(JOB_NOTICE_PREFIX) && merged.includes("cmd-a") && merged.includes("cmd-b")
    );
    c.jobs.markReported(c.jobs.get("j1"));
    assert.equal(target.pending().length, 1);
    assert.ok(!(target.pending()[0] ?? "").includes("cmd-a"));
    target.deliverAll();
    await c.finish(2);
    assert.deepEqual(
      target.pending().map((text) => [text.includes("cmd-b"), text.includes("cmd-c")]),
      [[false, true]]
    );
    assert.equal(c.jobs.get("j2").reported, true);
    assert.equal(woken, 3);
  } finally {
    await c.cleanup();
  }
});

test("无人值守收尾：先交「仍在跑」让模型处理一轮，再等作业结束、把通知交给模型", async () => {
  const c = controlledJobs();
  try {
    await c.start("cmd-quick");
    const target = noticeTarget((runs) => {
      if (runs === 1) void c.finish(0);
    });
    new JobNotices(c.jobs, target);
    const settled = await settleBackgroundJobs({
      jobs: c.jobs,
      target,
      stopped: () => false,
      closeoutMs: 30_000,
    });
    assert.deepEqual(settled, { last: { runs: 2 } });
    const [first = "", second = ""] = target.all();
    assert.ok(first.includes("cmd-quick") && first.includes("job_kill"), first);
    assert.ok(second.includes("cmd-quick") && !second.includes("job_kill"), second);
  } finally {
    await c.cleanup();
  }
});

test("收尾总时限按每次运行各自计：到了停掉余下的、本次运行拒绝新开；下一次运行重新计、照样先交「仍在跑」", async () => {
  const c = controlledJobs();
  try {
    const target = noticeTarget();
    new JobNotices(c.jobs, target);
    await c.start("cmd-long");
    await settleBackgroundJobs({ jobs: c.jobs, target, stopped: () => false, closeoutMs: 300 });
    assert.equal(c.jobs.get("j1").killedBy, "closeout");
    assert.equal(target.runs(), 2);
    await assert.rejects(c.start("cmd-again"), /总时限/);
    c.jobs.beginRun();
    await c.start("cmd-next");
    await settleBackgroundJobs({ jobs: c.jobs, target, stopped: () => false, closeoutMs: 300 });
    assert.equal(c.jobs.get("j2").killedBy, "closeout");
    assert.equal(
      target.all().filter((text) => text.includes("cmd-next") && text.includes("job_kill")).length,
      1
    );
  } finally {
    await c.cleanup();
  }
});

test("收尾总时限为 0：不交「仍在跑」、不等，直接停掉作业，结束通知交给模型一轮", async () => {
  const c = controlledJobs();
  try {
    const target = noticeTarget();
    new JobNotices(c.jobs, target);
    await c.start("cmd-long");
    await settleBackgroundJobs({ jobs: c.jobs, target, stopped: () => false, closeoutMs: 0 });
    assert.equal(c.jobs.get("j1").killedBy, "closeout");
    assert.equal(target.runs(), 1);
    assert.ok(!target.all().some((text) => text.includes("job_kill")));
  } finally {
    await c.cleanup();
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
function backgroundRun(
  root: string,
  body: string,
  replies: Array<{ text: string }>,
  failOnCall?: number
) {
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
      ...replies,
    ],
    ...(failOnCall !== undefined ? { failOnCall } : {}),
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

async function inWorkspace(run: (root: string, home: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-jobs-headless-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-jobs-home-"));
  try {
    await run(root, home);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    // backgroundRun 把作业脚本写在工作区旁边（不在工作区里），一并删掉
    rmSync(`${root}-job.mjs`, { force: true });
  }
}

test("装配：headless 收尾先让模型处理一轮「仍在跑」，再等作业跑完、结束通知进模型的下一轮；两件工具随 run_command 注册", () =>
  inWorkspace(async (root, home) => {
    const streamFn = backgroundRun(root, 'setTimeout(() => console.log("bg-done"), 1500);', [
      { text: "等作业结束" },
      { text: "先等着" },
      { text: "收到" },
    ]);
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
    const promptRound = JSON.stringify(streamFn.calls[2]?.context.messages.at(-1));
    assert.ok(
      promptRound.includes(JOB_NOTICE_PREFIX.trim()) && promptRound.includes("job_kill"),
      promptRound
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
  }));

test("装配：收尾等待计入墙钟，墙钟到了以墙钟上限结束、停掉作业并记下来由", () =>
  inWorkspace(async (root, home) => {
    const streamFn = backgroundRun(root, "setTimeout(() => {}, 300_000);", [
      { text: "等作业结束" },
    ]);
    const result = await runHeadless({
      task: "跑个停不下的作业",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      wallClockMs: 1500,
    });
    assert.equal(result.status, "wall-clock-limit");
    assert.deepEqual(
      jobEntries(root, result.sessionId).map((data) => [data.event, data.reason]),
      [
        ["started", undefined],
        ["ended", "aborted"],
      ]
    );
  }));

test("装配：运行出错不进收尾轮，作业随运行面释放停掉并记下，终态保持出错", () =>
  inWorkspace(async (root, home) => {
    const streamFn = backgroundRun(root, "setTimeout(() => {}, 300_000);", [{ text: "不会到" }], 2);
    const result = await runHeadless({
      task: "跑个作业然后出错",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
    });
    assert.equal(result.status, "failed");
    assert.equal(streamFn.calls.length, 2);
    assert.deepEqual(
      jobEntries(root, result.sessionId).map((data) => [data.event, data.reason]),
      [
        ["started", undefined],
        ["ended", "aborted"],
      ]
    );
  }));
