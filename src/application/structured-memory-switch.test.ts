// 结构化记忆的开关与只读列出（决策 134 / 136）：启动参数 --no-structured-memory（只有 pigeon run 接受）压过项目配置
// .pigeon/structured-memory.json，两者都没有即开启；项目配置畸形响亮失败。pigeon memory list 只读列出条目
// （锚点、指纹、次数、来源会话与此刻的核验结果），不回写缓存。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { structuredMemoryCachePath } from "../memory/structured-store.ts";
import {
  StructuredMemoryConfigError,
  structuredMemoryConfigPath,
} from "../persistence/structured-memory-config.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { runHeadless } from "./headless.ts";
import { parseLaunchFlags, resolveStructuredMemoryEnabled } from "./launch-flags.ts";
import { listStructuredMemory, renderStructuredMemoryList } from "./structured-memory.ts";
import {
  edits,
  finished,
  makeMemoryRepo,
  memoryVerifyConfig,
} from "./structured-memory-fixtures.ts";

test("开关来源：启动参数 > 项目配置 > 开启；参数只有 pigeon run 接受；项目配置畸形响亮失败", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-memory-switch-"));
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  const run = (argv: string[]) => parseLaunchFlags(argv, { usage: "u", repair: true });
  assert.equal(resolveStructuredMemoryEnabled(run([]), root), true);
  assert.equal(resolveStructuredMemoryEnabled(run(["--no-structured-memory"]), root), false);
  writeFileSync(structuredMemoryConfigPath(root), JSON.stringify({ version: 1, enabled: false }));
  assert.equal(resolveStructuredMemoryEnabled(run([]), root), false);
  writeFileSync(structuredMemoryConfigPath(root), JSON.stringify({ version: 1, enabled: true }));
  assert.equal(resolveStructuredMemoryEnabled(run(["--no-structured-memory"]), root), false);
  assert.throws(
    () => parseLaunchFlags(["--no-structured-memory"], { usage: "u" }),
    /未知参数/,
    "REPL、TUI 与 eval 入口不接受"
  );
  for (const bad of [
    "{",
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 2, enabled: false }),
  ]) {
    writeFileSync(structuredMemoryConfigPath(root), bad);
    assert.throws(() => resolveStructuredMemoryEnabled(run([]), root), StructuredMemoryConfigError);
  }
});

test("只读列出：锚点、指纹、次数、来源会话与此刻的核验结果；不回写缓存", async () => {
  const repo = makeMemoryRepo({
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = helper;\n",
  });
  try {
    assert.equal(
      renderStructuredMemoryList(listStructuredMemory(repo.root)),
      "本项目还没有结构化记忆。\n"
    );
    const result = await runHeadless({
      task: "改 a.ts",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn: createFakeStreamFn({
        replies: [
          edits(
            ["src/a.ts", "= 1;", "= 2;"],
            ["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]
          ),
          finished(),
          edits(["src/b.ts", " // TYPE_BAD:helper", " // helper ok"]),
          finished("修好了"),
        ],
      }),
      yolo: true,
      homeDir: repo.home,
      verify: memoryVerifyConfig(["类型"]),
      repairRounds: 2,
    });
    const listing = listStructuredMemory(repo.root);
    assert.deepEqual(
      listing.map((item) => [item.anchor, item.kind, item.step, item.fingerprint, item.count]),
      [
        ["src/a.ts", "regression", "类型", "tsc TS2304 @ src/b.ts", 1],
        ["src/b.ts", "regression", "类型", "tsc TS2304 @ src/b.ts", 1],
      ]
    );
    for (const item of listing) {
      assert.deepEqual(item.sessions, [result.sessionId]);
      assert.deepEqual(item.names, ["helper"]);
      assert.deepEqual(item.check, { ok: true });
    }
    const text = renderStructuredMemoryList(listing);
    assert.ok(text.includes("锚点 src/a.ts") && text.includes(result.sessionId), text);
    assert.ok(text.includes("共 2 条"), text);
    assert.equal(existsSync(structuredMemoryCachePath(repo.root)), false, "只读列出不写缓存");
  } finally {
    repo.cleanup();
  }
});
