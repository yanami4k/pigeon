import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveWorkspacePath, WorkspacePathError } from "./paths.ts";

// 每个用例独立的工作区夹具；返回清理函数
function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-paths-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("根内相对路径解析为真实绝对路径", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "export {};\n");
    const resolved = resolveWorkspacePath(root, "src/a.ts");
    assert.equal(resolved, realpathSync(join(root, "src/a.ts")));
  } finally {
    cleanup();
  }
});

test("../ 逃逸被拒绝", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeFileSync(join(root, "inside.txt"), "x");
    // 根外文件：tmpdir 下另一个真实存在的目标
    const outside = join(tmpdir(), "pigeon-paths-outside.txt");
    writeFileSync(outside, "secret");
    try {
      assert.throws(
        () => resolveWorkspacePath(root, "../pigeon-paths-outside.txt"),
        WorkspacePathError
      );
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    cleanup();
  }
});

test("根外绝对路径被拒绝", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const outside = join(tmpdir(), "pigeon-paths-abs.txt");
    writeFileSync(outside, "secret");
    try {
      assert.throws(() => resolveWorkspacePath(root, outside), WorkspacePathError);
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    cleanup();
  }
});

test("符号链接/junction 解析后越界被拒绝（真实路径判定，不看表面路径）", () => {
  const { root, cleanup } = makeWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "pigeon-paths-ext-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "secret");
    // junction 无需管理员权限（Windows）；realpath 会解析 junction 重解析点
    symlinkSync(outside, join(root, "link"), "junction");
    assert.throws(() => resolveWorkspacePath(root, "link/secret.txt"), WorkspacePathError);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    cleanup();
  }
});

test("不存在的路径报错", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    assert.throws(() => resolveWorkspacePath(root, "no/such/file.txt"), WorkspacePathError);
  } finally {
    cleanup();
  }
});
