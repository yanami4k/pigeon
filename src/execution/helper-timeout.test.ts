// 决策 335：Pigeon 发往容器的辅助命令在容器内以 timeout 限时——到时只终止该命令，不重启容器，agent 在后台起的进程
// 不受影响；每个容器首次使用时探测有无 timeout（结果缓存在内存里）；没有时退回"杀客户端并重启容器"。
// 本文件用本机执行的假 docker（"容器内"即本机，timeout 是本机的）驱动，并记下每次 docker 调用；真容器上的同一组断言在
// container-host.test.ts 的真容器层。卡住的辅助命令用 FIFO 造：读一个没有写端的 FIFO 会一直挂着。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  ContainerHostError,
  containerExec,
  createContainerWorkspaceHost,
  TIMEOUT_PROBE_SCRIPT,
} from "./container-host.ts";

const SKIP =
  process.platform === "win32"
    ? "Windows 上没有 mkfifo 与按进程号探活"
    : spawnSync("sh", ["-c", "command -v timeout && command -v mkfifo"]).status !== 0
      ? "本机没有 timeout 或 mkfifo"
      : false;

// 本机执行的假 docker：exec 在 -w 给出的目录里直接运行；每次调用记一行；FAKE_NO_TIMEOUT=1 时探测报"没有 timeout"
const FAKE = `
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "exec") process.exit(0);
let i = 1;
let cwd = process.cwd();
let interactive = false;
for (;;) {
  if (args[i] === "-i") { interactive = true; i++; continue; }
  if (args[i] === "-w") { cwd = args[i + 1]; i += 2; continue; }
  if (args[i] === "-e" || args[i] === "-u") { i += 2; continue; }
  break;
}
const [program, ...rest] = args.slice(i + 1);
if (process.env.FAKE_NO_TIMEOUT === "1" && rest.some((a) => a.includes(${JSON.stringify(TIMEOUT_PROBE_SCRIPT)}))) process.exit(1);
// 输出经本进程转交（不把本进程的管道传给命令）：客户端被杀时，留在"容器里"的命令不会把客户端的管道挂住
const r = spawnSync(program, rest, { cwd, input: interactive ? readFileSync(0) : "" });
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
process.exit(r.status ?? 1);
`;

