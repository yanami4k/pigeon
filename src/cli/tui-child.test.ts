// 终端界面子进程由入口决定（决策 351）：从源码启动的跑源码的 tui 入口；从打包产物启动的跑同一个产物，开 source map，经环境
// 变量分派到终端界面。另：pigeon --version 走版本分支。
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { BUNDLE_ROLE_ENV } from "../state/package-paths.ts";
import { routeTopLevel, tuiChildCommand } from "./index.ts";

const pkg = resolve("/pkg");

test("源码启动：子进程跑源码的 tui 入口，带上本进程的 node 参数与界面参数，不加环境变量", () => {
  const command = tuiChildCommand(
    false,
    pathToFileURL(join(pkg, "src", "cli", "index.ts")).href,
    ["--inspect"],
    ["--continue"]
  );
  assert.deepEqual(command, {
    args: ["--inspect", join(pkg, "src", "tui", "main.ts"), "--continue"],
  });
});

test("打包产物启动：子进程跑同一个产物、开 source map，经环境变量分派到终端界面", () => {
  const bundle = join(pkg, "dist", "pigeon-cli.mjs");
  const command = tuiChildCommand(true, pathToFileURL(bundle).href, [], ["--resume", "s1"]);
  assert.deepEqual(command, {
    args: ["--enable-source-maps", bundle, "--resume", "s1"],
    env: { [BUNDLE_ROLE_ENV]: "tui" },
  });
});

test("pigeon --version 走版本分支", () => {
  assert.deepEqual(routeTopLevel(["--version"]), { kind: "version" });
});
