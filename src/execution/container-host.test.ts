// 执行端接口的容器实现（决策 098）——跨边界四件事逐个验：超时杀干净、退出码保真、输出截断、路径映射；另验读写往返。
// 两层：
//   ① 替身层（任何机器都跑）：用一个假的 docker CLI 脚本记录调用，验证"超时与中止一律重启整个容器"这条策略、
//      OCI "程序不存在" 到 ENOENT 的还原、守护进程失败按环境错误上抛、宿主环境变量不进容器；
//   ② 真容器层（本机有可用的 docker 守护进程与测试镜像才跑，否则跳过并说明）：对着真容器验证四件事的实际效果。
//      测试镜像缺省 busybox:latest，可用 PIGEON_TEST_CONTAINER_IMAGE 指定；测试不主动拉镜像。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WorkspacePathError, WorkspacePathNotFoundError } from "../tools/paths.ts";
import { createRunCommandTool, RunCommandTimeoutError } from "../tools/run-command.ts";
import type { HostExecOptions } from "../tools/workspace-host.ts";
import {
  ContainerHostError,
  containerExec,
  createContainerWorkspaceHost,
  removeWorkspaceContainer,
  startWorkspaceContainer,
} from "./container-host.ts";

const execOptions = (overrides: Partial<HostExecOptions> = {}): HostExecOptions => ({
  env: { SECRET_FROM_HOST: "must-not-leak" },
  timeoutMs: 20_000,
  maxOutputBytes: 32 * 1024,
  signal: undefined,
  ...overrides,
});

// ---- ① 替身层 ----

