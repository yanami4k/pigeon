// 日常沙箱的会话接线（决策 237、245–248）：pigeon run --sandbox 在容器里干活、验证命令经执行端在容器里执行、返回前交回；
// 分叉在起容器之前报错；改回逐条询问时仍接交互审批、[d] 不建目录放权。容器以假 docker 代替，工作区是真 git 仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PathScopedGrantUnsupportedError } from "../approvals/grant-store.ts";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { fakeSandboxDocker } from "../execution/sandbox-docker-fixtures.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { disposeRuntime } from "./runtime.ts";
import { runHeadlessInSandbox, SANDBOX_FORK_UNSUPPORTED, startSandbox } from "./sandbox-session.ts";
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

test("pigeon run --sandbox：agent 在容器里改文件，验证命令在容器里执行；返回前交回成分支并删除容器，宿主工作目录不变", async () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "pigeon-sandbox-home-"));
  const fake = fakeSandboxDocker();
  try {
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
        // 只有在容器的工作区里执行才能通过
        verify: { command: "test -f made.txt", timeoutMs: 30_000, source: "flag" },
      },
      {
        flags: SANDBOX_FLAGS,
        log: (line) => logs.push(line),
        overrides: {
          docker: fake.docker,
          image: { kind: "image", image: "sandbox-test:latest" },
          containerRoot: fake.containerRoot,
        },
      }
    );
    assert.equal(result.status, "completed", result.errorMessage);
    assert.equal(result.verification?.verdict, "pass", "验证命令在容器里执行");
    assert.equal(result.sandbox?.branch, `pigeon/sandbox-${sessionId}`);
    assert.equal(git(repo, "show", `pigeon/sandbox-${sessionId}:made.txt`), "ok");
    assert.equal(existsSync(join(repo, "made.txt")), false, "宿主工作目录不变");
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main");
    assert.match(result.sandboxNotice ?? "", /git diff main\.\.pigeon\/sandbox-/);
    assert.ok(logs.some((line) => line.includes("沙箱已就绪")));
    assert.deepEqual(fake.state().containers, {}, "交回后删除容器");
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("沙箱里开失败自动分叉重试：起容器之前报错说明原因", async () => {
  const repo = makeRepo();
  const fake = fakeSandboxDocker();
  try {
    await assert.rejects(
      startSandbox({
        flags: { ...SANDBOX_FLAGS, retryOnFail: 1 },
        governanceRoot: repo,
        sessionId: newSessionId(),
        log: () => {},
        overrides: { docker: fake.docker, containerRoot: fake.containerRoot },
      }),
      (error: Error) => error.message === SANDBOX_FORK_UNSUPPORTED
    );
    assert.deepEqual(fake.state().calls, [], "没有调用 docker");
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

test("沙箱改回逐条询问：注入执行端时仍接交互审批，[d] 不建目录放权，[a] 照常；分叉重试在装配前被拒", async () => {
  const governance = mkdtempSync(join(tmpdir(), "pigeon-sandbox-prompt-"));
  const workspace = mkdtempSync(join(tmpdir(), "pigeon-sandbox-prompt-ws-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-sandbox-prompt-home-"));
  const { host, cleanup } = localDockerHost(workspace);
  try {
    const base = {
      governanceRoot: governance,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      flags: { yolo: false, provider: "custom", modelId: "custom", persistThinking: true },
      workspaceHost: host,
      homeDir: home,
      createApprovalHandler: () => async () => ({ approved: true }),
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
    } finally {
      await disposeRuntime(opened.bundle);
    }
    await assert.rejects(
      openSessionRuntime({ ...base, sessionId: newSessionId(), retryOnFail: 1 }),
      /不支持失败自动分叉重试/
    );
  } finally {
    cleanup();
    for (const dir of [governance, workspace, home]) rmSync(dir, { recursive: true, force: true });
  }
});
