// 钩子命令执行（决策 324）：事件 JSON 经标准输入、stdout 与 stderr 分开取回、退出码保真、
// 超时杀掉整棵进程树（孙进程不留活口）、PIGEON_PROJECT_DIR 透传、shell 启动计划（Windows cmd.exe / POSIX /bin/sh）、
// 经执行端在容器里执行（假执行端断言计划与输出映射）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  hookShellPlan,
  runHookCommandLocal,
  runHookCommandViaHost,
} from "../execution/hook-runner.ts";
import type { HostExecResult, WorkspaceHost } from "../tools/workspace-host.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function scriptDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-hook-"));
  made.push(dir);
  return dir;
}

function script(dir: string, name: string, source: string): string {
  const file = join(dir, name);
  writeFileSync(file, source);
  return file;
}

const CWD = process.cwd();

test("本机执行：stdin 收到事件 JSON、stdout 与 stderr 分开、退出码保真", async () => {
  const dir = scriptDir();
  const file = script(
    dir,
    "io.mjs",
    [
      "let data = '';",
      "process.stdin.on('data', (c) => (data += c)).on('end', () => {",
      "  process.stdout.write('OUT:' + data.trim());",
      "  process.stderr.write('ERR:side');",
      "  process.exit(3);",
      "});",
    ].join("\n")
  );
  const outcome = await runHookCommandLocal({
    command: `node "${file}"`,
    cwd: CWD,
    platform: process.platform,
    stdin: '{"hook_event_name":"Stop"}\n',
    timeoutMs: 30_000,
    env: process.env,
  });
  assert.equal(outcome.spawned, true);
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.timedOut, false);
  assert.match(outcome.stdout, /OUT:\{"hook_event_name":"Stop"\}/);
  assert.match(outcome.stderr, /ERR:side/);
  assert.ok(!outcome.stdout.includes("ERR:side"), "两路不混");
});

test("PIGEON_PROJECT_DIR 透传", async () => {
  const dir = scriptDir();
  const file = script(
    dir,
    "env.mjs",
    "process.stdout.write(process.env.PIGEON_PROJECT_DIR ?? 'none');"
  );
  const outcome = await runHookCommandLocal({
    command: `node "${file}"`,
    cwd: CWD,
    platform: process.platform,
    stdin: "",
    timeoutMs: 30_000,
    env: { ...process.env, PIGEON_PROJECT_DIR: "D:/proj" },
  });
  assert.equal(outcome.stdout.trim(), "D:/proj");
});

test("超时杀掉整棵进程树：孙进程在超时后不再存活", async () => {
  // 这一条是有意对真实进程做的集成验证（整树终止只能对真进程验证，无法用假时钟替代）；轮询进程表本身需要真实等待
  const dir = scriptDir();
  const pidFile = join(dir, "grandchild.pid");
  const spawner = script(
    dir,
    "spawner.mjs",
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[2], String(child.pid));",
      "process.stdout.write('spawned');",
      "setTimeout(() => {}, 60000);",
    ].join("\n")
  );
  const outcome = await runHookCommandLocal({
    command: `node "${spawner}" "${pidFile}"`,
    cwd: CWD,
    platform: process.platform,
    stdin: "",
    timeoutMs: 1500,
    env: process.env,
  });
  assert.equal(outcome.timedOut, true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  const gone = await waitForGone(pid);
  assert.ok(gone, `孙进程 ${pid} 在超时后仍存活（整树终止失效）`);
});

// 进程是否还在：Windows 用 tasklist 查 PID，其余用 kill(pid,0)（EPERM 视为仍在；口径同 process-tree.test.ts）
function isAlive(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" });
      return out.includes(String(pid));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function waitForGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const started = Date.now();
  const check = (): void => {
    if (!isAlive(pid)) {
      resolve(true);
      return;
    }
    if (Date.now() - started > timeoutMs) {
      resolve(false);
      return;
    }
    setTimeout(check, 200);
  };
  check();
  return promise;
}

test("shell 启动计划：Windows 经 cmd.exe /d /s /c 去掉首尾一对引号；POSIX 经 /bin/sh -c", () => {
  const win = hookShellPlan("npm test", "win32", { COMSPEC: "C:\\Windows\\system32\\cmd.exe" });
  assert.deepEqual(win, {
    program: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/c", '"npm test"'],
    verbatim: true,
  });
  const posix = hookShellPlan("npm test", "linux", {});
  assert.deepEqual(posix, { program: "/bin/sh", args: ["-c", "npm test"], verbatim: false });
});

