// 验证命令来源优先级（M8 S1，决策 081）：启动参数 > 项目配置 > 未配置（标未知）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VERIFY_CONFIG_VERSION } from "../state/attempt-config.ts";
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  parseLaunchFlags,
  resolveVerifyConfig,
} from "./launch-flags.ts";

function rootWithConfig(body?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-verify-priority-"));
  mkdirSync(join(dir, ".pigeon"), { recursive: true });
  if (body !== undefined) {
    writeFileSync(join(dir, ".pigeon", "verify.json"), JSON.stringify(body), "utf8");
  }
  return dir;
}

const flagsOf = (argv: string[]) => parseLaunchFlags(argv, { usage: "u", verify: true });

test("验证命令来源：未配置时为未配置（回执与标签据此标未知）", () => {
  assert.equal(resolveVerifyConfig(flagsOf([]), rootWithConfig()), undefined);
});

test("验证命令来源：只有项目配置时继承项目配置", () => {
  const dir = rootWithConfig({ version: VERIFY_CONFIG_VERSION, command: "npm test" });
  assert.deepEqual(resolveVerifyConfig(flagsOf([]), dir), {
    command: "npm test",
    timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    source: "project",
  });
});

test("验证命令来源：启动参数压过项目配置，超时也随启动参数", () => {
  const dir = rootWithConfig({
    version: VERIFY_CONFIG_VERSION,
    command: "npm test",
    timeoutMs: 1000,
  });
  assert.deepEqual(
    resolveVerifyConfig(flagsOf(["--verify-command", "npm run verify"]), dir),
    { command: "npm run verify", timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS, source: "flag" },
    "启动参数在场时整条配置取启动参数，不与项目配置逐字段混合"
  );
  assert.deepEqual(
    resolveVerifyConfig(flagsOf(["--verify-command", "x", "--verify-timeout", "7"]), dir),
    { command: "x", timeoutMs: 7, source: "flag" }
  );
});
