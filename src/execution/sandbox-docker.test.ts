// 日常沙箱对着真 Docker（决策 245–247）：busybox 没有 git，开工即报错；带 git 的镜像上断网参数生效、缺省联网、
// 以非 root 用户运行、改动交回成宿主分支。没有 Docker 或没有所需镜像时跳过。带 git 的镜像取环境变量
// PIGEON_SANDBOX_TEST_IMAGE，否则取本地已有的通用镜像（pigeon-sandbox:*）或延续式跑批的 pigeon 镜像。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

test("真容器：busybox 没有 git，开沙箱即报错说明，容器被删除", {
  skip: !hasImage("busybox:latest") ? "没有 Docker 或 busybox 镜像" : false,
}, async () => {
  const repo = makeRepo();
  const id = sessionId("G");
  try {
    await assert.rejects(
      openSandbox({
        repoRoot: repo,
        sessionId: id,
        network: "on",
        image: { kind: "image", image: "busybox:latest" },
      }),
      /镜像 busybox:latest 里没有可用的 git/
    );
    assert.notEqual(docker("inspect", `pigeon-sandbox-${id}`).status, 0, "容器已删除");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

const image = gitImage();

test("真容器：断网参数生效、缺省联网；非 root 用户运行；改动交回成宿主分支、容器删除", {
  skip: image === undefined ? "没有 Docker 或带 git 的镜像" : false,
  timeout: 600_000,
}, async () => {
  for (const network of ["off", "on"] as const) {
    const repo = makeRepo();
    const id = sessionId(network.toUpperCase());
    const name = `pigeon-sandbox-${id}`;
    try {
      const sandbox = await openSandbox({
        repoRoot: repo,
        sessionId: id,
        network,
        image: { kind: "image", image: image as string },
      });
      try {
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
        assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main");
        assert.notEqual(docker("inspect", name).status, 0, "交回后容器已删除");
      } finally {
        await sandbox.discard().catch(() => {});
      }
    } finally {
      docker("rm", "-f", name);
      rmSync(repo, { recursive: true, force: true });
    }
  }
});
