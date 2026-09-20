// 验证命令项目级配置（M8 S1，决策 081）：文件缺失 = 未配置；畸形一律响亮失败。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_VERIFY_TIMEOUT_MS } from "../application/launch-flags.ts";
import { VERIFY_CONFIG_VERSION } from "../state/attempt-config.ts";
import { loadVerifyConfig, VerifyConfigError, verifyConfigPath } from "./verify-config.ts";

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-verify-config-"));
  mkdirSync(join(dir, ".pigeon"), { recursive: true });
  return dir;
}

function write(dir: string, body: unknown): void {
  writeFileSync(verifyConfigPath(dir), JSON.stringify(body), "utf8");
}

test("验证配置：文件缺失即未配置", () => {
  assert.equal(loadVerifyConfig(root()), undefined);
});

test("验证配置：读出命令与超时，未给超时时取缺省", () => {
  const dir = root();
  write(dir, { version: VERIFY_CONFIG_VERSION, command: "npm test" });
  assert.deepEqual(loadVerifyConfig(dir), {
    command: "npm test",
    timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    source: "project",
  });
  write(dir, { version: VERIFY_CONFIG_VERSION, command: "npm run verify", timeoutMs: 1000 });
  assert.deepEqual(loadVerifyConfig(dir), {
    command: "npm run verify",
    timeoutMs: 1000,
    source: "project",
  });
});

test("验证配置：不是合法 JSON、schema 不符、命令为空都响亮失败", () => {
  const dir = root();
  writeFileSync(verifyConfigPath(dir), "{", "utf8");
  assert.throws(() => loadVerifyConfig(dir), VerifyConfigError);
  write(dir, { version: 99, command: "npm test" });
  assert.throws(() => loadVerifyConfig(dir), VerifyConfigError);
  write(dir, { version: VERIFY_CONFIG_VERSION, command: "   " });
  assert.throws(() => loadVerifyConfig(dir), VerifyConfigError);
});
