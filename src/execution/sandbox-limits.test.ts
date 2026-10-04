// 决策 333：日常沙箱容器的资源上限与超限提示。
//   ① 取值：缺省内存上限为 docker info 报的守护进程所在机器内存的一半，--memory-swap 取同值；进程数上限 4096；CPU 不限；
//      设置里写 0 为不限（该项参数不带）；docker info 读不到时不设内存上限并说明；
//   ② 超限判定：执行端在命令前后读容器 cgroup 的 oom_kill 计数，增加即"超出沙箱内存上限 <数值>"，向 agent（run_command 的
//      结果）与人（onNotice 一行）报出；读不到计数时退出码 137 报"可能超出"；计数读得到而未增加时不报。
// 开沙箱用假 docker（sandbox-docker-fixtures.ts）；超限判定用本机执行的假 docker，计数文件指到临时文件，由命令自己改写。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createRunCommandTool } from "../tools/run-command.ts";
import { createContainerWorkspaceHost } from "./container-host.ts";
import { localDockerHost } from "./local-docker-fixtures.ts";
import {
  formatBytes,
  openSandbox,
  resolveSandboxLimits,
  SANDBOX_DEFAULT_PIDS_LIMIT,
  sandboxLimitArgs,
  sandboxLimitsSummary,
} from "./sandbox.ts";
import { type FakeSandboxDocker, fakeSandboxDocker } from "./sandbox-docker-fixtures.ts";

const GiB = 1024 ** 3;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pigeon-sandbox-limits-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@example.invalid");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