// 假 docker：把每次调用的参数追加到日志；exec 的行为由环境变量 FAKE_MODE 决定
const FAKE_DOCKER = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
const mode = process.env.FAKE_MODE;
if (args[0] === "restart") {
  process.exit(mode === "restart-fails" ? 1 : 0);
}
if (args[0] === "exec") {
  if (mode === "hang") {
    setInterval(() => {}, 1000);
  } else if (mode === "missing-program") {
    process.stderr.write('OCI runtime exec failed: exec failed: unable to start container process: exec: "nope": executable file not found in $PATH: unknown\\n');
    process.exit(127);
  } else if (mode === "daemon-error") {
    process.stderr.write("Error response from daemon: container abc is not running\\n");
    process.exit(1);
  } else if (mode === "plain-127") {
    process.stderr.write("sh: nope: not found\\n");
    process.exit(127);
  } else {
    process.stdout.write("fine\\n");
    process.exit(0);
  }
}
`;

function fakeDocker(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-fake-docker-"));
  const script = join(dir, "docker.mjs");
  const log = join(dir, "calls.jsonl");
  writeFileSync(script, FAKE_DOCKER);
  writeFileSync(log, "");
  const previous = { log: process.env.FAKE_LOG, mode: process.env.FAKE_MODE };
  process.env.FAKE_LOG = log;
  process.env.FAKE_MODE = mode;
  return {
    host: createContainerWorkspaceHost({
      container: "box",
      root: "/testbed",
      docker: [process.execPath, script],
      env: { PATH: "/opt/env/bin:/usr/bin" },
    }),
    calls: (): string[][] =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[]),
    cleanup: () => {
      if (previous.log === undefined) {
        delete process.env.FAKE_LOG;
      } else {
        process.env.FAKE_LOG = previous.log;
      }
      if (previous.mode === undefined) {
        delete process.env.FAKE_MODE;
      } else {
        process.env.FAKE_MODE = previous.mode;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("容器执行端（替身）：超时后不只杀客户端——必定重启整个容器，结果标超时且等重启完成才交还", async () => {
  const fake = fakeDocker("hang");
  try {
    const startedAt = Date.now();
    // 超时给足假 docker 进程的启动时间：机器繁忙时它可能要一两秒才记下自己的调用
    const result = await fake.host.exec(
      { program: "sleep", args: ["300"], verbatim: false },
      execOptions({ timeoutMs: 4000 })
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.ok(Date.now() - startedAt < 30_000, "超时后应及时收尾");
    const calls = fake.calls();
    assert.deepEqual(calls.at(-1), ["restart", "-t", "0", "box"]);
    // exec 的形态：工作目录为容器内工作区根；只带配置的环境变量，宿主环境变量不进容器
    assert.deepEqual(
      calls.find((call) => call[0] === "exec"),
      ["exec", "-w", "/testbed", "-e", "PATH=/opt/env/bin:/usr/bin", "box", "sleep", "300"]
    );
    assert.equal(JSON.stringify(calls).includes("must-not-leak"), false);
  } finally {
    fake.cleanup();
  }
});

test("容器执行端（替身）：中止信号与超时同一条路——重启容器；重启失败按环境错误上抛", async () => {
  const fake = fakeDocker("hang");
  try {
    const controller = new AbortController();
    const pending = fake.host.exec(
      { program: "sleep", args: ["300"], verbatim: false },
      execOptions({ signal: controller.signal })
    );
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, null);
    assert.deepEqual(fake.calls().at(-1), ["restart", "-t", "0", "box"]);
  } finally {
    fake.cleanup();
  }
  const failing = fakeDocker("restart-fails");
  try {
    process.env.FAKE_MODE = "hang";
    const pending = failing.host.exec(
      { program: "sleep", args: ["300"], verbatim: false },
      execOptions({ timeoutMs: 200 })
    );
    // 重启那一次调用读到的是失败模式
    setTimeout(() => {
      process.env.FAKE_MODE = "restart-fails";
    }, 50);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ContainerHostError);
      assert.match(error.message, /容器重启失败/);
      return true;
    });
  } finally {
    failing.cleanup();
  }
});

test("容器执行端（替身）：OCI 报程序不存在还原为 ENOENT；命令自己退出 127 原样保留；守护进程失败不冒充退出码", async () => {
  const missing = fakeDocker("missing-program");
  try {
    const result = await missing.host.exec(
      { program: "nope", args: [], verbatim: false },
      execOptions()
    );
    assert.equal(result.spawned, false);
    assert.equal(result.spawnError?.code, "ENOENT");
    assert.equal(
      missing.calls().some((call) => call[0] === "restart"),
      false
    );
  } finally {
    missing.cleanup();
  }
  const plain = fakeDocker("plain-127");
  try {
    const result = await plain.host.exec(
      { program: "sh", args: ["-c", "nope"], verbatim: false },
      execOptions()
    );
    assert.equal(result.spawnError, undefined);
    assert.equal(result.exitCode, 127);
  } finally {
    plain.cleanup();
  }
  const daemon = fakeDocker("daemon-error");
  try {
    await assert.rejects(
      daemon.host.exec({ program: "ls", args: [], verbatim: false }, execOptions()),
      ContainerHostError
    );
  } finally {
    daemon.cleanup();
  }
});

// ---- ② 真容器层 ----

const IMAGE = process.env.PIGEON_TEST_CONTAINER_IMAGE ?? "busybox:latest";

function dockerSkipReason(): string | undefined {
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    // 没有守护进程时 CLI 可能长时间挂着不返回：短超时即判不可用
    timeout: 6_000,
    windowsHide: true,
  });
  if (info.error !== undefined || info.status !== 0) {
    return "本机没有可用的 docker 守护进程";
  }
  const image = spawnSync("docker", ["image", "inspect", IMAGE], {
    timeout: 20_000,
    windowsHide: true,
  });
  return image.status === 0 ? undefined : `本机没有测试镜像 ${IMAGE}（测试不主动拉取）`;
}

const skip = dockerSkipReason();

describe("容器执行端（真容器）", { skip: skip ?? false }, () => {
  const name = `pigeon-host-test-${process.pid}`;
  const root = "/work";
  const host = createContainerWorkspaceHost({ container: name, root });
  const sh = (script: string) =>
    containerExec({ container: name, command: ["sh", "-c", script], workdir: "/" });

  before(async () => {
    await removeWorkspaceContainer(name);
    await startWorkspaceContainer({ image: IMAGE, name });
    const made = await sh(
      `mkdir -p ${root}/src ${root}/.git /outside && printf 'one\\ntwo\\n' > ${root}/src/a.txt && ` +
        `printf 'x' > '${root}/..name.txt' && printf 'secret' > /outside/secret.txt && ` +
        `printf 'meta' > ${root}/.git/HEAD && ln -s /outside/secret.txt ${root}/src/leak && ln -s a.txt ${root}/src/alias`
    );
    assert.equal(made.exitCode, 0, made.stderr);
  });

  after(async () => {
    await removeWorkspaceContainer(name);
  });

  test("路径映射：相对、工作区内绝对、内部符号链接可解析；.. 逃逸、根外绝对路径、指向根外的符号链接、不存在的路径一律拒绝", async () => {
    assert.equal(await host.resolveExisting("src/a.txt"), `${root}/src/a.txt`);
    assert.equal(await host.resolveExisting("./src/../src/a.txt"), `${root}/src/a.txt`);
    assert.equal(await host.resolveExisting(`${root}/src/a.txt`), `${root}/src/a.txt`);
    assert.equal(await host.resolveExisting("src/alias"), `${root}/src/a.txt`);
    // 名字本身以两个点开头的合法文件不被误判
    assert.equal(await host.resolveExisting("..name.txt"), `${root}/..name.txt`);
    for (const escaping of [
      "../outside/secret.txt",
      "/outside/secret.txt",
      "src/leak",
      "/etc/passwd",
    ]) {
      await assert.rejects(host.resolveExisting(escaping), (error: unknown) => {
        assert.ok(error instanceof WorkspacePathError, `${escaping} 应被围栏拒绝`);
        assert.ok(!(error instanceof WorkspacePathNotFoundError), `${escaping} 不是「不存在」`);
        assert.match(error.message, /路径越出工作区根/);
        return true;
      });
    }
    await assert.rejects(host.resolveExisting("src/missing.txt"), WorkspacePathNotFoundError);
    // Windows 风格的宿主路径在容器里没有意义：按不存在处理，不做映射
    await assert.rejects(host.resolveExisting("C:\\work\\src\\a.txt"), WorkspacePathError);
    assert.throws(() => host.readTextSync("../outside/secret.txt"), WorkspacePathError);
  });

  test("读写往返：UTF-8、CRLF、无末尾换行与 1 MB 内容逐字节保真；同步读与异步读一致", async () => {
    const target = await host.resolveExisting("src/a.txt");
    assert.equal(await host.isFile(target), true);
    assert.equal(await host.isFile(`${root}/src`), false);
    assert.equal(await host.readText(target), "one\ntwo\n");
    const samples = [
      "中文与 emoji 🐦\r\n第二行\r\n",
      "no trailing newline",
      "",
      `${"0123456789abcdef".repeat(64 * 1024)}\n`,
      "引号 ' \" 与 $HOME `反引号` \\ 反斜杠\n",
    ];
    for (const sample of samples) {
      await host.writeText(target, sample);
      assert.equal(await host.readText(target), sample);
      assert.equal(host.readTextSync("src/a.txt"), sample);
    }
    await host.writeText(target, "one\ntwo\n");
  });

  test("退出码保真：0、任意非零、被信号杀死（128+N）原样带回；程序不存在为 ENOENT；输出按到达收集", async () => {
    const run = (program: string, args: string[]) =>
      host.exec({ program, args, verbatim: false }, execOptions());
    assert.equal((await run("true", [])).exitCode, 0);
    assert.equal((await run("sh", ["-c", "exit 3"])).exitCode, 3);
    assert.equal((await run("sh", ["-c", "exit 255"])).exitCode, 255);
    assert.equal((await run("sh", ["-c", "kill -9 $$"])).exitCode, 137);
    const mixed = await run("sh", ["-c", "echo out; echo err 1>&2; exit 2"]);
    assert.equal(mixed.exitCode, 2);
    assert.match(mixed.output, /out/);
    assert.match(mixed.output, /err/);
    const missing = await run("definitely-not-a-program", []);
    assert.equal(missing.spawned, false);
    assert.equal(missing.spawnError?.code, "ENOENT");
    // 工作目录是容器内的工作区根；宿主环境变量没有进容器
    assert.equal((await run("pwd", [])).output.trim(), root);
    assert.doesNotMatch((await run("env", [])).output, /SECRET_FROM_HOST/);
  });

  test("输出截断：只留开头 maxOutputBytes 字节，字节数与哈希按全量计", async () => {
    const lineCount = 20_000;
    const result = await host.exec(
      {
        program: "sh",
        args: ["-c", `i=0; while [ $i -lt ${lineCount} ]; do echo 0123456789; i=$((i+1)); done`],
        verbatim: false,
      },
      execOptions({ maxOutputBytes: 1000 })
    );
    const full = "0123456789\n".repeat(lineCount);
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputBytes, full.length);
    assert.equal(Buffer.byteLength(result.output), 1000);
    assert.equal(result.output, full.slice(0, 1000));
    assert.equal(result.outputHash, createHash("sha256").update(full).digest("hex"));
  });

  test("超时杀干净：命令与它放到后台的孙进程在超时后都不残留，工作区内容保留，随后的命令照常执行", async () => {
    const target = await host.resolveExisting("src/a.txt");
    await host.writeText(target, "before timeout\n");
    const startedAt = Date.now();
    const result = await host.exec(
      {
        program: "sh",
        args: ["-c", "sleep 600 & sleep 600 & echo started; wait"],
        verbatim: false,
      },
      execOptions({ timeoutMs: 1500 })
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /started/);
    assert.ok(Date.now() - startedAt < 60_000);
    const processes = await sh("ps");
    assert.equal(processes.exitCode, 0, processes.stderr);
    assert.doesNotMatch(processes.stdout, /sleep 600/, `残留进程：\n${processes.stdout}`);
    // 容器重启不丢工作区内容，执行端照常可用
    assert.equal(await host.readText(target), "before timeout\n");
    const next = await host.exec(
      { program: "echo", args: ["alive"], verbatim: false },
      execOptions()
    );
    assert.equal(next.exitCode, 0);
    assert.equal(next.output.trim(), "alive");
  });

  test("文件清单：不含版本库元数据；命令造成的新增、修改、删除在 run_command 的文件变化里可见；超时经工具上抛为环境错误", async () => {
    const listed = await host.listFiles(100);
    assert.equal(listed.truncated, false);
    assert.ok(listed.files.has("src/a.txt"));
    assert.ok(listed.files.has("..name.txt"));
    assert.equal(
      [...listed.files.keys()].some((file) => file.startsWith(".git/")),
      false
    );
    assert.equal((await host.listFiles(1)).truncated, true);

    const tool = createRunCommandTool({ workspaceRoot: root, host, timeoutMs: 1500 });
    tool.authorizeShell("c1");
    const result = await tool.execute(
      "c1",
      { command: "echo new > src/b.txt && echo changed-and-longer > src/a.txt && rm ..name.txt" },
      undefined
    );
    assert.equal(result.details.exitCode, 0);
    assert.deepEqual(result.details.fileChanges.added, ["src/b.txt"]);
    assert.deepEqual(result.details.fileChanges.modified, ["src/a.txt"]);
    assert.deepEqual(result.details.fileChanges.removed, ["..name.txt"]);
    assert.deepEqual(result.details.argv.slice(0, 2), ["/bin/sh", "-c"]);

    await assert.rejects(
      tool.execute("c2", { command: "sleep 600" }, undefined),
      RunCommandTimeoutError
    );
    await assert.rejects(
      tool.execute("c3", { command: "no-such-program-here" }, undefined),
      /命令不存在/
    );
  });
});

if (skip !== undefined) {
  test(`容器执行端（真容器）已跳过：${skip}`, { skip: true }, () => {});
}
