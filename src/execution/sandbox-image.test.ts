// 日常沙箱的镜像（决策 247）：缺省通用镜像的标签与构建参数、项目配置改用镜像或 Dockerfile、缓存与构建失败的说明。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadSettings } from "../persistence/settings.ts";
import { sandboxConfigOf } from "../state/settings.ts";
import { fakeSandboxDocker } from "./sandbox-docker-fixtures.ts";
import { ensureSandboxImage, GENERIC_DOCKERFILE, resolveSandboxImage } from "./sandbox-image.ts";

// 决策 325：沙箱配置是项目共享设置的 sandbox 一节（字符串原样写成设置文件，用来造不是合法 JSON 的情形）
function project(config?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "pigeon-sandbox-image-"));
  if (config !== undefined) {
    mkdirSync(join(root, ".pigeon"));
    writeFileSync(
      join(root, ".pigeon", "settings.json"),
      typeof config === "string" ? config : JSON.stringify({ sandbox: config })
    );
  }
  return root;
}

// 经设置快照取 sandbox 一节（用户级指到空的临时目录）
function loadSandboxConfig(root: string) {
  const home = mkdtempSync(join(tmpdir(), "pigeon-sandbox-home-"));
  try {
    return sandboxConfigOf(loadSettings(root, { homeDir: home }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("通用镜像的 Dockerfile 在仓库里：Ubuntu 24.04，含 git、Python 3、ripgrep，Node 24 取官方二进制包并校验，以非 root 用户运行", () => {
  const content = readFileSync(GENERIC_DOCKERFILE, "utf8");
  assert.match(content, /ARG BASE_IMAGE=ubuntu:24\.04/);
  for (const pkg of ["git", "python3", "ripgrep", "xz-utils"]) {
    assert.match(content, new RegExp(`\\b${pkg}\\b`), pkg);
  }
  // Node 不走 apt（apt 的 nodejs 为 v18）：取 Node 24 长期支持版的官方二进制包，按官方 SHASUMS256 校验
  assert.doesNotMatch(content, /^\s+nodejs npm\b/m);
  assert.match(content, /^ARG NODE_MIRROR=https:\/\/nodejs\.org\/dist$/m);
  assert.match(content, /latest-v24\.x/);
  assert.match(content, /SHASUMS256\.txt/);
  assert.match(content, /sha256sum -c -/);
  assert.match(content, /^USER pigeon$/m);
  for (const arg of ["APT_MIRROR", "NODE_MIRROR", "PIP_INDEX_URL", "NPM_REGISTRY"]) {
    assert.match(content, new RegExp(`^ARG ${arg}=`, "m"), arg);
  }
});

test("缺省用通用镜像：标签带 Dockerfile 与底镜像的哈希，软件源不进标签；配置的构建参数压过环境变量", () => {
  const root = project();
  try {
    const plain = resolveSandboxImage(root, {}, {});
    assert.equal(plain.kind, "build");
    assert.match(plain.image, /^pigeon-sandbox:[0-9a-f]{12}$/);
    assert.deepEqual(plain.kind === "build" ? plain.buildArgs : undefined, {});
    const mirrored = resolveSandboxImage(
      root,
      {},
      {
        PIGEON_SANDBOX_APT_MIRROR: "https://mirrors.example/ubuntu",
        PIGEON_SANDBOX_PIP_INDEX: "https://pip.example/simple",
        PIGEON_SANDBOX_NPM_REGISTRY: "https://npm.example",
        PIGEON_SANDBOX_NODE_MIRROR: "https://node.example/dist",
      }
    );
    assert.equal(mirrored.image, plain.image, "软件源不影响镜像内容标签");
    assert.deepEqual(mirrored.kind === "build" ? mirrored.buildArgs : undefined, {
      APT_MIRROR: "https://mirrors.example/ubuntu",
      PIP_INDEX_URL: "https://pip.example/simple",
      NPM_REGISTRY: "https://npm.example",
      NODE_MIRROR: "https://node.example/dist",
    });
    const fromConfig = resolveSandboxImage(
      root,
      { build: { nodeMirror: "https://cfg.example/node" } },
      {}
    );
    assert.equal(
      fromConfig.kind === "build" ? fromConfig.buildArgs.NODE_MIRROR : undefined,
      "https://cfg.example/node"
    );
    const rebased = resolveSandboxImage(
      root,
      {},
      { PIGEON_SANDBOX_BASE_IMAGE: "mirror/ubuntu:24.04" }
    );
    assert.notEqual(rebased.image, plain.image, "换了底镜像即是另一份镜像");
    const overridden = resolveSandboxImage(
      root,
      { build: { aptMirror: "https://from-config" } },
      { PIGEON_SANDBOX_APT_MIRROR: "https://from-env" }
    );
    assert.equal(
      overridden.kind === "build" ? overridden.buildArgs.APT_MIRROR : undefined,
      "https://from-config"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("项目配置可改用任一镜像名或项目自己的 Dockerfile；畸形配置响亮失败", () => {
  const byName = project({ image: "python:3.12" });
  const byFile = project({ dockerfile: "ci/Dockerfile" });
  const broken = [
    project("{"),
    project({ image: "a", dockerfile: "b" }),
    project({ imag: "typo" }),
    project({ build: { aptMirorr: "x" } }),
    project({ context: "." }),
  ];
  try {
    assert.deepEqual(resolveSandboxImage(byName, loadSandboxConfig(byName)), {
      kind: "image",
      image: "python:3.12",
    });
    assert.throws(
      () => resolveSandboxImage(byFile, loadSandboxConfig(byFile)),
      /Dockerfile 不存在/
    );
    mkdirSync(join(byFile, "ci"));
    writeFileSync(join(byFile, "ci", "Dockerfile"), "FROM alpine\n");
    const spec = resolveSandboxImage(byFile, loadSandboxConfig(byFile));
    assert.equal(spec.kind, "build");
    assert.match(spec.image, /^pigeon-sandbox-project:[0-9a-f]{12}$/);
    assert.equal(spec.kind === "build" ? spec.context : undefined, join(byFile, "ci"));
    for (const root of broken) {
      assert.throws(() => loadSandboxConfig(root), /settings\.json|sandbox/);
    }
    assert.deepEqual(loadSandboxConfig(project()), {});
  } finally {
    for (const root of [byName, byFile, ...broken]) rmSync(root, { recursive: true, force: true });
  }
});

test("通用镜像首次使用时构建、之后用缓存；构建失败时报错写明可设的参数", async () => {
  const root = project();
  const fake = fakeSandboxDocker({ images: [] });
  try {
    const spec = resolveSandboxImage(
      root,
      {},
      { PIGEON_SANDBOX_APT_MIRROR: "https://m.example/ubuntu" }
    );
    const logs: string[] = [];
    assert.equal(
      await ensureSandboxImage(spec, { docker: fake.docker, log: (l) => logs.push(l) }),
      spec.image
    );
    const [build] = fake.state().builds;
    assert.ok(build !== undefined);
    assert.equal(build[build.indexOf("-t") + 1], spec.image);
    assert.equal(build[build.indexOf("-f") + 1], GENERIC_DOCKERFILE);
    assert.ok(build.includes("APT_MIRROR=https://m.example/ubuntu"));
    assert.ok(logs.some((line) => line.includes("首次使用")));
    // 第二次直接用缓存
    await ensureSandboxImage(spec, { docker: fake.docker });
    assert.equal(fake.state().builds.length, 1);

    const failing = fakeSandboxDocker({ images: [], buildFails: true });
    try {
      await assert.rejects(ensureSandboxImage(spec, { docker: failing.docker }), (error: Error) => {
        for (const name of [
          "PIGEON_SANDBOX_BASE_IMAGE",
          "PIGEON_SANDBOX_APT_MIRROR",
          "PIGEON_SANDBOX_NODE_MIRROR",
          "PIGEON_SANDBOX_PIP_INDEX",
          "PIGEON_SANDBOX_NPM_REGISTRY",
        ]) {
          assert.ok(error.message.includes(name), name);
        }
        assert.match(error.message, /failed to resolve source metadata/);
        return true;
      });
    } finally {
      failing.cleanup();
    }
  } finally {
    fake.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
