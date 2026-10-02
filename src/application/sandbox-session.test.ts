// 日常沙箱的会话接线（决策 237、245–248）：pigeon run --sandbox 在容器里干活、返回前交回；改回逐条询问时仍接交互审批、
// [d] 不建目录放权；沙箱会话不启动 MCP 服务，开沙箱时列出已配置的服务名（决策 252）。容器以假 docker 代替，工作区是真 git 仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PathScopedGrantUnsupportedError } from "../approvals/grant-store.ts";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { fakeSandboxDocker } from "../execution/sandbox-docker-fixtures.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { projectSettingsPath } from "../state/paths.ts";
import { noMcpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { runHeadlessInSandbox, runSandboxCommand, startSandbox } from "./sandbox-session.ts";
import { openSessionRuntime } from "./session-runtime.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pigeon-sandbox-session-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@example.invalid");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), ".pigeon/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

const SANDBOX_FLAGS = { sandbox: { network: "on", approval: "yolo" } } as const;

// 配一个 MCP 服务（启动定义写在 .mcp.json；沙箱里不该被启动）
function configureMcp(root: string): void {
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { docs: { command: "node", args: ["-e", "0"] } } })
  );
}

// 记下被调用次数的 MCP 启动替身
function countingMcp() {
  const counter = { calls: 0 };
  const start = () => {
    counter.calls += 1;
    return noMcpSession();
  };
  return { counter, start };
}

