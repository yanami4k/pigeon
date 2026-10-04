import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { isPathInsideDir, resolveWorkspacePath, WorkspacePathError } from "./paths.ts";

function makeFixture(): { base: string; root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "pigeon-eval-dotdot-"));
  const root = join(base, "ws");
  const files: Record<string, string> = {
    "..notes.txt": "n",
    "src/a.ts": "a",
    "src/..cache/x.txt": "x",
    "lib/c.ts": "c",
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  writeFileSync(join(base, "outside.txt"), "o");
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("resolveWorkspacePath 接受以 .. 开头的合法文件名与目录名", () => {
  const { root, cleanup } = makeFixture();
  try {
    assert.equal(
      resolveWorkspacePath(root, "..notes.txt"),
      realpathSync(join(root, "..notes.txt"))
    );
    assert.equal(
      resolveWorkspacePath(root, "src/..cache/x.txt"),
      realpathSync(join(root, "src", "..cache", "x.txt"))
    );
  } finally {
    cleanup();
  }
});

test("resolveWorkspacePath 仍拒绝真正的逃逸", () => {
  const { base, root, cleanup } = makeFixture();
  try {
    assert.throws(() => resolveWorkspacePath(root, "../outside.txt"), WorkspacePathError);
    assert.throws(() => resolveWorkspacePath(root, join(base, "outside.txt")), WorkspacePathError);
    assert.throws(() => resolveWorkspacePath(root, "src/../../outside.txt"), WorkspacePathError);
    assert.throws(() => resolveWorkspacePath(root, "missing.txt"), WorkspacePathError);
  } finally {
    cleanup();
  }
});

test("isPathInsideDir 对以 .. 开头的名字判定正确", () => {
  const { root, cleanup } = makeFixture();
  try {
    assert.equal(isPathInsideDir(root, "src", "src/..cache/x.txt"), true);
    assert.equal(isPathInsideDir(root, ".", "..notes.txt"), true);
    assert.equal(isPathInsideDir(root, "src/..cache", "src/..cache/x.txt"), true);
    assert.equal(isPathInsideDir(root, "src", "..notes.txt"), false);
    assert.equal(isPathInsideDir(root, "src/..cache", "src/a.ts"), false);
  } finally {
    cleanup();
  }
});

test("isPathInsideDir 原有判定不变", () => {
  const { root, cleanup } = makeFixture();
  try {
    assert.equal(isPathInsideDir(root, "src", "src/a.ts"), true);
    assert.equal(isPathInsideDir(root, "src", "src"), true);
    assert.equal(isPathInsideDir(root, "src", "lib/c.ts"), false);
    assert.equal(isPathInsideDir(root, "src", "../outside.txt"), false);
    assert.equal(isPathInsideDir(root, "src", "src/missing.ts"), false);
  } finally {
    cleanup();
  }
});
