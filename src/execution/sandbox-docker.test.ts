// 日常沙箱对着真 Docker（决策 245–247）：busybox 没有 git，开工即报错；带 git 的镜像上断网参数生效、缺省联网、
// 以非 root 用户运行、改动交回成宿主分支；npm 不告警未知配置，pnpm 新旧版本的 store 都在缓存卷里。没有 Docker 或没有所需镜像时跳过。带 git 的镜像取环境变量
// PIGEON_SANDBOX_TEST_IMAGE，否则取本地已有的通用镜像（pigeon-sandbox:*）或延续式跑批的 pigeon 镜像。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { openSandbox } from "./sandbox.ts";

const docker = (...args: string[]) =>
  spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
const dockerUp = docker("version", "--format", "{{.Server.Version}}").status === 0;
const hasImage = (image: string) => dockerUp && docker("image", "inspect", image).status === 0;

function gitImage(): string | undefined {
  const fromEnv = process.env.PIGEON_SANDBOX_TEST_IMAGE;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (!dockerUp) return undefined;
  const generic = docker("images", "pigeon-sandbox", "--format", "{{.Repository}}:{{.Tag}}")
    .stdout.split("\n")
    .find((line) => line.trim() !== "");
  if (generic !== undefined) return generic.trim();
  return hasImage("pigeon-stream-pigeon:v4") ? "pigeon-stream-pigeon:v4" : undefined;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pigeon-sandbox-real-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@example.invalid");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

const sessionId = (tag: string) => `sess_REAL${tag}${process.pid}`;

test.skipIf(!hasImage("busybox:latest") ? "没有 Docker 或 busybox 镜像" : false)(
  "真容器：busybox 没有 git，开沙箱即报错说明，容器被删除",
  async () => {
    const repo = makeRepo();
    const id = sessionId("G");
    // 容器起来才查 git，缓存卷已随 run 建立：用测试专用的名字，用完删除
    const volume = `pigeon-sandbox-cache-test-${process.pid}`;
    try {
      await assert.rejects(
        openSandbox({
          repoRoot: repo,
          sessionId: id,
          network: "on",
          image: { kind: "image", image: "busybox:latest" },
          cacheVolume: volume,
        }),
        /镜像 busybox:latest 里没有可用的 git/
      );
      assert.notEqual(docker("inspect", `pigeon-sandbox-${id}`).status, 0, "容器已删除");
    } finally {
      docker("volume", "rm", "-f", volume);
      rmSync(repo, { recursive: true, force: true });
    }
  }
);

const image = gitImage();

test.skipIf(image === undefined ? "没有 Docker 或带 git 的镜像" : false)(
  "真容器：断网参数生效、缺省联网；非 root 用户运行；改动交回成宿主分支、容器删除",
  { timeout: 600_000 },
  async () => {
    for (const network of ["off", "on"] as const) {
      const repo = makeRepo();
      // 决策 278：带未提交的改动与新建文件开工
      writeFileSync(join(repo, "a.txt"), "dirty\n");
      writeFileSync(join(repo, "n.txt"), "new\n");
      // 程序写出的 .pigeon/.gitignore（仓库没跟踪）不随交回带进分支
      mkdirSync(join(repo, ".pigeon"));
      writeFileSync(join(repo, ".pigeon", ".gitignore"), "state/\n");
      const head = git(repo, "rev-parse", "HEAD");
      const id = sessionId(network.toUpperCase());
      const name = `pigeon-sandbox-${id}`;
      // 决策 280：缓存卷用测试专用的名字，用完删除
      const volume = `pigeon-sandbox-cache-test-${process.pid}`;
      try {
        const sandbox = await openSandbox({
          repoRoot: repo,
          sessionId: id,
          network,
          image: { kind: "image", image: image as string },
          cacheVolume: volume,
        });
        try {
          assert.ok(sandbox.startSnapshot !== undefined, "带了未提交改动的快照");
          assert.equal(docker("exec", name, "cat", "/workspace/a.txt").stdout, "dirty\n");
          assert.equal(docker("exec", name, "cat", "/workspace/n.txt").stdout, "new\n");
          const mounts = docker(
            "inspect",
            "--format",
            "{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}",
            name
          ).stdout;
          assert.ok(
            mounts.includes(`${volume}:/pigeon-cache`),
            `缓存卷未挂（${network}）：${mounts}`
          );
          assert.equal(
            docker(
              "exec",
              name,
              "sh",
              "-c",
              "test -w /pigeon-cache/npm && test -w /pigeon-cache/go && echo ok"
            ).stdout.trim(),
            "ok",
            "缓存子目录对运行用户可写"
          );
          assert.equal(
            docker(
              "exec",
              name,
              "sh",
              "-c",
              'echo "$npm_config_cache:$PIP_CACHE_DIR"'
            ).stdout.trim(),
            "/pigeon-cache/npm:/pigeon-cache/pip"
          );
          // 给 pnpm 的环境变量 npm 不认，不告警未知配置
          const npmCache = docker("exec", name, "npm", "config", "get", "cache");
          assert.equal(npmCache.stdout.trim(), "/pigeon-cache/npm");
          assert.equal(npmCache.stderr, "");
          const mode = docker(
            "inspect",
            "--format",
            "{{.HostConfig.NetworkMode}}",
            name
          ).stdout.trim();
          if (network === "off") {
            assert.equal(mode, "none");
          } else {
            assert.notEqual(mode, "none");
          }
          assert.equal(
            docker(
              "inspect",
              "--format",
              '{{index .Config.Labels "pigeon.sandbox"}}',
              name
            ).stdout.trim(),
            id
          );
          assert.notEqual(docker("exec", name, "id", "-u").stdout.trim(), "0", "非 root 用户运行");
          const result = await sandbox.host.exec(
            {
              program: "sh",
              args: ["-c", "printf real > r.txt && git status --porcelain"],
              verbatim: false,
            },
            { env: {}, timeoutMs: 60_000, maxOutputBytes: 65_536, signal: undefined }
          );
          assert.equal(result.exitCode, 0, result.output);
          const exported = await sandbox.close();
          assert.equal(git(repo, "show", `${exported.branch}:r.txt`), "real");
          assert.equal(git(repo, "show", `${exported.branch}:n.txt`), "new");
          assert.equal(git(repo, "ls-tree", "-r", "--name-only", exported.branch, ".pigeon"), "");
          // 交回分支 = 快照 + agent 的提交
          assert.equal(exported.snapshotCommit, sandbox.startCommit);
          assert.equal(git(repo, "rev-parse", `${exported.branch}^^`), head);
          assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main");
          assert.equal(
            git(repo, "status", "--porcelain").includes("a.txt"),
            true,
            "宿主的未提交改动原样"
          );
          assert.notEqual(docker("inspect", name).status, 0, "交回后容器已删除");
        } finally {
          await sandbox.discard().catch(() => {});
        }
      } finally {
        docker("rm", "-f", name);
        docker("volume", "rm", "-f", volume);
        rmSync(repo, { recursive: true, force: true });
      }
    }
  }
);

test.skipIf(image === undefined ? "没有 Docker 或带 git 的镜像" : false)(
  "真容器：pnpm 旧版（10）与缺省安装的新版都按开容器时写的全局配置把 store 放在共用缓存卷里",
  { timeout: 600_000 },
  async (t) => {
    const repo = makeRepo();
    const id = sessionId("P");
    const name = `pigeon-sandbox-${id}`;
    const volume = `pigeon-sandbox-cache-test-${process.pid}-p`;
    try {
      const sandbox = await openSandbox({
        repoRoot: repo,
        sessionId: id,
        network: "on",
        image: { kind: "image", image: image as string },
        cacheVolume: volume,
      });
      try {
        for (const spec of ["pnpm@10", "pnpm"]) {
          // 去掉环境变量兜底，只看配置文件
          const installed = spawnSync(
            "docker",
            [
              "exec",
              name,
              "sh",
              "-c",
              'p="$(mktemp -d)" && npm i -g -s --prefix "$p" "$1" >/dev/null && env -u pnpm_config_store_dir "$p/bin/pnpm" store path',
              "sh",
              spec,
            ],
            { encoding: "utf8", timeout: 300_000 }
          );
          if (installed.status !== 0) t.skip(`容器里装不上 ${spec}：${installed.stderr.trim()}`);
          assert.ok(
            installed.stdout.trim().startsWith("/pigeon-cache/pnpm/store/"),
            `${spec}：${installed.stdout}`
          );
        }
      } finally {
        await sandbox.discard().catch(() => {});
      }
    } finally {
      docker("rm", "-f", name);
      docker("volume", "rm", "-f", volume);
      rmSync(repo, { recursive: true, force: true });
    }
  }
);
