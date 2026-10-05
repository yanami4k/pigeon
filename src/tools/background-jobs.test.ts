// 后台作业与单次超时（决策 365）：后台启动立即交回作业号，job_output 等到结束交回退出码与输出，全文落盘可读；每会话与
// 整次运行的同时在跑上限（超出拒绝、列出在跑的）；停止与超时都杀整个进程组；单个输出文件超过上限只留末尾；期间变化扣除
// 前台改动；不带等待的连续查询另计；落盘编号取号即占号；组长退出后组里的残留一并清掉；收尾期间的等待受剩余时限约束；
// 崩溃后按记录清理，核对启动时间与标记，进程号被复用的不杀组长，查不到的记录留着，组长不在时照样按标记扫；
// Windows 与 macOS 的认进程各一条（只在各自平台上跑）
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { VIRTUAL_PATH_HINT } from "../state/paths.ts";
import { cleanupOrphanedJobs, JobPool, SessionJobs } from "./background-jobs.ts";
import { CommandOutputStore } from "./command-output.ts";
import { createJobKillTool, createJobOutputTool, JOB_IDLE_QUERY_LIMIT } from "./job-tools.ts";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { compareLocalProcess, localProcessRecord } from "./process-identity.ts";
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

function setup(
  options: { perSession?: number; outputMaxBytes?: number; pool?: JobPool; headTail?: number } = {}
) {
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
  const runTool = createRunCommandTool({
    workspaceRoot: root,
    host,
    jobs,
    output: {
      store,
      ...(options.headTail !== undefined
        ? { headBytes: options.headTail, tailBytes: options.headTail }
        : {}),
    },
  });
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
    await assert.rejects(a.background(a.node(LONG)), (error: Error) =>
      ["本会话", "2", "j1", "j2"].every((part) => error.message.includes(part))
    );
    await b.background(b.node(LONG));
    await assert.rejects(b.background(b.node(LONG)), (error: Error) =>
      ["整次运行", "3"].every((part) => error.message.includes(part))
    );
    assert.equal(pool.running().length, 3);
    await a.kill("j1");
    await b.background(b.node(LONG));
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test.skipIf(POSIX ? false : "进程组只在 POSIX 上")(
  "job_kill 停掉整个进程组：作业起的孙进程一并结束",
  async () => {
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
  }
);

test.skipIf(POSIX ? false : "进程组只在 POSIX 上")(
  "单次超时：timeout_seconds 超过上限即拒绝、不与 background 同用；到时杀整个进程组",
  async () => {
    const h = setup();
    try {
      await assert.rejects(h.run("echo hi", { timeout_seconds: 601 }), (error: Error) =>
        ["timeout_seconds", "600"].every((part) => error.message.includes(part))
      );
      await assert.rejects(
        h.run("echo hi", { timeout_seconds: 5, background: true }),
        (error: Error) =>
          ["timeout_seconds", "background"].every((part) => error.message.includes(part))
      );
      const pidFile = join(h.root, "child.pid");
      writeFileSync(join(h.root, "spawn.sh"), `sleep 300 &\necho $! > '${pidFile}'\nwait\n`);
      await assert.rejects(h.run("sh spawn.sh", { timeout_seconds: 1 }), RunCommandTimeoutError);
      const child = Number(readFileSync(pidFile, "utf8"));
      await until(() => !alive(child));
    } finally {
      await h.cleanup();
    }
  }
);

test("单个输出文件超过上限只留末尾，并注明丢弃了前面多少", async () => {
  const h = setup({ outputMaxBytes: 4096 });
  try {
    await h.background(
      h.node('for (let i = 0; i < 400; i += 1) console.log("line-" + i + "-" + "x".repeat(40));')
    );
    const result = await h.output({ job_id: "j1", wait_seconds: 30 });
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.match(text, /line-399-/);
    assert.ok(text.includes("丢弃"), text);
    assert.ok(text.includes(VIRTUAL_PATH_HINT), text);
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
    await assert.rejects(h.output({}), (error: Error) => error.message.includes("wait_seconds"));
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

// 崩溃清理的夹具：一个已退出进程的号（当作所属进程）、写记录、起进程
function orphanKit() {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-jobs-orphans-"));
  const spawned: number[] = [];
  const write = (owner: number, name: string, process: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({
        ownerPid: owner,
        sessionId: "s0",
        jobId: "j1",
        command: "sleep 300",
        startedAt: 0,
        process,
      })
    );
  };
  const start = (args: string[], marker?: string): number => {
    const child = spawn(args[0] as string, args.slice(1), {
      detached: true,
      stdio: "ignore",
      env: marker !== undefined ? { ...process.env, [RUN_MARKER_VAR]: marker } : process.env,
    });
    child.unref();
    spawned.push(child.pid as number);
    return child.pid as number;
  };
  const deadOwner = async (): Promise<number> => {
    const gone = spawn("true");
    await new Promise((resolve) => gone.on("close", resolve));
    return gone.pid as number;
  };
  const cleanup = () => {
    for (const pid of spawned) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // 已结束
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, write, start, deadOwner, cleanup };
}

test.skipIf(LINUX ? false : "按 /proc 认进程")(
  "崩溃后清理：组长核对一致即杀整组；标记不符或启动时间不符的不杀组长与组；容器记录只交出容器与标记",
  async () => {
    const k = orphanKit();
    try {
      const owner = await k.deadOwner();
      const marker = "ab".repeat(12);
      // 标记不符：进程不带标记、启动时间对得上
      const decoy = k.start(["sleep", "300"]);
      const decoyRecord = await localProcessRecord(decoy, marker);
      assert.ok(decoyRecord !== undefined);
      k.write(owner, "decoy", decoyRecord);
      assert.deepEqual(
        (await cleanupOrphanedJobs(k.dir)).map((r) => r.result),
        ["reused"]
      );
      assert.ok(alive(decoy));
      // 启动时间不符：组长带标记（照样按标记杀掉），组里不带标记的成员不动
      const memberFile = join(k.dir, "member.pid");
      const leader = k.start(
        ["sh", "-c", `env -u ${RUN_MARKER_VAR} sleep 300 & echo $! > '${memberFile}'; wait`],
        marker
      );
      await until(() => existsSync(memberFile) && readFileSync(memberFile, "utf8").trim() !== "");
      const member = Number(readFileSync(memberFile, "utf8"));
      const leaderRecord = await localProcessRecord(leader, marker);
      assert.ok(leaderRecord !== undefined);
      k.write(owner, "reused", { ...leaderRecord, startTime: "1" });
      assert.deepEqual(
        (await cleanupOrphanedJobs(k.dir)).map((r) => r.result),
        ["reused"]
      );
      await until(() => !alive(leader));
      assert.ok(alive(member));
      // 一致：整组杀掉；容器记录不采用其中的 docker 前缀
      const orphanMarker = "cd".repeat(12);
      const orphanFile = join(k.dir, "orphan-member.pid");
      const orphan = k.start(
        ["sh", "-c", `env -u ${RUN_MARKER_VAR} sleep 300 & echo $! > '${orphanFile}'; wait`],
        orphanMarker
      );
      await until(() => existsSync(orphanFile) && readFileSync(orphanFile, "utf8").trim() !== "");
      const orphanMember = Number(readFileSync(orphanFile, "utf8"));
      k.write(owner, "orphan", await localProcessRecord(orphan, orphanMarker));
      k.write(owner, "box", { kind: "container", docker: ["/tmp/evil"], container: "box", marker });
      const seen: unknown[] = [];
      const reports = await cleanupOrphanedJobs(k.dir, {
        killContainer: async (target) => {
          seen.push(target);
          return true;
        },
      });
      assert.deepEqual(reports.map((r) => r.result).sort(), ["killed", "killed"]);
      assert.deepEqual(seen, [{ container: "box", marker }]);
      await until(() => !alive(orphan) && !alive(orphanMember));
      assert.equal(existsSync(join(k.dir, "orphan.json")), false);
    } finally {
      k.cleanup();
    }
  }
);

test.skipIf(LINUX ? false : "按 /proc 认进程")(
  "崩溃后清理：组长已不在时照样按标记扫掉脱组的子孙；查不到的记录留着下次再试",
  async () => {
    const k = orphanKit();
    try {
      const owner = await k.deadOwner();
      const marker = "ef".repeat(12);
      const straggler = k.start(["sleep", "300"], marker);
      k.write(owner, "gone", {
        kind: "local",
        platform: "linux",
        pid: owner,
        startTime: "1",
        marker,
      });
      assert.deepEqual(
        (await cleanupOrphanedJobs(k.dir)).map((r) => r.result),
        ["gone"]
      );
      await until(() => !alive(straggler));
      k.write(owner, "unsure", {
        kind: "local",
        platform: "linux",
        pid: owner,
        startTime: "1",
        marker,
      });
      const reports = await cleanupOrphanedJobs(k.dir, { killLocal: async () => "unknown" });
      assert.deepEqual(
        reports.map((r) => r.result),
        ["unknown"]
      );
      assert.equal(existsSync(join(k.dir, "unsure.json")), true);
    } finally {
      k.cleanup();
    }
  }
);

test.skipIf(
  process.platform === "win32" ? false : "要 Windows 的 CIM（PowerShell），验证服务器是 Linux"
)("Windows：认进程按 CreationDate 与命令行，任一不符即判不同", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const record = await localProcessRecord(child.pid as number, "ab".repeat(12));
    assert.ok(record !== undefined && record.commandLine?.includes("setTimeout") === true);
    assert.equal(await compareLocalProcess(record), "same");
    assert.equal(await compareLocalProcess({ ...record, startTime: "1" }), "different");
    assert.equal(await compareLocalProcess({ ...record, commandLine: "other" }), "different");
  } finally {
    child.kill();
  }
});

test.skipIf(process.platform === "darwin" ? false : "要 macOS 的 ps，验证服务器是 Linux")(
  "macOS：认进程按 ps 的 lstart 与环境里的标记，任一不符即判不同",
  async () => {
    const marker = "ab".repeat(12);
    const child = spawn("sleep", ["60"], {
      stdio: "ignore",
      env: { ...process.env, [RUN_MARKER_VAR]: marker },
    });
    try {
      const record = await localProcessRecord(child.pid as number, marker);
      assert.ok(record !== undefined);
      assert.equal(await compareLocalProcess(record), "same");
      assert.equal(await compareLocalProcess({ ...record, startTime: "1" }), "different");
      assert.equal(await compareLocalProcess({ ...record, marker: "cd".repeat(12) }), "different");
    } finally {
      child.kill();
    }
  }
);

test("落盘编号取号即占号：两个作业同时在跑、作业在跑时前台输出被截断，各得各的编号与全文", async () => {
  const h = setup({ headTail: 64 });
  try {
    const a = await h.background(h.node('console.log("job-a"); setTimeout(() => {}, 800);'));
    const b = await h.background(h.node('console.log("job-b"); setTimeout(() => {}, 800);'));
    const fg = await h.run(h.node('for (let i = 0; i < 200; i += 1) console.log("fg-" + i);'));
    const uris = [
      a.details.background?.output,
      b.details.background?.output,
      fg.details.savedOutput?.uri,
    ];
    assert.equal(new Set(uris).size, 3, JSON.stringify(uris));
    await h.output({ job_id: "j1", wait_seconds: 30 });
    await h.output({ job_id: "j2", wait_seconds: 30 });
    const lines = async (uri: string | undefined) =>
      (await h.store.readWindow(uri ?? "", 1, 1000)).lines;
    assert.deepEqual(await lines(uris[0]), ["job-a"]);
    assert.deepEqual(await lines(uris[1]), ["job-b"]);
    assert.equal((await lines(uris[2])).at(-1), "fg-199");
  } finally {
    await h.cleanup();
  }
});

test.skipIf(POSIX ? false : "进程组只在 POSIX 上")(
  "组长退出后，它放到后台的子孙随作业结束一并清掉",
  async () => {
    const h = setup();
    try {
      const pidFile = join(h.root, "child.pid");
      writeFileSync(join(h.root, "spawn-exit.sh"), `sleep 300 &\necho $! > '${pidFile}'\n`);
      const result = await h.background("sh spawn-exit.sh");
      assert.ok(result.details.background !== undefined);
      const done = await h.output({ job_id: "j1", wait_seconds: 30 });
      assert.equal(done.details.jobs[0]?.state, "exited");
      await until(() => !alive(Number(readFileSync(pidFile, "utf8"))));
    } finally {
      await h.cleanup();
    }
  }
);

test("无人值守收尾期间，job_output 的等待不超过收尾的剩余时限", async () => {
  const h = setup();
  try {
    await h.background(h.node(LONG));
    h.jobs.beginCloseout(500);
    const startedAt = Date.now();
    const result = await h.output({ job_id: "j1", wait_seconds: 30 });
    assert.ok(Date.now() - startedAt < 10_000);
    assert.equal(result.details.jobs[0]?.state, "running");
  } finally {
    await h.cleanup();
  }
});
