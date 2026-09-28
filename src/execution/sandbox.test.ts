// 日常沙箱的生命周期（决策 237、245–248）：假 docker 记下容器的 run 参数与标签，exec 在本机目录里用真 git 执行。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cleanResidualSandboxes,
  findResidualSandboxes,
  type OpenSandboxOptions,
  openSandbox,
  SANDBOX_CLEAN_COMMAND,
  sandboxNetworkArgs,
} from "./sandbox.ts";
import { type FakeSandboxDocker, fakeSandboxDocker } from "./sandbox-docker-fixtures.ts";

const IMAGE = { kind: "image", image: "sandbox-test:latest" } as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pigeon-sandbox-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@example.invalid");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function options(
  fake: FakeSandboxDocker,
  repo: string,
  sessionId: string,
  extra: Partial<OpenSandboxOptions> = {}
): OpenSandboxOptions {
  return {
    repoRoot: repo,
    sessionId,
    network: "on",
    image: IMAGE,
    docker: fake.docker,
    containerRoot: fake.containerRoot,
    ...extra,
  };
}

// 模拟 agent 在容器里改文件：经执行端执行命令
async function inContainer(
  sandbox: Awaited<ReturnType<typeof openSandbox>>,
  script: string
): Promise<void> {
  const result = await sandbox.host.exec(
    { program: "sh", args: ["-c", script], verbatim: false },
    { env: {}, timeoutMs: 30_000, maxOutputBytes: 65_536, signal: undefined }
  );
  assert.equal(result.exitCode, 0, result.output);
}

