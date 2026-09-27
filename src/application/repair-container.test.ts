// 回炉接入容器执行端（决策 142 / 154②）：执行端能记下这一步的起点时，headless 在容器工作区上开回炉——验证经执行端
// 在容器里执行，修满轮数仍失败即以失败收尾、容器工作区保留 agent 的改动（决策 172 / 173：不做回退）。容器以在本机
// 执行命令的假 docker 代替，工作区是真实的 git 仓库；宿主侧的治理根与占位目录都不是 git 工作区。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import { runHeadless } from "./headless.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), "pigeon-repair-container-"));
  const testbed = join(base, "testbed");
  const governance = join(base, "job");
  const placeholder = join(governance, "workspace");
  const home = join(base, "home");
  for (const dir of [testbed, placeholder, home]) mkdirSync(dir, { recursive: true });
  git(testbed, "init", "-q");
  git(testbed, "config", "user.name", "t");
  git(testbed, "config", "user.email", "t@example.invalid");
  git(testbed, "config", "core.autocrlf", "false");
  writeFileSync(join(testbed, "a.txt"), "bug\n");
  writeFileSync(join(testbed, ".gitignore"), "build/\n");
  git(testbed, "add", "-A");
  git(testbed, "commit", "-q", "-m", "start");
  const { host, cleanup } = localDockerHost(testbed);
  return {
    base,
    testbed,
    governance,
    placeholder,
    home,
    host,
    cleanup: () => {
      cleanup();
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

// 验证命令经执行端在容器工作区根执行
const VERIFY: VerifyConfig = {
  command: "grep -qx fixed a.txt",
  timeoutMs: 30_000,
  source: "project",
};

function edit(from: string, to: string): FakeReply {
  return {
    text: `把 ${from} 改成 ${to}`,
    toolCalls: [
      {
        name: "edit_file",
        args: { path: "a.txt", old_string: `${from}\n`, new_string: `${to}\n` },
      },
    ],
  };
}

const done = (text = "改好了"): FakeReply => ({ text });

test("容器上的回炉：验证经执行端在容器里执行，第一次失败、回炉一轮修好即通过", async () => {
  const s = setup();
  try {
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: s.governance,
      workspaceRoot: s.placeholder,
      workspaceHost: s.host,
      streamFn: createFakeStreamFn({
        replies: [edit("bug", "half"), done(), edit("half", "fixed"), done("修好了")],
      }),
      yolo: true,
      homeDir: s.home,
      verify: VERIFY,
      repairRounds: 3,
    });
    assert.deepEqual(result.repair, {
      rounds: 1,
      verdict: "pass",
      closed: true,
    });
    assert.equal(readFileSync(join(s.testbed, "a.txt"), "utf8"), "fixed\n");
  } finally {
    s.cleanup();
  }
});

test("容器上的回炉：修满轮数仍失败即以失败收尾——agent 的提交、新建文件与新建的被忽略文件都留在容器工作区", async () => {
  const s = setup();
  try {
    const start = git(s.testbed, "rev-parse", "HEAD");
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: s.governance,
      workspaceRoot: s.placeholder,
      workspaceHost: s.host,
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "先提交一版，再造些文件",
            toolCalls: [
              {
                name: "run_command",
                args: {
                  command:
                    "echo w1 > a.txt && git commit -qam wip && echo n > new.txt && mkdir -p build && echo o > build/out.o",
                },
              },
            ],
          },
          done(),
          edit("w1", "w2"),
          done("还是不对"),
        ],
      }),
      yolo: true,
      homeDir: s.home,
      verify: VERIFY,
      repairRounds: 1,
    });
    assert.deepEqual(result.repair, {
      rounds: 1,
      verdict: "fail",
      closed: true,
    });
    assert.equal(result.errorMessage, undefined);
    assert.equal(git(s.testbed, "rev-parse", "HEAD~1"), start, "agent 的提交还在");
    assert.equal(readFileSync(join(s.testbed, "a.txt"), "utf8"), "w2\n");
    assert.ok(existsSync(join(s.testbed, "new.txt")));
    assert.ok(existsSync(join(s.testbed, "build", "out.o")));
  } finally {
    s.cleanup();
  }
});

test("容器上的回炉：执行端不能记下这一步的起点即启动报错", async () => {
  const s = setup();
  try {
    const { markStepStart: _m, ...bare } = s.host;
    await assert.rejects(
      runHeadless({
        task: "把 a.txt 修好",
        governanceRoot: s.governance,
        workspaceRoot: s.placeholder,
        workspaceHost: bare,
        streamFn: createFakeStreamFn({ replies: [done()] }),
        yolo: true,
        homeDir: s.home,
        verify: VERIFY,
        repairRounds: 1,
      }),
      /记下这一步的起点/
    );
  } finally {
    s.cleanup();
  }
});

test("容器回炉：验证前的还原与清理期间来了外部中止，不跑这次验证、不回炉，终态记 aborted", async () => {
  const s = setup();
  try {
    const abort = new AbortController();
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: s.governance,
      workspaceRoot: s.placeholder,
      workspaceHost: s.host,
      streamFn: createFakeStreamFn({ replies: [edit("bug", "half"), done()] }),
      yolo: true,
      homeDir: s.home,
      verify: {
        command: "touch verified.flag; grep -qx fixed a.txt",
        timeoutMs: 30_000,
        source: "project",
      },
      repairRounds: 3,
      abortSignal: abort.signal,
      // 验证前的清理里到达中止（相当于还原受保护文件期间来了限额信号）
      beforeVerify: async () => abort.abort(),
    });
    assert.equal(result.status, "aborted");
    assert.equal(existsSync(join(s.testbed, "verified.flag")), false, "没有跑验证");
    assert.equal(readFileSync(join(s.testbed, "a.txt"), "utf8"), "half\n", "没有回炉、没有撤回");
  } finally {
    s.cleanup();
  }
});
