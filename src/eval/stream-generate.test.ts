import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assembleImageContext, probesPathFor, summarizeManifest } from "./stream-generate.ts";
import { composeStreamManifest } from "./stream-manifest.ts";
import { pigeonProfile } from "./stream-profiles.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("镜像构建上下文（本仓库）：Dockerfile 与指定提交的 package.json、锁文件逐字取自人的仓库", () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-stream-ctx-"));
  try {
    const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const written = assembleImageContext({
      profileName: "pigeon",
      repoDir: repoRoot,
      outDir: out,
      lockRev: head,
    });
    assert.deepEqual(written, ["Dockerfile", "package.json", "package-lock.json"]);
    const lock = execFileSync("git", ["-C", repoRoot, "show", `${head}:package-lock.json`]);
    assert.deepEqual(readFileSync(join(out, "package-lock.json")), lock);
    assert.match(readFileSync(join(out, "Dockerfile"), "utf8"), /npm ci/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("镜像构建上下文：未知仓库配置报错", () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-stream-ctx-"));
  try {
    assert.throws(
      () => assembleImageContext({ profileName: "nope", repoDir: repoRoot, outDir: out }),
      /未知的仓库配置/
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("探针记录路径与清单摘要", () => {
  assert.equal(probesPathFor("/x/pigeon.json"), "/x/pigeon.probes.json");
  assert.equal(probesPathFor("/x/pigeon"), "/x/pigeon.probes.json");
  const change = (path: string) => ({ path, status: "M" as const, added: 1, deleted: 0 });
  const manifest = composeStreamManifest({
    profile: pigeonProfile,
    rangeStart: "base0000000",
    commits: [
      {
        sha: "a1",
        parent: "base0000000",
        subject: "a",
        message: "a",
        files: [change("src/a.ts"), change("src/a.test.ts")],
        probe: { parentFails: true, commitPasses: true },
      },
      {
        sha: "b2",
        parent: "a1",
        subject: "b",
        message: "b",
        files: [change("src/b.ts")],
        formatOnly: false,
      },
    ],
    readHumanFile: () => "",
  });
  assert.equal(
    summarizeManifest(manifest),
    [
      "pigeon-harness：2 步，1 条流",
      "  全部：题 1、维护步 1、套用 0、跳过 0、重置 0",
      "  s1（起点 base00000，2 步）：题 1（其中红测试对 0）、维护步 1、套用 0、跳过 0",
    ].join("\n")
  );
});