// 起沙箱，返回 docker run 的参数与开工时的提示
async function runArgsOf(
  fake: FakeSandboxDocker,
  sessionId: string,
  limits?: Parameters<typeof openSandbox>[0]["limits"]
): Promise<{ args: string[]; logs: string[]; summary: string }> {
  const repo = makeRepo();
  const logs: string[] = [];
  try {
    const sandbox = await openSandbox({
      repoRoot: repo,
      sessionId,
      network: "on",
      image: { kind: "image", image: "sandbox-test:latest" },
      docker: fake.docker,
      containerRoot: fake.containerRoot,
      cacheRoot: fake.cacheRoot,
      log: (line) => logs.push(line),
      ...(limits !== undefined ? { limits } : {}),
    });
    const args = fake.state().containers[`pigeon-sandbox-${sessionId}`]?.args ?? [];
    const summary = JSON.stringify(sandbox.limits);
    await sandbox.discard();
    return { args, logs, summary };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

test("资源上限的取值：内存取机器内存的一半（向下取整到 MiB），进程数 4096，CPU 不限；设置写 0 为不限、参数不带", () => {
  assert.deepEqual(resolveSandboxLimits(undefined, 16 * GiB), {
    memoryBytes: 8 * GiB,
    pids: SANDBOX_DEFAULT_PIDS_LIMIT,
    cpus: 0,
  });
  assert.equal(SANDBOX_DEFAULT_PIDS_LIMIT, 4096);
  assert.equal(resolveSandboxLimits(undefined, 3 * 1024 * 1024 + 7).memoryBytes, 1024 * 1024);
  assert.equal(resolveSandboxLimits(undefined, undefined).memoryBytes, 0);
  assert.deepEqual(resolveSandboxLimits({ memoryBytes: 2 * GiB, pids: 0, cpus: 1.5 }, 16 * GiB), {
    memoryBytes: 2 * GiB,
    pids: 0,
    cpus: 1.5,
  });
  assert.deepEqual(sandboxLimitArgs({ memoryBytes: 8 * GiB, pids: 4096, cpus: 0 }), [
    "--memory",
    String(8 * GiB),
    "--memory-swap",
    String(8 * GiB),
    "--pids-limit",
    "4096",
  ]);
  assert.deepEqual(sandboxLimitArgs({ memoryBytes: 0, pids: 0, cpus: 2 }), ["--cpus", "2"]);
  assert.deepEqual(sandboxLimitArgs({ memoryBytes: 0, pids: 0, cpus: 0 }), []);
  assert.equal(formatBytes(8 * GiB), "8 GiB");
  assert.equal(formatBytes(1536 * 1024 * 1024), "1.5 GiB");
  assert.equal(formatBytes(512 * 1024 * 1024), "512 MiB");
});

test("开沙箱：启动参数带 --memory、--memory-swap（取 docker info 的 MemTotal 的一半）与 --pids-limit，不带 --cpus", async () => {
  const fake = fakeSandboxDocker({ memTotal: 12 * GiB });
  try {
    const { args } = await runArgsOf(fake, "sess_L1");
    assert.equal(valueAfter(args, "--memory"), String(6 * GiB), args.join(" "));
    assert.equal(valueAfter(args, "--memory-swap"), String(6 * GiB));
    assert.equal(valueAfter(args, "--pids-limit"), "4096");
    assert.equal(args.includes("--cpus"), false);
    // 内存总量取自 docker info（守护进程所在的机器），不是本进程所在机器
    assert.ok(fake.state().calls.some((call) => call[0] === "info"));
  } finally {
    fake.cleanup();
  }
});

test("开沙箱：设置写 0 为不限（参数不带），给了 CPU 即带 --cpus；设了内存时不读 docker info", async () => {
  const fake = fakeSandboxDocker();
  try {
    const { args } = await runArgsOf(fake, "sess_L2", { memoryBytes: 0, pids: 0, cpus: 2 });
    for (const flag of ["--memory", "--memory-swap", "--pids-limit"]) {
      assert.equal(args.includes(flag), false, `${flag}：${args.join(" ")}`);
    }
    assert.equal(valueAfter(args, "--cpus"), "2");
    assert.equal(
      fake.state().calls.some((call) => call[0] === "info"),
      false
    );
  } finally {
    fake.cleanup();
  }
});

test("开沙箱：docker info 读不到内存总量时不设内存上限，开工时说明；进程数上限照设", async () => {
  const fake = fakeSandboxDocker({ memTotal: null });
  try {
    const { args, logs } = await runArgsOf(fake, "sess_L3");
    assert.equal(args.includes("--memory"), false, args.join(" "));
    assert.equal(valueAfter(args, "--pids-limit"), "4096");
    assert.ok(
      logs.some((line) => line.includes("本次沙箱不设内存上限")),
      logs.join("\n")
    );
  } finally {
    fake.cleanup();
  }
});

test("开沙箱：执行端按生效的内存上限判定超限，提示经 notice 交给人；就绪摘要写明上限", async () => {
  const fake = fakeSandboxDocker({ memTotal: 16 * GiB });
  const repo = makeRepo();
  const counter = join(repo, ".git", "memory.events");
  writeFileSync(counter, "oom_kill 0\n");
  const notices: string[] = [];
  try {
    const sandbox = await openSandbox({
      repoRoot: repo,
      sessionId: "sess_L4",
      network: "on",
      image: { kind: "image", image: "sandbox-test:latest" },
      docker: fake.docker,
      containerRoot: fake.containerRoot,
      cacheRoot: fake.cacheRoot,
      notice: (line) => notices.push(line),
      oomCounterFiles: [counter],
    });
    try {
      assert.equal(
        sandboxLimitsSummary(sandbox.limits),
        "内存上限 8 GiB、进程数上限 4096、CPU 不限"
      );
      const result = await sandbox.host.exec(
        {
          program: "sh",
          args: ["-c", `echo 'oom_kill 1' > '${counter}'; exit 137`],
          verbatim: false,
        },
        { env: {}, timeoutMs: 20_000, maxOutputBytes: 1024, signal: undefined }
      );
      assert.deepEqual(result.memoryLimitExceeded, { limit: "8 GiB", certain: true });
      assert.equal(notices.length, 1);
      assert.match(notices[0] ?? "", /^超出沙箱内存上限 8 GiB/);
    } finally {
      await sandbox.discard();
    }
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// 设了内存上限的容器执行端：计数文件指到 counter（不存在即读不到）
function limitedHost(counter: string) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-oom-"));
  const local = localDockerHost(root);
  const notices: string[] = [];
  const host = createContainerWorkspaceHost({
    container: "box",
    root: local.containerRoot,
    docker: local.docker,
    memoryLimit: { label: "8 GiB", counterFiles: [join(root, "missing.events"), counter] },
    onNotice: (line) => notices.push(line),
  });
  return {
    root,
    host,
    notices,
    cleanup: () => {
      local.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("超限判定：命令前后 oom_kill 计数增加即报“超出沙箱内存上限 <数值>”——agent 在 run_command 的结果里看到，人收到一行", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-oom-counter-"));
  const counter = join(base, "memory.events");
  writeFileSync(counter, "low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n");
  const h = limitedHost(counter);
  try {
    const tool = createRunCommandTool({ workspaceRoot: h.host.root, host: h.host });
    // 命令被杀：计数加一（换成退出码 1 也照样判定——以计数为准，不看退出码）
    writeFileSync(
      join(h.root, "oom.sh"),
      `printf 'oom 2\\noom_kill 2\\n' > '${counter}'\nexit 1\n`
    );
    const result = await tool.execute("c1", { command: "sh oom.sh" }, undefined);
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    assert.match(text, /超出沙箱内存上限 8 GiB/);
    assert.doesNotMatch(text, /可能超出/);
    assert.deepEqual(result.details.memoryLimitExceeded, { limit: "8 GiB", certain: true });
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0] ?? "", /^超出沙箱内存上限 8 GiB/);
    // 计数读得到而没有增加：退出码 137 也不报
    const plain = await h.host.exec(
      { program: "sh", args: ["-c", "exit 137"], verbatim: false },
      { env: {}, timeoutMs: 20_000, maxOutputBytes: 1024, signal: undefined }
    );
    assert.equal(plain.exitCode, 137);
    assert.equal(plain.memoryLimitExceeded, undefined);
    assert.equal(h.notices.length, 1);
  } finally {
    h.cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});

test("超限判定：读不到计数时，退出码 137 报“可能超出沙箱内存上限 <数值>”，其余退出码不报", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-oom-counter-"));
  const h = limitedHost(join(base, "absent.events"));
  try {
    const run = (code: number) =>
      h.host.exec(
        { program: "sh", args: ["-c", `exit ${code}`], verbatim: false },
        { env: {}, timeoutMs: 20_000, maxOutputBytes: 1024, signal: undefined }
      );
    const killed = await run(137);
    assert.deepEqual(killed.memoryLimitExceeded, { limit: "8 GiB", certain: false });
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0] ?? "", /^可能超出沙箱内存上限 8 GiB/);
    const failed = await run(1);
    assert.equal(failed.memoryLimitExceeded, undefined);
    assert.equal(h.notices.length, 1);
  } finally {
    h.cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});

test("没设内存上限的执行端不读计数、不判定", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-oom-none-"));
  const local = localDockerHost(root);
  try {
    const result = await local.host.exec(
      { program: "sh", args: ["-c", "exit 137"], verbatim: false },
      { env: {}, timeoutMs: 20_000, maxOutputBytes: 1024, signal: undefined }
    );
    assert.equal(result.exitCode, 137);
    assert.equal(result.memoryLimitExceeded, undefined);
  } finally {
    local.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
