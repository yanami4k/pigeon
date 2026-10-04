// 路径围栏判定补充（M4 S6，决策 3a）：grant 目录限定的确定性匹配。
// 与 resolveWorkspacePath 同源于 realpath 机制（符号链接/junction、win32 大小写坑已由 paths.ts 解决）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { isPathInsideDir } from "./paths.ts";

function makeWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-paths-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("目录包含：目录内的文件匹配，目录外不匹配", () => {
  const { root, cleanup } = makeWorkspace({
    "src/a.ts": "a",
    "src/deep/b.ts": "b",
    "lib/c.ts": "c",
  });
  try {
    assert.equal(isPathInsideDir(root, "src", "src/a.ts"), true);
    assert.equal(isPathInsideDir(root, "src", "src/deep/b.ts"), true);
    assert.equal(isPathInsideDir(root, "src", "lib/c.ts"), false);
    assert.equal(
      isPathInsideDir(root, "src", "srcx/a.ts"),
      false,
      "前缀相近但不相干的目录不得匹配"
    );
    // 目录本身（相对路径为 "."）包含工作区根内一切
    assert.equal(isPathInsideDir(root, ".", "lib/c.ts"), true);
  } finally {
    cleanup();
  }
});

test("目录包含：目标不存在或目录不存在 → 不匹配（授权判定不猜，回落人工审批）", () => {
  const { root, cleanup } = makeWorkspace({ "src/a.ts": "a" });
  try {
    assert.equal(isPathInsideDir(root, "src", "src/不存在.ts"), false);
    assert.equal(isPathInsideDir(root, "不存在目录", "src/a.ts"), false);
  } finally {
    cleanup();
  }
});

test("目录包含：符号链接逃逸目录边界 → 不匹配（realpath 解析后判定）", () => {
  const { root, cleanup } = makeWorkspace({ "src/a.ts": "a", "lib/real.ts": "r" });
  try {
    // 目录 junction 在 Windows 无需提权（文件符号链接需要）；对 realpath 判定等价
    symlinkSync(join(root, "lib"), join(root, "src", "linkdir"), "junction");
    // linkdir 位于 src 内，但 realpath 解析后落在 lib → 其中的文件越出 grant 目录
    assert.equal(isPathInsideDir(root, "src", "src/linkdir/real.ts"), false);
    assert.equal(isPathInsideDir(root, "lib", "src/linkdir/real.ts"), true);
  } finally {
    cleanup();
  }
});
