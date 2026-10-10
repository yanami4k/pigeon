// 读档的路径解析（决策 355），本机执行端：按符号链接解析后的真实路径判工作区内外，grep、glob 的结果逐条分类；
// Windows 上 UNC、设备前缀与数据流的写法照解析后的真实路径判（决策 412）；辅助程序不从工作区里找。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "vitest";
import { createLocalWorkspaceHost, resolveHelperProgram } from "./local-host.ts";
import { WorkspacePathNotFoundError } from "./paths.ts";
import { classifyRealPath, containedIn } from "./read-paths.ts";
import { detectSearchBackend } from "./search-backend.ts";

function layout() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-read-paths-")));
  const ws = join(base, "ws");
  const lib = join(base, "lib");
  mkdirSync(ws);
  mkdirSync(lib);
  writeFileSync(join(ws, "a.txt"), "a");
  writeFileSync(join(lib, "dep.js"), "dep");
  // 工作区里的符号链接指向工作区外
  symlinkSync(lib, join(ws, "libs"), "junction");
  return { ws, lib, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("本机读档解析：按真实路径判工作区内外（绝对路径、..、经工作区里的链接）；grep、glob 的结果逐条分类", async () => {
  const { ws, lib, cleanup } = layout();
  try {
    const host = createLocalWorkspaceHost(ws);
    const dep = join(lib, "dep.js");
    assert.deepEqual(await host.resolveForRead?.("a.txt"), {
      path: join(ws, "a.txt"),
      outside: false,
    });
    for (const input of [dep, "../lib/dep.js", "libs/dep.js"]) {
      assert.deepEqual(await host.resolveForRead?.(input), { path: dep, outside: true }, input);
    }
    await assert.rejects(
      host.resolveForRead?.("missing.txt") ?? Promise.resolve(),
      WorkspacePathNotFoundError
    );
    const result = await host.classifyReadPaths?.(["a.txt", "libs/dep.js", "missing.txt"]);
    assert.equal(result?.incomplete, false);
    assert.deepEqual(Object.fromEntries(result?.classes ?? []), {
      "a.txt": "ok",
      "libs/dep.js": "outside",
    });
  } finally {
    cleanup();
  }
});

test("包含关系的口径：不分大小写的平台按不分大小写比较；Windows 口径下 UNC 写法的真实路径照常判内外", () => {
  const posix = { p: path.posix, insensitive: true };
  assert.equal(containedIn("/Work", "/work/a.txt", posix), true);
  assert.equal(containedIn("/Work", "/work/a.txt", { ...posix, insensitive: false }), false);
  const win = { p: path.win32, insensitive: true };
  assert.equal(classifyRealPath("\\\\srv\\share\\ws", "\\\\SRV\\Share\\WS\\b.ts", win), "ok");
  assert.equal(
    classifyRealPath("\\\\srv\\share\\ws", "\\\\srv\\share\\other\\a.ts", win),
    "outside"
  );
  assert.equal(
    classifyRealPath("C:\\ws", "\\\\localhost\\C$\\Users\\u\\.ssh\\id_rsa", win),
    "outside"
  );
});

const windowsOnly = process.platform === "win32" ? false : "只在 Windows 上有这些路径写法";

test.skipIf(windowsOnly)(
  "Windows：UNC、设备前缀与数据流的写法照解析后的真实路径判工作区内外——工作区外的标为工作区外，工作区在网络共享上时其内照常",
  async (t) => {
    const { ws, lib, cleanup } = layout();
    try {
      const dep = join(lib, "dep.js");
      const host = createLocalWorkspaceHost(ws);
      for (const input of [`\\\\?\\${dep}`, `\\\\.\\${dep}`, `//?/${dep}`, `${dep}::$DATA`]) {
        assert.deepEqual(await host.resolveForRead?.(input), { path: dep, outside: true }, input);
      }
      assert.equal((await host.resolveForRead?.(`\\\\?\\${join(ws, "a.txt")}`))?.outside, false);
      // 以本机管理共享 \\localhost\X$ 模拟网络共享；不可用时不测
      const toUnc = (local: string) => `\\\\localhost\\${local[0]}$${local.slice(2)}`;
      if (!existsSync(toUnc(ws))) {
        await t.annotate("本机管理共享不可用，UNC 几项未测");
        return;
      }
      assert.equal((await host.resolveForRead?.(toUnc(dep)))?.outside, true);
      const onShare = createLocalWorkspaceHost(toUnc(ws));
      assert.equal((await onShare.resolveForRead?.("a.txt"))?.outside, false);
      assert.equal((await onShare.resolveForRead?.(toUnc(dep)))?.outside, true);
      assert.equal((await onShare.resolveForRead?.(dep))?.outside, true);
    } finally {
      cleanup();
    }
  }
);

test.skipIf(windowsOnly)(
  "Windows：辅助程序按 PATH 解析成绝对路径，跳过相对目录与工作区之内的目录——工作区里放的同名 git.exe 不被执行",
  async (t) => {
    const { ws, cleanup } = layout();
    const originalPath = process.env.PATH;
    try {
      if (resolveHelperProgram("git", { PATH: originalPath ?? "" }, ws) === undefined) {
        t.skip("PATH 里没有 git");
        return;
      }
      spawnSync("git", ["init", "-q", ws], { windowsHide: true });
      // 工作区里放一个"git.exe"（系统的 where.exe 的副本：被误执行时认不出仓库），并把相对目录与工作区放到 PATH 最前
      copyFileSync(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
        join(ws, "git.exe")
      );
      process.env.PATH = `.;${ws};${originalPath ?? ""}`;
      const resolved = resolveHelperProgram("git", { PATH: process.env.PATH }, ws) ?? "";
      assert.ok(!containedIn(ws, resolved, { p: path.win32, insensitive: true }), resolved);
      const host = createLocalWorkspaceHost(ws);
      assert.equal((await detectSearchBackend(host, { only: "git" }))?.kind, "git");
    } finally {
      process.env.PATH = originalPath;
      cleanup();
    }
  }
);
