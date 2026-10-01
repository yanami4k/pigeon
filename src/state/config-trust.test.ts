// 会执行命令的配置按内容确认（决策 326 ③）里的钩子一段：快照里每条钩子一条 kind:"hook" 条目
// （id 为「事件名:指纹前 12 位」、origin 为层标签、summary 含命令），同一内容（指纹相同）只列一条；
// withoutTrustEntries 按指纹整条去掉本次不用的钩子；revertTrustEntries 对钩子照「变化即不启用」处理
// （当前快照里没有同一条即不启用）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hookFingerprintOf,
  revertTrustEntries,
  type TrustEntry,
  trustEntriesOf,
  trustKeyOf,
  withoutTrustEntries,
} from "./config-trust.ts";
import type { LayeredHook } from "./hooks.ts";
import { emptySettingsSnapshot, type SettingsSnapshot, withHooksDisabled } from "./settings.ts";

function hook(overrides: Partial<LayeredHook> = {}): LayeredHook {
  return {
    event: "PreToolUse",
    command: "node guard.mjs",
    host: false,
    layer: "project",
    ...overrides,
  };
}

function snapshotWithHooks(hooks: readonly LayeredHook[]): SettingsSnapshot {
  return { ...emptySettingsSnapshot("/proj"), hooks };
}

function hookEntries(snapshot: SettingsSnapshot): TrustEntry[] {
  return trustEntriesOf({ snapshot }).filter((entry) => entry.kind === "hook");
}

const START = hook({ event: "SessionStart", command: "node start.mjs", layer: "user" });
const GUARD = hook({
  event: "PreToolUse",
  matcher: "edit_file",
  command: "node guard.mjs",
  layer: "local",
});

test("trustEntriesOf：每条钩子一条 kind:hook——id 含事件名与指纹前 12 位、origin 为层标签、summary 含命令", () => {
  const entries = hookEntries(snapshotWithHooks([START, GUARD]));
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.id, entry.origin, entry.fingerprint]),
    [
      [
        "hook",
        `SessionStart:${hookFingerprintOf(START).slice(0, 12)}`,
        "用户级",
        hookFingerprintOf(START),
      ],
      [
        "hook",
        `PreToolUse:${hookFingerprintOf(GUARD).slice(0, 12)}`,
        "项目个人",
        hookFingerprintOf(GUARD),
      ],
    ]
  );
  assert.equal(entries[0]?.summary, "事件 SessionStart：node start.mjs");
  assert.equal(entries[1]?.summary, "事件 PreToolUse、匹配 edit_file：node guard.mjs");
  // host:true 的钩子在摘要里标明执行位置
  const hosted = hookEntries(snapshotWithHooks([hook({ command: "node host.mjs", host: true })]));
  assert.equal(hosted[0]?.summary, "事件 PreToolUse：node host.mjs（在宿主执行）");
  // 指纹是内容指纹：命令一变即是另一条
  assert.notEqual(
    hookFingerprintOf(START),
    hookFingerprintOf(hook({ ...START, command: "node other.mjs" }))
  );
  // 钩子条目先进按内容确认，故空快照（无钩子）没有钩子条目
  assert.deepEqual(hookEntries(emptySettingsSnapshot("/proj")), []);
  // 停用全部钩子的快照不再列出钩子条目（清单已清空）
  assert.deepEqual(hookEntries(withHooksDisabled(snapshotWithHooks([START]))), []);
});

test("trustEntriesOf：同一内容（事件/matcher/命令/超时/执行位置全同）的钩子即使来自不同层也只列一条", () => {
  const userHook = hook({ layer: "user" });
  const projectHook = hook({ layer: "project" });
  // 指纹只算内容，不算层
  assert.equal(hookFingerprintOf(userHook), hookFingerprintOf(projectHook));
  const entries = hookEntries(snapshotWithHooks([userHook, projectHook]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.origin, "用户级");
  // 时间、执行位置、matcher 任一不同即另一条
  const variants = hookEntries(
    snapshotWithHooks([
      userHook,
      hook({ layer: "project", matcher: "edit_file" }),
      hook({ layer: "project", timeoutMs: 5000 }),
      hook({ layer: "project", host: true }),
    ])
  );
  assert.equal(variants.length, 4);
});

test("withoutTrustEntries：按指纹去掉本次不用的钩子，其余钩子保留并记进 excluded", () => {
  const snapshot = snapshotWithHooks([START, GUARD]);
  const startEntry = hookEntries(snapshot)[0];
  assert.ok(startEntry);
  const kept = withoutTrustEntries(snapshot, [startEntry]);
  assert.deepEqual(
    kept.hooks.map((entry) => entry.command),
    ["node guard.mjs"]
  );
  assert.ok(kept.excluded?.includes(trustKeyOf(startEntry)));
  assert.equal(kept.excluded?.length, 1);
  // 换成去掉守卫：只动守卫那一条
  const guardEntry = hookEntries(snapshot)[1];
  assert.ok(guardEntry);
  const keptGuard = withoutTrustEntries(snapshot, [guardEntry]);
  assert.deepEqual(
    keptGuard.hooks.map((entry) => entry.command),
    ["node start.mjs"]
  );
  // 空排除清单原样返回
  assert.equal(withoutTrustEntries(snapshot, []), snapshot);
});

test("revertTrustEntries：hook 条目按「变化即不启用」处理——从 hooks 去掉并记进 excluded", () => {
  // current 里没有这条钩子（新快照里才有）：不启用
  const current = snapshotWithHooks([]);
  const next = snapshotWithHooks([START, GUARD]);
  const startEntry = hookEntries(next)[0];
  assert.ok(startEntry);
  const reverted = revertTrustEntries(next, current, [startEntry]);
  assert.deepEqual(
    reverted.hooks.map((entry) => entry.command),
    ["node guard.mjs"]
  );
  assert.ok(reverted.excluded?.includes(trustKeyOf(startEntry)));
  // current 里逐字相同的一条也不算「沿用原内容」——钩子以内容为标识，本就在新快照里，
  // 只要进了未确认清单（内容与记录不同）就不启用
  const sameCurrent = snapshotWithHooks([START]);
  const revertedSame = revertTrustEntries(next, sameCurrent, [startEntry]);
  assert.deepEqual(
    revertedSame.hooks.map((entry) => entry.command),
    ["node guard.mjs"]
  );
});