function setup(options: { noTimeout?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "pigeon-helper-timeout-"));
  const root = join(base, "ws");
  execFileSync("mkdir", ["-p", root]);
  const script = join(base, "docker.mjs");
  const log = join(base, "calls.jsonl");
  writeFileSync(script, FAKE);
  writeFileSync(log, "");
  const previous = { log: process.env.FAKE_LOG, noTimeout: process.env.FAKE_NO_TIMEOUT };
  process.env.FAKE_LOG = log;
  process.env.FAKE_NO_TIMEOUT = options.noTimeout === true ? "1" : "0";
  // 每个用例用不同的容器名：探测结果按容器缓存
  const container = `box-${base.slice(-6)}`;
  const docker = [process.execPath, script];
  const fifo = join(root, "stuck.fifo");
  execFileSync("mkfifo", [fifo]);
  return {
    root,
    fifo,
    docker,
    container,
    host: createContainerWorkspaceHost({ container, root, docker, helperTimeoutMs: 1000 }),
    calls: (): string[][] =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[]),
    cleanup: () => {
      // 放掉仍挂在 FIFO 上的读者（退回路径下本机没有"重启容器"可杀它）：以读写方式打开再关上，读者读到结束
      try {
        closeSync(openSync(fifo, "r+"));
      } catch {
        // FIFO 已不在
      }
      for (const [key, value] of [
        ["FAKE_LOG", previous.log],
        ["FAKE_NO_TIMEOUT", previous.noTimeout],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 还挂在这个 FIFO 上的 cat
function readersOf(fifo: string): string {
  return spawnSync("sh", ["-c", `ps -eo pid,args | grep -F -- "cat -- ${fifo}" | grep -v grep`], {
    encoding: "utf8",
  }).stdout;
}

describe("容器辅助命令的超时（本机执行的假 docker）", { skip: SKIP }, () => {
  test("有 timeout：卡住的辅助命令在容器内被终止，不重启容器；agent 在后台起的进程仍在", async () => {
    const f = setup();
    let background: number | undefined;
    try {
      // agent 的命令在后台留下一个进程
      const started = await f.host.exec(
        { program: "sh", args: ["-c", "sleep 300 >/dev/null 2>&1 & echo $!"], verbatim: false },
        { env: {}, timeoutMs: 20_000, maxOutputBytes: 1024, signal: undefined }
      );
      background = Number(started.output.trim());
      assert.ok(Number.isInteger(background) && alive(background));
      const target = await f.host.resolveExisting("stuck.fifo");
      const startedAt = Date.now();
      await assert.rejects(f.host.readText(target), (error: unknown) => {
        assert.ok(error instanceof ContainerHostError);
        assert.match(error.message, /辅助命令超过 1 秒，已在容器内终止/);
        return true;
      });
      // 在容器内限时到点即收尾，不等客户端兜底
      assert.ok(Date.now() - startedAt < 5_000, `用时 ${Date.now() - startedAt} 毫秒`);
      assert.equal(readersOf(f.fifo), "", "卡住的辅助命令已不在");
      assert.ok(alive(background), "agent 的后台进程仍在");
      const calls = f.calls();
      assert.equal(
        calls.some((call) => call[0] === "restart"),
        false,
        "不重启容器"
      );
      // 辅助命令经 timeout 起（$0 为探测到的绝对路径），探测只做一次
      const read = calls.find((call) => call.includes("cat"));
      assert.deepEqual(read?.slice(-7, -3), [
        "/bin/sh",
        "-c",
        'exec "$0" -k 2 1 "$@"',
        read?.at(-4),
      ]);
      assert.match(read?.at(-4) ?? "", /^\/.*timeout$/);
      assert.equal(calls.filter((call) => call.join(" ").includes(TIMEOUT_PROBE_SCRIPT)).length, 1);
      // agent 的命令不经 timeout
      assert.deepEqual(
        calls.find((call) => call.includes("sleep 300 >/dev/null 2>&1 & echo $!"))?.slice(-3),
        ["sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $!"]
      );
    } finally {
      if (background !== undefined && alive(background)) process.kill(background, "SIGKILL");
      f.cleanup();
    }
  });

  test("没有 timeout：退回杀客户端并重启容器；探测结果缓存，之后的辅助命令不再探测", async () => {
    const f = setup({ noTimeout: true });
    try {
      const target = await f.host.resolveExisting("stuck.fifo");
      await assert.rejects(f.host.readText(target), (error: unknown) => {
        assert.ok(error instanceof ContainerHostError);
        assert.match(error.message, /辅助命令超过 1 秒未结束，已重启容器/);
        return true;
      });
      const calls = f.calls();
      assert.deepEqual(calls.at(-1), ["restart", "-t", "0", f.container]);
      const read = calls.find((call) => call.includes("cat"));
      assert.deepEqual(read?.slice(-3), ["cat", "--", target], "不经 timeout");
      await f.host.isFile(target);
      assert.equal(
        f.calls().filter((call) => call.join(" ").includes(TIMEOUT_PROBE_SCRIPT)).length,
        1
      );
    } finally {
      f.cleanup();
    }
  });

  test("containerExec（沙箱开工与交回、跑批器的内部命令）同样在容器内限时", async () => {
    const f = setup();
    try {
      const result = await containerExec({
        container: f.container,
        docker: f.docker,
        command: ["cat", "--", f.fifo],
        timeoutMs: 1000,
      });
      assert.equal(result.timedOut, true);
      assert.notEqual(result.exitCode, 0);
      assert.equal(readersOf(f.fifo), "");
      assert.equal(
        f.calls().some((call) => call[0] === "restart"),
        false
      );
      // 正常结束的命令照常交回退出码与输出
      const ok = await containerExec({
        container: f.container,
        docker: f.docker,
        command: ["sh", "-c", "echo hi; exit 3"],
      });
      assert.deepEqual([ok.exitCode, ok.stdout, ok.timedOut], [3, "hi\n", false]);
    } finally {
      f.cleanup();
    }
  });
});