test("pigeon run --sandbox：agent 在容器里改文件；返回前交回成分支并删除容器，宿主工作目录不变", async () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "pigeon-sandbox-home-"));
  const fake = fakeSandboxDocker();
  const mcp = countingMcp();
  try {
    configureMcp(repo);
    const sessionId = newSessionId();
    const logs: string[] = [];
    const result = await runHeadlessInSandbox(
      {
        task: "在工作区里建 made.txt",
        governanceRoot: repo,
        workspaceRoot: repo,
        sessionId,
        streamFn: createFakeStreamFn({
          replies: [
            {
              text: "建文件",
              toolCalls: [{ name: "run_command", args: { command: "printf ok > made.txt" } }],
            },
            { text: "完成" },
          ],
        }),
        yolo: true,
        homeDir: home,
        // 决策 325：入口在会话开始时读好的设置快照（MCP 服务名取自它）
        settings: loadSettings(repo, { homeDir: home }),
        // 只有在容器的工作区里执行才能通过
        startMcp: mcp.start,
      },
      {
        flags: SANDBOX_FLAGS,
        log: (line) => logs.push(line),
        overrides: {
          docker: fake.docker,
          image: { kind: "image", image: "sandbox-test:latest" },
          containerRoot: fake.containerRoot,
          cacheRoot: fake.cacheRoot,
        },
      }
    );
    assert.equal(result.status, "completed", result.errorMessage);
    assert.equal(result.sandbox?.branch, `pigeon/sandbox-${sessionId}`);
    assert.equal(git(repo, "show", `pigeon/sandbox-${sessionId}:made.txt`), "ok");
    assert.equal(existsSync(join(repo, "made.txt")), false, "宿主工作目录不变");
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main");
    assert.match(result.sandboxNotice ?? "", /git diff main\.\.pigeon\/sandbox-/);
    assert.ok(logs.some((line) => line.includes("沙箱已就绪")));
    // 决策 252：不启动 MCP 服务；开沙箱时列出已配置却不可用的服务名
    assert.equal(mcp.counter.calls, 0, "沙箱里不启动 MCP 服务");
    assert.ok(
      logs.some((line) => line.includes("不启动 MCP 服务") && line.includes("docs")),
      logs.join("｜")
    );
    assert.deepEqual(fake.state().containers, {}, "交回后删除容器");
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("资源上限取自设置的 sandbox 一节（决策 333）：写 0 的项不带参数，给了的按设置；就绪提示写明上限", async () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "pigeon-sandbox-home-"));
  const fake = fakeSandboxDocker();
  try {
    mkdirSync(join(repo, ".pigeon"), { recursive: true });
    writeFileSync(
      projectSettingsPath(repo),
      JSON.stringify({ sandbox: { memory: "2g", pids: 0, cpus: 2 } })
    );
    const logs: string[] = [];
    const sandbox = await startSandbox({
      flags: SANDBOX_FLAGS,
      governanceRoot: repo,
      sessionId: "sess_LIM",
      settings: loadSettings(repo, { homeDir: home }),
      log: (line) => logs.push(line),
      overrides: {
        docker: fake.docker,
        image: { kind: "image", image: "sandbox-test:latest" },
        containerRoot: fake.containerRoot,
        cacheRoot: fake.cacheRoot,
      },
    });
    assert.ok(sandbox !== undefined);
    try {
      const args = fake.state().containers["pigeon-sandbox-sess_LIM"]?.args ?? [];
      const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
      assert.equal(at("--memory"), String(2 * 1024 ** 3), args.join(" "));
      assert.equal(at("--memory-swap"), String(2 * 1024 ** 3));
      assert.equal(at("--pids-limit"), undefined, "写 0 为不限");
      assert.equal(at("--cpus"), "2");
      assert.ok(
        logs.some((line) => line.includes("内存上限 2 GiB、进程数上限 不限、CPU 上限 2 核")),
        logs.join("｜")
      );
    } finally {
      await sandbox.discard();
    }
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("不给 --sandbox 不开沙箱", async () => {
  const repo = makeRepo();
  const fake = fakeSandboxDocker();
  try {
    assert.equal(
      await startSandbox({
        flags: {},
        governanceRoot: repo,
        sessionId: newSessionId(),
        log: () => {},
      }),
      undefined,
      "不给 --sandbox 不开沙箱"
    );
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("没配 MCP 服务时开沙箱不提示 MCP", async () => {
  const repo = makeRepo();
  const fake = fakeSandboxDocker();
  try {
    const logs: string[] = [];
    const sandbox = await startSandbox({
      flags: SANDBOX_FLAGS,
      governanceRoot: repo,
      sessionId: newSessionId(),
      log: (line) => logs.push(line),
      overrides: {
        docker: fake.docker,
        image: { kind: "image", image: "sandbox-test:latest" },
        containerRoot: fake.containerRoot,
        cacheRoot: fake.cacheRoot,
      },
    });
    await sandbox?.discard();
    assert.equal(logs.filter((line) => line.includes("MCP")).length, 0, logs.join("｜"));
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// 决策 280：共用下载缓存的查看与清空命令
test("pigeon sandbox cache | clear-cache：查看占用与清空共用下载缓存；卷不存在与被容器占用各有说明", async () => {
  const fake = fakeSandboxDocker();
  const docker = fake.docker;
  try {
    assert.match(await runSandboxCommand(["cache"], { docker }), /pigeon-sandbox-cache 尚未建立/);
    assert.match(await runSandboxCommand(["clear-cache"], { docker }), /本就是空的/);
    fake.update((state) => {
      state.volumes["pigeon-sandbox-cache"] = { size: "1.2GB" };
    });
    assert.match(
      await runSandboxCommand(["cache"], { docker }),
      /pigeon-sandbox-cache：占用 1\.2GB；清空：pigeon sandbox clear-cache/
    );
    // 有沙箱容器挂着：不能清空，说明原因
    fake.update((state) => {
      state.containers.busy = {
        image: "sandbox-test:latest",
        labels: {},
        args: [],
        state: "running",
        volumes: ["pigeon-sandbox-cache"],
      };
    });
    await assert.rejects(runSandboxCommand(["clear-cache"], { docker }), /正被沙箱容器使用/);
    assert.match(await runSandboxCommand(["cache"], { docker }), /1 个沙箱容器正在使用/);
    fake.update((state) => {
      delete state.containers.busy;
    });
    assert.match(await runSandboxCommand(["clear-cache"], { docker }), /^已清空沙箱下载缓存/);
    assert.deepEqual(fake.state().removedVolumes, ["pigeon-sandbox-cache"]);
    await assert.rejects(
      runSandboxCommand(["nope"], { docker }),
      /用法：pigeon sandbox list \| clean \| cache \| clear-cache/
    );
    await assert.rejects(runSandboxCommand([], { docker }), /用法/);
  } finally {
    fake.cleanup();
  }
});

test("沙箱改回逐条询问：注入执行端时仍接交互审批，[d] 不建目录放权，[a] 照常；不启动 MCP", async () => {
  const governance = mkdtempSync(join(tmpdir(), "pigeon-sandbox-prompt-"));
  const workspace = mkdtempSync(join(tmpdir(), "pigeon-sandbox-prompt-ws-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-sandbox-prompt-home-"));
  const { host, cleanup } = localDockerHost(workspace);
  const mcp = countingMcp();
  try {
    configureMcp(governance);
    const base = {
      governanceRoot: governance,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      flags: { yolo: false, provider: "custom", modelId: "custom", persistThinking: true },
      workspaceHost: host,
      homeDir: home,
      createApprovalHandler: () => async () => ({ approved: true }),
      startMcp: mcp.start,
    };
    const opened = await openSessionRuntime({ ...base, sessionId: newSessionId() });
    try {
      const firstCall = { toolCallId: "c1", args: { path: "src/a.ts" } };
      assert.throws(
        () => opened.bundle.grantStore.create({ tool: "edit_file", pathPrefix: "src", firstCall }),
        PathScopedGrantUnsupportedError
      );
      assert.equal(
        opened.bundle.grantStore.create({ tool: "edit_file", firstCall }).tool,
        "edit_file"
      );
      assert.equal(opened.checkpoints, undefined, "不在宿主上打快照");
      assert.equal(mcp.counter.calls, 0, "沙箱会话不启动 MCP 服务");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    // 对照：不注入执行端时照常启动
    const { workspaceHost: _host, ...local } = base;
    const plain = await openSessionRuntime({ ...local, sessionId: newSessionId() });
    await disposeRuntime(plain.bundle);
    assert.equal(mcp.counter.calls, 1);
  } finally {
    cleanup();
    for (const dir of [governance, workspace, home]) rmSync(dir, { recursive: true, force: true });
  }
});

// 决策 331：沙箱会话（执行端在容器）照常注册 update_memory；写入落在宿主上的记忆文件（治理根在宿主侧）
test("沙箱会话注册 update_memory：写入落在宿主上的记忆文件", async () => {
  const governance = mkdtempSync(join(tmpdir(), "pigeon-sandbox-mem-"));
  const workspace = mkdtempSync(join(tmpdir(), "pigeon-sandbox-mem-ws-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-sandbox-mem-home-"));
  const { host, cleanup } = localDockerHost(workspace);
  try {
    const opened = await openSessionRuntime({
      governanceRoot: governance,
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "记",
            toolCalls: [
              {
                name: "update_memory",
                args: { action: "add", layer: "project", content: "沙箱里也能记" },
              },
            ],
          },
          { text: "好" },
        ],
      }),
      sessionId: newSessionId(),
      flags: {
        yolo: true,
        provider: "custom",
        modelId: "custom",
        persistThinking: true,
        pushedMemory: true,
      },
      workspaceHost: host,
      homeDir: home,
      memoryWrite: { source: "tui" },
    });
    try {
      assert.ok(
        opened.bundle.adapter.snapshot().tools.advertised.includes("update_memory"),
        "沙箱会话广告 update_memory"
      );
      const run = await opened.bundle.adapter.run("记一下");
      assert.equal(run.status, "completed");
      const memoryFile = join(governance, ".pigeon", "state", "memory.md");
      assert.ok(existsSync(memoryFile), "记忆文件写在宿主治根下");
      assert.ok(
        readFileSync(memoryFile, "utf8").includes("沙箱里也能记"),
        "内容落在宿主上的记忆文件"
      );
    } finally {
      await disposeRuntime(opened.bundle);
    }
  } finally {
    cleanup();
    for (const dir of [governance, workspace, home]) rmSync(dir, { recursive: true, force: true });
  }
});
