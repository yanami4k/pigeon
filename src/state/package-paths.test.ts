// 随包文件的位置与打包产物入口的分派（决策 351）。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_ROLE_ENV,
  FROM_BUNDLE,
  packageFileUrl,
  packageRootUrl,
  takeBundleRole,
} from "./package-paths.ts";

test("包根：源码运行时为 src 的上一层（随包文件在那里），打包产物运行时为产物所在目录的上一层", () => {
  assert.equal(FROM_BUNDLE, false);
  assert.ok(existsSync(fileURLToPath(packageFileUrl("docker/sandbox/Dockerfile"))));
  assert.ok(existsSync(fileURLToPath(packageFileUrl("docker/script/executor.cjs"))));
  const root = packageRootUrl(false, import.meta.url);
  assert.equal(packageRootUrl(true, new URL("dist/pigeon-cli.mjs", root).href).href, root.href);
});

test("产物入口取角色：tui 即终端界面，其余为命令行；取后从环境变量里删去", () => {
  const env: Record<string, string | undefined> = { [BUNDLE_ROLE_ENV]: "tui", KEEP: "1" };
  assert.equal(takeBundleRole(env), "tui");
  assert.deepEqual(env, { KEEP: "1" });
  assert.equal(takeBundleRole(env), "cli");
  assert.equal(takeBundleRole({ [BUNDLE_ROLE_ENV]: "other" }), "cli");
});
