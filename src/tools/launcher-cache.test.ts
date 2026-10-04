// Windows 程序查找的缓存（决策 352）：按查找方式、PATH 与程序名缓存，会话内有效——找到的脚本被删即重查；没找到的结果
// 缓存着，命令报"程序不存在"时作废；换了 PATH 另查；新会话（新的执行端）不沿用
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createLocalWorkspaceHost } from "./local-host.ts";

test("程序查找缓存：找到的被删即重查；没找到的缓存到作废为止；PATH 不同另查；新执行端不沿用", () => {
  const dirs = Array.from({ length: 3 }, () => mkdtempSync(join(tmpdir(), "pigeon-launcher-")));
  const [root = "", binA = "", binB = ""] = dirs;
  try {
    const host = createLocalWorkspaceHost(root, { platform: "win32" });
    const script = join(binA, "tool.cmd");
    writeFileSync(script, "");
    assert.equal(host.findLauncherScript("tool", { PATH: binA }), script);
    rmSync(script);
    assert.equal(host.findLauncherScript("tool", { PATH: binA }), undefined);
    writeFileSync(script, "");
    assert.equal(host.findLauncherScript("tool", { PATH: binA }), undefined, "没找到的结果缓存着");
    host.forgetLauncherScript?.("tool");
    assert.equal(host.findLauncherScript("tool", { PATH: binA }), script);
    writeFileSync(join(binB, "tool.cmd"), "");
    assert.equal(host.findLauncherScript("tool", { PATH: binB }), join(binB, "tool.cmd"));
    rmSync(join(binB, "tool.cmd"));
    assert.equal(
      createLocalWorkspaceHost(root, { platform: "win32" }).findLauncherScript("tool", {
        PATH: binB,
      }),
      undefined
    );
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