test("经执行端执行：计划为 /bin/sh -c，stdin 透传、PIGEON_PROJECT_DIR 取容器内根，输出与退出码映射回结果", async () => {
  const seen: Array<{
    program: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    stdin: string | undefined;
  }> = [];
  const host = {
    platform: "linux",
    root: "/testbed",
    async exec(
      plan: { program: string; args: string[] },
      options: { env: NodeJS.ProcessEnv; stdin?: string | undefined }
    ): Promise<HostExecResult> {
      seen.push({ program: plan.program, args: plan.args, env: options.env, stdin: options.stdin });
      return {
        spawned: true,
        exitCode: 2,
        timedOut: false,
        outputBytes: 10,
        outputHash: "0".repeat(64),
        output: "oops",
        stdout: "json-out",
        stderr: "oops",
      };
    },
  } as unknown as WorkspaceHost;
  const outcome = await runHookCommandViaHost(host, {
    command: "gate.sh",
    cwd: "/testbed",
    platform: "linux",
    stdin: '{"hook_event_name":"Stop"}\n',
    timeoutMs: 1000,
    env: { HOST_ONLY: "x" },
  });
  assert.deepEqual(seen, [
    {
      program: "/bin/sh",
      args: ["-c", "gate.sh"],
      // 宿主环境不渗进容器：只有 PIGEON_PROJECT_DIR，取容器内的工作区根
      env: { PIGEON_PROJECT_DIR: "/testbed" },
      stdin: '{"hook_event_name":"Stop"}\n',
    },
  ]);
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.stdout, "json-out");
  assert.equal(outcome.stderr, "oops");
});

// ---- 真容器（决策 324：沙箱会话的钩子在容器里执行；没有 Docker 或镜像时跳过，与沙箱用例同一约定）----

const dockerProbe = (() => {
  try {
    return execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      timeout: 60_000,
    });
  } catch {
    return undefined;
  }
})();
const dockerImage = (() => {
  const fromEnv = process.env.PIGEON_SANDBOX_TEST_IMAGE;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (dockerProbe === undefined) return undefined;
  try {
    const generic = execFileSync(
      "docker",
      ["images", "pigeon-sandbox", "--format", "{{.Repository}}:{{.Tag}}"],
      { encoding: "utf8", timeout: 60_000 }
    );
    const first = generic.split("\n").find((line) => line.trim() !== "");
    if (first !== undefined) return first.trim();
  } catch {
    // 继续探测
  }
  try {
    execFileSync("docker", ["image", "inspect", "pigeon-stream-pigeon:v4"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    return "pigeon-stream-pigeon:v4";
  } catch {
    return undefined;
  }
})();

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pigeon-hook-real-"));
  made.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

test("真容器：钩子在容器内执行（容器内写标记、宿主侧没有；两路输出分开取回）", {
  skip: dockerImage === undefined ? "没有 Docker 或带 git 的镜像" : false,
  timeout: 600_000,
}, async () => {
  const repo = makeRepo();
  const id = `sess_HOOKR${process.pid}`;
  const volume = `pigeon-hook-cache-test-${process.pid}`;
  const { openSandbox } = await import("./sandbox.ts");
  const sandbox = await openSandbox({
    repoRoot: repo,
    sessionId: id,
    network: "on",
    image: { kind: "image", image: dockerImage as string },
    cacheVolume: volume,
  });
  try {
    const outcome = await runHookCommandViaHost(sandbox.host, {
      // stdin 落进容器文件、PIGEON_PROJECT_DIR 回显、两路输出分开取回
      command:
        'mkdir -p .hook-mark && cat > .hook-mark/stdin.json && printf inside > .hook-mark/x && printf %s "$PIGEON_PROJECT_DIR" && printf err >&2',
      cwd: sandbox.host.root,
      platform: sandbox.host.platform,
      stdin: '{"hook_event_name":"Stop"}\n',
      timeoutMs: 60_000,
      env: process.env,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.stdout, sandbox.host.root, "PIGEON_PROJECT_DIR 为容器内的工作区根");
    assert.equal(outcome.stderr, "err");
    const marker = await sandbox.host.resolveExisting(".hook-mark/x");
    assert.equal(await sandbox.host.readText(marker), "inside");
    const stdinMarker = await sandbox.host.resolveExisting(".hook-mark/stdin.json");
    assert.equal(
      await sandbox.host.readText(stdinMarker),
      '{"hook_event_name":"Stop"}\n',
      "事件 JSON 经标准输入进容器"
    );
    assert.equal(existsSync(join(repo, ".hook-mark")), false, "标记只落在容器内，宿主侧没有");
  } finally {
    await sandbox.discard();
    try {
      execFileSync("docker", ["volume", "rm", "-f", volume], { timeout: 60_000 });
    } catch {
      // 卷不存在即忽略
    }
  }
});
