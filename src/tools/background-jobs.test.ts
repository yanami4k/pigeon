// 后台作业与单次超时（决策 365）：后台启动立即交回作业号，job_output 等到结束交回退出码与输出，全文落盘可读；每会话与
// 整次运行的同时在跑上限（超出拒绝、列出在跑的）；停止与超时都杀整个进程组；单个输出文件超过上限只留末尾；期间变化扣除
// 前台改动；不带等待的连续查询另计；崩溃后按记录清理，核对启动时间与标记，进程号被复用的不杀
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupOrphanedJobs, JobPool, SessionJobs } from "./background-jobs.ts";
import { CommandOutputStore } from "./command-output.ts";
import { createJobKillTool, createJobOutputTool, JOB_IDLE_QUERY_LIMIT } from "./job-tools.ts";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { localProcessRecord } from "./process-identity.ts";
import { createRunCommandTool, RunCommandTimeoutError } from "./run-command.ts";
import { RUN_MARKER_VAR } from "./workspace-host.ts";

const POSIX = process.platform !== "win32";
const LINUX = process.platform === "linux";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function setup(options: { perSession?: number; outputMaxBytes?: number; pool?: JobPool } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-jobs-"));
  const state = mkdtempSync(join(tmpdir(), "pigeon-jobs-state-"));
  const scripts = mkdtempSync(join(tmpdir(), "pigeon-jobs-scripts-"));
  const host = createLocalWorkspaceHost(root);
  const store = new CommandOutputStore({
    base: state,
    outputsRoot: join(state, "outputs"),
    sessionId: "s1",
    maxBytes: 64 * 1024 * 1024,
  });
  const pool = options.pool ?? new JobPool({ total: 8, recordsDir: join(state, "jobs") });
  const events: Array<{ phase: string; reason?: string }> = [];
  const jobs = new SessionJobs({
    sessionId: "s1",
    host,
    store,
    pool,
    perSession: options.perSession ?? 2,
    outputMaxBytes: options.outputMaxBytes ?? 1024 * 1024,
    onEvent: (event) => events.push(event),
  });
  const runTool = createRunCommandTool({ workspaceRoot: root, host, jobs, output: { store } });
  const outputTool = createJobOutputTool(jobs);
  const killTool = createJobKillTool(jobs);
  let seq = 0;
  const id = () => `c${++seq}`;
  // node 脚本（放在工作区外）组成的命令
  const node = (body: string): string => {
    const file = join(scripts, `s${++seq}.mjs`);
    writeFileSync(file, body);
    return `"${process.execPath}" "${file}"`;
  };
  return {
    root,
    jobs,
    store,
    pool,
    events,
    node,
    run: (command: string, extra: Record<string, unknown> = {}) =>
      runTool.execute(id(), { command, ...extra }, undefined),
    background: (command: string) =>
      runTool.execute(id(), { command, background: true }, undefined),
    output: (params: Record<string, unknown>) => outputTool.execute(id(), params, undefined),
    kill: (jobId: string) => killTool.execute(id(), { job_id: jobId }, undefined),
    cleanup: async () => {
      await jobs.killAll("aborted");
      for (const dir of [root, state, scripts]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

const LONG = "setTimeout(() => {}, 300_000);";

test("后台启动立即交回作业号；job_output 带等待交回退出码与输出；结束后全文经落盘目录可读；启动与结束各记一次", async () => {
  const h = setup();
  try {
    const started = await h.background(
      h.node(
        'console.log("hello"); setTimeout(() => { console.log("done"); process.exit(3); }, 300);'
      )
    );
    assert.equal(started.details.background?.jobId, "j1");
    const result = await h.output({ job_id: "j1", wait_seconds: 30 });
    assert.deepEqual(result.details.jobs, [{ id: "j1", state: "exited", exitCode: 3 }]);
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.match(text, /hello[\s\S]*done/);
    const uri = started.details.background?.output ?? "";
    const window = await h.store.readWindow(uri, 1, 10);
    assert.deepEqual(window.lines, ["hello", "done"]);
    assert.deepEqual(
      h.events.map((event) => event.phase),
      ["started", "ended"]
    );
  } finally {
    await h.cleanup();
  }
});

test("同时在跑的上限：本会话超出即拒绝并列出在跑的作业；整次运行的总数跨会话计", async () => {
  const pool = new JobPool({ total: 3 });
  const a = setup({ perSession: 2, pool });
  const b = setup({ perSession: 2, pool });
  try {
    await a.background(a.node(LONG));
    await a.background(a.node(LONG));
    await assert.rejects(
      a.background(a.node(LONG)),
      /本会话同时在跑的后台作业已达上限（2 个）[\s\S]*j1[\s\S]*j2/
    );
    await b.background(b.node(LONG));
    await assert.rejects(b.background(b.node(LONG)), /整次运行同时在跑的后台作业已达上限（3 个/);
    assert.equal(pool.running().length, 3);
    await a.kill("j1");
    await b.background(b.node(LONG));
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test("job_kill 停掉整个进程组：作业起的孙进程一并结束", {
  skip: POSIX ? false : "进程组只在 POSIX 上",
}, async () => {
  const h = setup();
  try {
    const pidFile = join(h.root, "child.pid");
    writeFileSync(join(h.root, "spawn.sh"), `sleep 300 &\necho $! > '${pidFile}'\nwait\n`);
    await h.background("sh spawn.sh");
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const child = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(child));
    const killed = await h.kill("j1");
    assert.equal(killed.details.jobs[0]?.state, "killed");
    await until(() => !alive(child));
  } finally {
    await h.cleanup();
  }
});

test("单次超时：timeout_seconds 超过上限即拒绝、不与 background 同用；到时杀整个进程组", {
  skip: POSIX ? false : "进程组只在 POSIX 上",
}, async () => {
  const h = setup();
  try {
    await assert.rejects(h.run("echo hi", { timeout_seconds: 601 }), /timeout_seconds 至多 600/);
    await assert.rejects(
      h.run("echo hi", { timeout_seconds: 5, background: true }),
      /不要同时给 timeout_seconds 与 background/
    );
    const pidFile = join(h.root, "child.pid");
    writeFileSync(join(h.root, "spawn.sh"), `sleep 300 &\necho $! > '${pidFile}'\nwait\n`);
    await assert.rejects(h.run("sh spawn.sh", { timeout_seconds: 1 }), RunCommandTimeoutError);
    const child = Number(readFileSync(pidFile, "utf8"));
    await until(() => !alive(child));
  } finally {
    await h.cleanup();
  }
});

test("单个输出文件超过上限只留末尾，并注明丢弃了前面多少", async () => {
  const h = setup({ outputMaxBytes: 4096 });
  try {
    await h.background(
      h.node('for (let i = 0; i < 400; i += 1) console.log("line-" + i + "-" + "x".repeat(40));')
    );
    const result = await h.output({ job_id: "j1", wait_seconds: 30 });
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.match(text, /line-399-/);
    assert.match(text, /前面 \d+ 字节已丢弃/);
    const job = h.jobs.get("j1");
    const window = await h.store.readWindow(job.outputUri, 1, 1000);
    assert.ok(window.lines.length < 400 && window.lines.join("\n").length <= 4096);
    assert.doesNotMatch(window.lines.join("\n"), /line-0-/);
  } finally {
    await h.cleanup();
  }
});

test("期间变化：作业开始与结束时比出，扣除这期间 Pigeon 已知的前台改动，注明可能不精确", async () => {
  const h = setup();
  try {
    await h.background(
      h.node(
        'import { writeFileSync } from "node:fs"; writeFileSync("a.txt", "a"); writeFileSync("b.txt", "b"); setTimeout(() => {}, 300);'
      )
    );
    h.jobs.noteForegroundChanges(["a.txt"]);
    await h.output({ job_id: "j1", wait_seconds: 30 });
    const changes = h.jobs.get("j1").fileChanges;
    assert.deepEqual(changes?.added, ["b.txt"]);
    assert.match(changes?.note ?? "", /不精确/);
  } finally {
    await h.cleanup();
  }
});

test("不带等待的连续查询另计：到上限即拒绝，带等待的查询清零", async () => {
  const h = setup();
  try {
    await h.background(h.node(LONG));
    for (let i = 1; i < JOB_IDLE_QUERY_LIMIT; i += 1) await h.output({});
    await assert.rejects(h.output({}), /不带 wait_seconds/);
    await h.output({ wait_seconds: 1 });
    await h.output({ job_id: "j1" });
  } finally {
    await h.cleanup();
  }
});

test("会话结束停掉全部作业，结束记录写明来由", async () => {
  const h = setup();
  try {
    await h.background(h.node(LONG));
    await h.background(h.node(LONG));
    const stopped = await h.jobs.killAll("aborted");
    assert.equal(stopped.length, 2);
    assert.deepEqual(
      h.events.filter((event) => event.phase === "ended").map((event) => event.reason),
      ["aborted", "aborted"]
    );
  } finally {
    await h.cleanup();
  }
});

test("崩溃后清理：所属进程已不在的记录按启动时间与标记核对，一致才杀整组；进程号被复用的不杀；容器记录只交出容器与标记", {
  skip: LINUX ? false : "按 /proc 认进程",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-jobs-orphans-"));
  const marker = "ab".repeat(12);
  const orphan = spawn("sleep", ["300"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [RUN_MARKER_VAR]: marker },
  });
  orphan.unref();
  const gone = spawn("true");
  await new Promise((resolve) => gone.on("close", resolve));
  try {
    const pid = orphan.pid as number;
    const record = await localProcessRecord(pid, marker);
    assert.ok(record !== undefined);
    const write = (name: string, process: unknown) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${name}.json`),
        JSON.stringify({
          ownerPid: gone.pid,
          sessionId: "s0",
          jobId: "j1",
          command: "sleep 300",
          startedAt: 0,
          process,
        })
      );
    };
    write("reused", { ...record, startTime: "1" });
    assert.deepEqual(
      (await cleanupOrphanedJobs(dir)).map((report) => report.result),
      ["reused"]
    );
    assert.ok(alive(pid));
    write("orphan", record);
    const seen: unknown[] = [];
    write("box", { kind: "container", docker: ["/tmp/evil"], container: "box", marker });
    const reports = await cleanupOrphanedJobs(dir, {
      killContainer: async (target) => {
        seen.push(target);
        return true;
      },
    });
    assert.deepEqual(reports.map((report) => report.result).sort(), ["killed", "killed"]);
    assert.deepEqual(seen, [{ container: "box", marker }]);
    await until(() => !alive(pid));
    assert.equal(existsSync(join(dir, "orphan.json")), false);
  } finally {
    try {
      process.kill(orphan.pid as number, "SIGKILL");
    } catch {
      // 已结束
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
