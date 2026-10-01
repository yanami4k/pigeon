// 路径模块（决策 325）：程序状态在 .pigeon/state/ 下、用户主目录可注入、快照与叠加只排除程序状态与个人设置、
// 旧会话记着的旧工作树位置按旧前缀映射到新前缀。
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  configTrustPathOf,
  isProgramOwnedPath,
  isUnderPigeonDir,
  mapLegacyWorktreePath,
  projectLocalSettingsPath,
  sessionsDirOf,
  userSettingsPath,
  worktreesDirOf,
} from "./paths.ts";

test("位置：程序状态在 .pigeon/state/ 下；用户级在注入的主目录下", () => {
  assert.equal(sessionsDirOf("/p"), join("/p", ".pigeon", "state", "sessions"));
  assert.equal(worktreesDirOf("/p"), join("/p", ".pigeon", "state", "worktrees"));
  assert.equal(projectLocalSettingsPath("/p"), join("/p", ".pigeon", "settings.local.json"));
  assert.equal(userSettingsPath("/h"), join("/h", ".pigeon", "settings.json"));
  assert.equal(configTrustPathOf("/h"), join("/h", ".pigeon", "state", "config-trust.json"));
});

test("快照与叠加排除的只是程序状态与个人设置；可提交的设置与技能不排除", () => {
  assert.equal(isProgramOwnedPath(".pigeon/state/sessions/a.jsonl"), true);
  assert.equal(isProgramOwnedPath(".pigeon/settings.local.json"), true);
  assert.equal(isProgramOwnedPath(".pigeon/settings.json"), false);
  assert.equal(isProgramOwnedPath(".pigeon/skills/x/SKILL.md"), false);
  assert.equal(isProgramOwnedPath(".pigeon/stateful.txt"), false);
  assert.equal(isUnderPigeonDir(".pigeon/settings.json"), true);
  assert.equal(isUnderPigeonDir(".pigeonx/a"), false);
  assert.equal(isUnderPigeonDir("src/.pigeon/x"), false);
});

test("旧工作树位置映射：旧前缀下的换到新前缀，其余原样", () => {
  assert.equal(
    mapLegacyWorktreePath("/p", join("/p", ".pigeon", "worktrees", "s-w1")),
    join("/p", ".pigeon", "state", "worktrees", "s-w1")
  );
  assert.equal(
    mapLegacyWorktreePath("/p", join("/p", ".pigeon", "state", "worktrees", "s-w1")),
    join("/p", ".pigeon", "state", "worktrees", "s-w1")
  );
  assert.equal(mapLegacyWorktreePath("/p", "/elsewhere/wt"), "/elsewhere/wt");
});
