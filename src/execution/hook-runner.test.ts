// 钩子命令执行（决策 324）：事件 JSON 经标准输入、stdout 与 stderr 分开取回、退出码保真、
// 超时杀掉整棵进程树（孙进程不留活口）、PIGEON_PROJECT_DIR 透传、shell 启动计划（Windows cmd.exe / POSIX /bin/sh）、
// 经执行端在容器里执行（假执行端断言计划与输出映射）。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

test("经执行端执行：/bin/sh -c 包一层容器内 timeout（先试 -k、不认退回不带 -k），客户端兜底在 KILL 宽限之后，stdin 透传、PIGEON_PROJECT_DIR 取容器内根；timeout 的 124 记为超时", async () => {
  const seen: Array<{
    program: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    stdin: string | undefined;
    timeoutMs: number;
  }> = [];
  const host = {
    platform: "linux",
    root: "/testbed",
    async exec(
      plan: { program: string; args: string[] },
      options: { env: NodeJS.ProcessEnv; stdin?: string | undefined; timeoutMs: number }
    ): Promise<HostExecResult> {
      if (plan.args[1]?.includes("SLOW")) {
        // 模拟容器内 timeout 到期：用满限时后以 124 退出
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
          spawned: true,
          exitCode: 124,
          timedOut: false,
          outputBytes: 0,
          outputHash: "0".repeat(64),
          output: "",
          stdout: "",
          stderr: "",
        };
      }
      seen.push({
        program: plan.program,
        args: plan.args,
        env: options.env,
        stdin: options.stdin,
        timeoutMs: options.timeoutMs,
      });
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
  assert.equal(seen.length, 1);
  const call = seen[0];
  assert.equal(call?.program, "/bin/sh");
  const wrappedScript = call?.args[1] ?? "";
  assert.match(
    wrappedScript,
    /^if timeout -k 1 1 true .+; then timeout -k 1 1 sh -c 'gate\.sh'; elif timeout 1 true .+; then timeout 1 sh -c 'gate\.sh'; else sh -c 'gate\.sh'; fi$/,
    wrappedScript
  );
  // 宿主环境不渗进容器：只有 PIGEON_PROJECT_DIR，取容器内的工作区根
  assert.deepEqual(call?.env, { PIGEON_PROJECT_DIR: "/testbed" });
  assert.equal(call?.stdin, '{"hook_event_name":"Stop"}\n');
  assert.equal(
    call?.timeoutMs,
    2_000,
    "短预算：客户端兜底在容器内 TERM（1 秒）与 KILL 宽限（1 秒）之后"
  );
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.stdout, "json-out");
  assert.equal(outcome.stderr, "oops");
  // 容器内 timeout 到期（退出码 124）记为超时
  const timed = await runHookCommandViaHost(host, {
    command: "SLOW",
    cwd: "/testbed",
    platform: "linux",
    stdin: "{}\n",
    timeoutMs: 1000,
  });
  assert.equal(timed.timedOut, true);
});

function stubHost(
  respond: (plan: { program: string; args: string[] }) => Promise<Partial<HostExecResult>>,
  seen: Array<{ timeoutMs: number }> = []
): WorkspaceHost {
  return {
    platform: "linux",
    root: "/testbed",
    async exec(plan: { program: string; args: string[] }, options: { timeoutMs: number }) {
      seen.push({ timeoutMs: options.timeoutMs });
      return {
        spawned: true,
        exitCode: 0,
        timedOut: false,
        outputBytes: 0,
        outputHash: "0".repeat(64),
        output: "",
        stdout: "",
        stderr: "",
        ...(await respond(plan)),
      };
    },
  } as unknown as WorkspaceHost;
}

test("经执行端执行：容器内 timeout 的 124、137、143 用满限时记为超时，未到限时的同值退出码照常记为钩子出错", async () => {
  for (const code of [124, 137, 143]) {
    const host = stubHost(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return { exitCode: code };
    });
    const outcome = await runHookCommandViaHost(host, {
      command: "x",
      cwd: "/testbed",
      platform: "linux",
      stdin: "{}\n",
      timeoutMs: 1000,
    });
    assert.equal(outcome.timedOut, true, `退出码 ${code}`);
  }
  const quick = await runHookCommandViaHost(
    stubHost(async () => ({ exitCode: 137 })),
    { command: "x", cwd: "/testbed", platform: "linux", stdin: "{}\n", timeoutMs: 5000 }
  );
  assert.equal(quick.timedOut, false, "钩子自己很快以 137 退出：不是超时");
});

