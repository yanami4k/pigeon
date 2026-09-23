import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("镜像构建上下文（strands）：Dockerfile、stream_env.py、各组合起始提交的 pyproject，与各组合起始提交的日期（UTC，按它只取当时已发布的依赖）", () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-stream-ctx-"));
  const repo = mkdtempSync(join(tmpdir(), "pigeon-stream-ctx-repo-"));
  try {
    const git = (args: string[], env: Record<string, string> = {}) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, ...env },
      }).trim();
    git(["init", "-q"]);
    git(["config", "user.name", "t"]);
    git(["config", "user.email", "t@example.invalid"]);
    mkdirSync(join(repo, "strands-py"));
    const commitAt = (content: string, date: string) => {
      writeFileSync(join(repo, "strands-py", "pyproject.toml"), content);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "c"], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
      return git(["rev-parse", "HEAD"]);
    };
    const early = commitAt("early\n", "2026-08-19T07:59:40-04:00");
    const late = commitAt("late\n", "2026-09-10T21:15:49-04:00");
    const written = assembleImageContext({
      profileName: "strands",
      repoDir: repo,
      outDir: out,
      variants: [
        { name: "end", commit: late },
        { name: "V0", commit: early },
      ],
    });
    assert.deepEqual(written, [
      "Dockerfile",
      "stream_env.py",
      "pyproject-end.toml",
      "pyproject-V0.toml",
      "env-dates.txt",
    ]);
    assert.equal(readFileSync(join(out, "pyproject-V0.toml"), "utf8"), "early\n");
    assert.equal(
      readFileSync(join(out, "env-dates.txt"), "utf8"),
      "end 2026-09-11T01:15:49Z\nV0 2026-08-19T11:59:40Z\n"
    );
    assert.match(readFileSync(join(out, "Dockerfile"), "utf8"), /--exclude-newer/);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
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
