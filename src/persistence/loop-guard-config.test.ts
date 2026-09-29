// .pigeon/loop-guard.json 读取（决策 308）：缺失取缺省；关闭、改轮数、追加豁免照配置；畸形与轮数不递增响亮失败
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LoopGuardConfigError,
  loadLoopGuardConfig,
  loopGuardConfigPath,
} from "./loop-guard-config.ts";

function withRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pigeon-loop-guard-config-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("文件缺失取缺省：开着、5/10/20、只豁免等待 worker 的工具", () => {
  withRoot((root) => {
    assert.deepEqual(loadLoopGuardConfig(root), {
      enabled: true,
      remindAt: 5,
      warnAt: 10,
      stopAt: 20,
      exemptTools: ["wait_workers"],
    });
  });
});

test("关闭、改轮数、追加豁免照配置", () => {
  withRoot((root) => {
    writeFileSync(loopGuardConfigPath(root), JSON.stringify({ version: 1, enabled: false }));
    assert.equal(loadLoopGuardConfig(root).enabled, false);
    writeFileSync(
      loopGuardConfigPath(root),
      JSON.stringify({
        version: 1,
        remindAt: 3,
        warnAt: 6,
        stopAt: 9,
        exemptTools: ["mcp__ci__poll"],
      })
    );
    assert.deepEqual(loadLoopGuardConfig(root), {
      enabled: true,
      remindAt: 3,
      warnAt: 6,
      stopAt: 9,
      exemptTools: ["wait_workers", "mcp__ci__poll"],
    });
  });
});

test("畸形响亮失败：不是 JSON、版本不对、未知字段、轮数不是正整数、豁免不是字符串数组", () => {
  withRoot((root) => {
    writeFileSync(loopGuardConfigPath(root), "{ nope");
    assert.throws(() => loadLoopGuardConfig(root), LoopGuardConfigError);
    for (const bad of [
      { version: 2 },
      { version: 1, stopAfter: 20 },
      { version: 1, remindAt: 0 },
      { version: 1, stopAt: 2.5 },
      { version: 1, exemptTools: "wait_workers" },
      { version: 1, exemptTools: [""] },
      { version: 1, enabled: "no" },
    ]) {
      writeFileSync(loopGuardConfigPath(root), JSON.stringify(bad));
      assert.throws(() => loadLoopGuardConfig(root), LoopGuardConfigError, JSON.stringify(bad));
    }
  });
});

test("三个轮数不递增响亮失败（含与缺省值组合后不递增）", () => {
  withRoot((root) => {
    for (const bad of [
      { version: 1, remindAt: 10, warnAt: 5, stopAt: 20 },
      { version: 1, remindAt: 5, warnAt: 20, stopAt: 20 },
      { version: 1, stopAt: 8 },
    ]) {
      writeFileSync(loopGuardConfigPath(root), JSON.stringify(bad));
      assert.throws(() => loadLoopGuardConfig(root), /递增/, JSON.stringify(bad));
    }
  });
});