test("经执行端执行：客户端兜底与预算相称——SessionEnd 的 1.5 秒为 3 秒，30 秒的预算为 40 秒", async () => {
  const seen: Array<{ timeoutMs: number }> = [];
  const host = stubHost(async () => ({}), seen);
  for (const timeoutMs of [1500, 30_000]) {
    await runHookCommandViaHost(host, {
      command: "x",
      cwd: "/testbed",
      platform: "linux",
      stdin: "{}\n",
      timeoutMs,
    });
  }
  assert.deepEqual(
    seen.map((call) => call.timeoutMs),
    [3_000, 40_000]
  );
});

// 包裹脚本在真 shell 里跑（本机 /bin/sh 代替容器）：PATH 前置一个假 timeout，模拟不认 -k 的旧 busybox 与没有 timeout 的镜像
test("包裹脚本：timeout 不认 -k 时退回不带 -k 的写法，没有 timeout 时直接执行——钩子都照常跑", {
  skip: process.platform === "win32" ? "Windows 上没有 /bin/sh" : false,
}, async () => {
  const run = async (fakeTimeout: string): Promise<string> => {
    const dir = scriptDir();
    writeFileSync(join(dir, "timeout"), fakeTimeout, { mode: 0o755 });
    const host = stubHost(async (plan) => {
      const result = spawnSync(plan.program, plan.args, {
        env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
        input: "{}\n",
        encoding: "utf8",
      });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    });
    const outcome = await runHookCommandViaHost(host, {
      command: "printf 'ran:%s' \"$(cat)\"",
      cwd: "/testbed",
      platform: "linux",
      stdin: "{}\n",
      timeoutMs: 1000,
    });
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    return outcome.stdout;
  };
  // 旧 busybox：见到 -k 即报用法错误；不带 -k 时丢掉限时参数照常执行
  const noKill = [
    "#!/bin/sh",
    'if [ "$1" = "-k" ]; then echo "timeout: unrecognized option -k" >&2; exit 1; fi',
    "shift",
    'exec "$@"',
  ].join("\n");
  assert.equal(await run(noKill), "ran:{}");
  // 没有 timeout：两种写法都起不来
  assert.equal(await run("#!/bin/sh\nexit 127\n"), "ran:{}");
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

test("真容器：钩子超时被容器内 timeout 终止（只杀钩子进程，不重启容器——之后的钩子照常跑）", {
  skip: dockerImage === undefined ? "没有 Docker 或带 git 的镜像" : false,
  timeout: 600_000,
}, async () => {
  const repo = makeRepo();
  const id = `sess_HOOKT${process.pid}`;
  const volume = `pigeon-hook-timeout-test-${process.pid}`;
  const { openSandbox } = await import("./sandbox.ts");
  const sandbox = await openSandbox({
    repoRoot: repo,
    sessionId: id,
    network: "on",
    image: { kind: "image", image: dockerImage as string },
    cacheVolume: volume,
  });
  try {
    const slow = await runHookCommandViaHost(sandbox.host, {
      command: "sleep 60",
      cwd: sandbox.host.root,
      platform: sandbox.host.platform,
      stdin: "{}\n",
      timeoutMs: 2_000,
      env: {},
    });
    assert.equal(slow.timedOut, true, "容器内 timeout 到期记为超时");
    assert.ok(slow.durationMs < 12_000, `客户端兜底没兜上：${slow.durationMs}ms`);
    // 容器没有重启也没有留下卡住的东西：随后的钩子照常执行
    const after = await runHookCommandViaHost(sandbox.host, {
      command: "printf alive",
      cwd: sandbox.host.root,
      platform: sandbox.host.platform,
      stdin: "{}\n",
      timeoutMs: 10_000,
      env: {},
    });
    assert.equal(after.exitCode, 0);
    assert.equal(after.stdout, "alive");
  } finally {
    await sandbox.discard();
    try {
      execFileSync("docker", ["volume", "rm", "-f", volume], { timeout: 60_000 });
    } catch {
      // 卷不存在即忽略
    }
  }
});
