// .pigeon/commands.json 读取（M5.5 S5，决策 048）：缺失 = 空；合法载入；畸形 JSON、schema 不符、
// 短名不合法、未知角色、清单引用未登记短名一律响亮失败。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandsConfigError, commandsConfigPath, loadCommandsConfig } from "./commands-config.ts";

function withConfig(content: string | undefined, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pigeon-commands-"));
  try {
    if (content !== undefined) {
      mkdirSync(join(root, ".pigeon"), { recursive: true });
      writeFileSync(commandsConfigPath(root), content);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("commands 配置：缺失为空；合法文件载入短名与角色清单", () => {
  withConfig(undefined, (root) => {
    assert.deepEqual(loadCommandsConfig(root), { commands: {}, roles: {} });
  });
  withConfig(
    JSON.stringify({
      version: 1,
      commands: { test: "node --test", lint: "npx biome check ." },
      roles: { tester: ["test"] },
    }),
    (root) => {
      assert.deepEqual(loadCommandsConfig(root), {
        commands: { test: "node --test", lint: "npx biome check ." },
        roles: { tester: ["test"] },
      });
    }
  );
});

test("commands 配置：畸形与语义不明一律响亮失败", () => {
  for (const content of [
    "{ not json",
    JSON.stringify({ version: 2, commands: {} }),
    JSON.stringify({ version: 1, commands: { "Bad Name": "x" } }),
    JSON.stringify({ version: 1, commands: { test: "x" }, roles: { admin: ["test"] } }),
    JSON.stringify({ version: 1, commands: { test: "x" }, roles: { tester: ["ghost"] } }),
  ]) {
    withConfig(content, (root) => {
      assert.throws(() => loadCommandsConfig(root), CommandsConfigError, content);
    });
  }
});