test("开沙箱从当前分支 HEAD 起步、带会话号标签；交回成 pigeon/sandbox-<会话号>，不动当前分支、工作目录与未提交改动", async () => {
  const repo = makeRepo();
  const fake = fakeSandboxDocker();
  try {
    // 宿主上有未提交的改动与未跟踪的文件
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    writeFileSync(join(repo, "u.txt"), "untracked\n");
    const lines: string[] = [];
    const sandbox = await openSandbox(
      options(fake, repo, "sess_T1", { log: (line) => lines.push(line) })
    );
    assert.ok(
      lines.some((line) => line.includes("不会带进沙箱")),
      `应提示未提交改动不带进沙箱：${lines.join("｜")}`
    );
    const container = fake.state().containers["pigeon-sandbox-sess_T1"];
    assert.ok(container !== undefined);
    assert.equal(container.labels["pigeon.sandbox"], "sess_T1");
    assert.equal(container.labels["pigeon.sandbox.pid"], String(process.pid));
    // 镜像本身以非 root 用户运行：不另指定用户
    assert.equal(container.args.includes("--user"), false);
    // 容器里是 HEAD 的内容，未提交改动与未跟踪文件都没带进去
    assert.equal(readFileSync(join(fake.localRoot, "a.txt"), "utf8"), "one\n");
    assert.equal(existsSync(join(fake.localRoot, "u.txt")), false);
    assert.equal(git(fake.localRoot, "symbolic-ref", "HEAD"), "refs/heads/pigeon/sandbox-sess_T1");

    await inContainer(sandbox, "printf changed > a.txt && printf new > b.txt");
    const before = {
      head: git(repo, "rev-parse", "HEAD"),
      branch: git(repo, "symbolic-ref", "HEAD"),
      status: git(repo, "status", "--porcelain"),
      a: readFileSync(join(repo, "a.txt"), "utf8"),
    };
    const result = await sandbox.close();
    assert.equal(result.branch, "pigeon/sandbox-sess_T1");
    assert.equal(result.changed, true);
    assert.equal(result.viewCommand, "git diff main..pigeon/sandbox-sess_T1");
    assert.equal(git(repo, "rev-parse", "pigeon/sandbox-sess_T1"), result.commit);
    assert.equal(git(repo, "show", "pigeon/sandbox-sess_T1:b.txt"), "new");
    assert.equal(git(repo, "show", "pigeon/sandbox-sess_T1:a.txt"), "changed");
    // 交回分支的父提交就是起点
    assert.equal(git(repo, "rev-parse", "pigeon/sandbox-sess_T1^"), before.head);
    assert.deepEqual(
      {
        head: git(repo, "rev-parse", "HEAD"),
        branch: git(repo, "symbolic-ref", "HEAD"),
        status: git(repo, "status", "--porcelain"),
        a: readFileSync(join(repo, "a.txt"), "utf8"),
      },
      before,
      "交回不动当前分支、工作目录与未提交的改动"
    );
    // 交回后删除容器
    assert.ok(fake.state().removed.includes("pigeon-sandbox-sess_T1"));
    assert.equal(fake.state().containers["pigeon-sandbox-sess_T1"], undefined);
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("会话中手动交回可多次：第二次在第一次之上前进；没有改动时分支指向起点", async () => {
  const repo = makeRepo();
  const fake = fakeSandboxDocker();
  try {
    const sandbox = await openSandbox(options(fake, repo, "sess_T2"));
    const empty = await sandbox.exportChanges();
    assert.equal(empty.changed, false);
    assert.equal(git(repo, "rev-parse", "pigeon/sandbox-sess_T2"), git(repo, "rev-parse", "HEAD"));
    await inContainer(sandbox, "printf 1 > c.txt");
    const first = await sandbox.exportChanges();
    await inContainer(sandbox, "printf 2 > c.txt");
    const second = await sandbox.exportChanges();
    assert.equal(git(repo, "rev-parse", "pigeon/sandbox-sess_T2^"), first.commit);
    assert.equal(git(repo, "show", "pigeon/sandbox-sess_T2:c.txt"), "2");
    assert.equal((await sandbox.close()).commit, second.commit);
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("联网：缺省联网不带网络参数；断网档带 --network none（与跑批器同一份参数）", async () => {
  assert.deepEqual(sandboxNetworkArgs("on"), []);
  assert.deepEqual(sandboxNetworkArgs("off"), ["--network", "none"]);
  for (const network of ["on", "off"] as const) {
    const repo = makeRepo();
    const fake = fakeSandboxDocker();
    try {
      const sandbox = await openSandbox(options(fake, repo, `sess_N${network}`, { network }));
      const args = fake.state().containers[`pigeon-sandbox-sess_N${network}`]?.args ?? [];
      const at = args.indexOf("--network");
      if (network === "off") {
        assert.equal(args[at + 1], "none", `断网档：${args.join(" ")}`);
      } else {
        assert.equal(at, -1, `缺省联网：${args.join(" ")}`);
      }
      await sandbox.discard();
    } finally {
      fake.cleanup();
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("镜像以 root 运行时改用非 root 用户", async () => {
  const repo = makeRepo();
  const fake = fakeSandboxDocker({ imageUsers: { "sandbox-test:latest": "" } });
  try {
    const sandbox = await openSandbox(options(fake, repo, "sess_R1"));
    const args = fake.state().containers["pigeon-sandbox-sess_R1"]?.args ?? [];
    assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
    await sandbox.discard();
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("镜像缺 git：开工即报错说明，容器被删除", async () => {
  const repo = makeRepo();
  const fake = fakeSandboxDocker({ noGit: ["sandbox-test:latest"] });
  try {
    await assert.rejects(openSandbox(options(fake, repo, "sess_G1")), /没有可用的 git/);
    assert.deepEqual(fake.state().containers, {});
    assert.ok(fake.state().removed.includes("pigeon-sandbox-sess_G1"));
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("续跑沙箱会话从它交回的分支起步；没有交回过的报错说明", async () => {
  const repo = makeRepo();
  const first = fakeSandboxDocker();
  const second = fakeSandboxDocker();
  const third = fakeSandboxDocker();
  try {
    const sandbox = await openSandbox(options(first, repo, "sess_C1"));
    await inContainer(sandbox, "printf first > d.txt");
    const exported = await sandbox.close();
    // 宿主当前分支另有新提交：续跑不从它起步
    writeFileSync(join(repo, "e.txt"), "host\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "host");
    const resumed = await openSandbox(options(second, repo, "sess_C1", { resume: true }));
    assert.equal(resumed.startCommit, exported.commit);
    assert.equal(resumed.startLabel, "pigeon/sandbox-sess_C1");
    assert.equal(git(second.localRoot, "rev-parse", "HEAD"), exported.commit);
    assert.equal(readFileSync(join(second.localRoot, "d.txt"), "utf8"), "first");
    assert.equal(existsSync(join(second.localRoot, "e.txt")), false);
    await inContainer(resumed, "printf second > d.txt");
    const again = await resumed.close();
    assert.equal(git(repo, "rev-parse", "pigeon/sandbox-sess_C1^"), exported.commit);
    assert.equal(git(repo, "rev-parse", "pigeon/sandbox-sess_C1"), again.commit);
    await assert.rejects(
      openSandbox(options(third, repo, "sess_C2", { resume: true })),
      /没有交回过沙箱分支 pigeon\/sandbox-sess_C2/
    );
    assert.deepEqual(third.state().containers, {});
  } finally {
    first.cleanup();
    second.cleanup();
    third.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("残留容器被识别：起它的进程已不在或容器已停，开沙箱时列出并提示清理命令；清理只删残留", async () => {
  const repo = makeRepo();
  const host = os.hostname();
  const labels = (sessionId: string, pid: number) => ({
    "pigeon.sandbox": sessionId,
    "pigeon.sandbox.pid": String(pid),
    "pigeon.sandbox.host": host,
  });
  const container = (sessionId: string, pid: number, state = "running") => ({
    image: "sandbox-test:latest",
    labels: labels(sessionId, pid),
    args: [],
    state,
  });
  const fake = fakeSandboxDocker({
    containers: {
      // 起它的进程已不在
      "pigeon-sandbox-sess_DEAD": container("sess_DEAD", 2_147_483_000),
      // 容器已停
      "pigeon-sandbox-sess_STOP": container("sess_STOP", process.pid, "exited"),
      // 在用
      "pigeon-sandbox-sess_LIVE": container("sess_LIVE", process.pid),
      // 别的主机起的：无从判断，不算残留
      "pigeon-sandbox-sess_AWAY": {
        ...container("sess_AWAY", 2_147_483_000),
        labels: { ...labels("sess_AWAY", 2_147_483_000), "pigeon.sandbox.host": `${host}-other` },
      },
    },
  });
  try {
    const residual = (await findResidualSandboxes(fake.docker)).map((info) => info.name).sort();
    assert.deepEqual(residual, ["pigeon-sandbox-sess_DEAD", "pigeon-sandbox-sess_STOP"]);
    const lines: string[] = [];
    const sandbox = await openSandbox(
      options(fake, repo, "sess_NEW", { log: (line) => lines.push(line) })
    );
    const notice = lines.find((line) => line.includes("残留") || line.includes("异常退出"));
    assert.ok(notice !== undefined, lines.join("｜"));
    assert.match(notice, /sess_DEAD/);
    assert.match(notice, /sess_STOP/);
    assert.doesNotMatch(notice, /sess_LIVE|sess_AWAY/);
    assert.ok(notice.includes(SANDBOX_CLEAN_COMMAND));
    // 开沙箱不自动删除残留
    assert.ok(fake.state().containers["pigeon-sandbox-sess_DEAD"] !== undefined);
    await sandbox.discard();
    const cleaned = (await cleanResidualSandboxes(fake.docker)).sort();
    assert.deepEqual(cleaned, ["pigeon-sandbox-sess_DEAD", "pigeon-sandbox-sess_STOP"]);
    assert.deepEqual(Object.keys(fake.state().containers).sort(), [
      "pigeon-sandbox-sess_AWAY",
      "pigeon-sandbox-sess_LIVE",
    ]);
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("项目不是 git 仓库、Docker 不可用：开沙箱报错说明原因", async () => {
  const plain = mkdtempSync(join(tmpdir(), "pigeon-sandbox-plain-"));
  const fake = fakeSandboxDocker();
  try {
    await assert.rejects(openSandbox(options(fake, plain, "sess_P1")), /要求项目是 git 仓库/);
    await assert.rejects(
      openSandbox({ ...options(fake, plain, "sess_P2"), docker: ["pigeon-no-such-docker-cli"] }),
      /Docker 不可用/
    );
    assert.deepEqual(fake.state().containers, {});
  } finally {
    fake.cleanup();
    rmSync(plain, { recursive: true, force: true });
  }
});

test("宿主当前检出的就是沙箱分支时交回报错、不改动它，容器保留", async () => {
  const repo = makeRepo();
  const fake = fakeSandboxDocker();
  try {
    const sandbox = await openSandbox(options(fake, repo, "sess_H1"));
    await sandbox.exportChanges();
    git(repo, "checkout", "-q", "pigeon/sandbox-sess_H1");
    const tip = git(repo, "rev-parse", "HEAD");
    await inContainer(sandbox, "printf x > f.txt");
    await assert.rejects(
      sandbox.close(),
      /容器 pigeon-sandbox-sess_H1 保留未删[\s\S]*当前检出的就是/
    );
    assert.equal(git(repo, "rev-parse", "HEAD"), tip);
    assert.ok(fake.state().containers["pigeon-sandbox-sess_H1"] !== undefined);
    await sandbox.discard();
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});
