// 三层设置的纯判据（决策 325）：合并优先级（项目个人 > 项目共享 > 用户级；对象按键逐层合并，标量与数组整体替换）、
// permissions 三层并集、未知键报错（顶层与节内，指出文件、键与层）、$schema 不算未知、设置里写 key 报错并给出环境变量、
// trustedDirectories 只许写在用户级。
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  configGrantRulesOf,
  emptySettingsSnapshot,
  memoryLimitsOf,
  mergedSettingsProblems,
  mergeSettingsLayers,
  type SettingsFile,
  type SettingsLayer,
  type SettingsSnapshot,
  sessionSearchEnabledOf,
  validateSettingsLayer,
  withHooksDisabled,
} from "./settings.ts";

const FILES: Record<SettingsLayer, string> = {
  user: "~/.pigeon/settings.json",
  project: ".pigeon/settings.json",
  local: ".pigeon/settings.local.json",
};

function valid(layer: SettingsLayer, raw: unknown): SettingsFile {
  const checked = validateSettingsLayer(raw, { layer, file: FILES[layer] });
  assert.ok("file" in checked, JSON.stringify(checked));
  return checked.file;
}

function problemsOf(layer: SettingsLayer, raw: unknown): string[] {
  const checked = validateSettingsLayer(raw, { layer, file: FILES[layer] });
  assert.ok("problems" in checked, `应当报错：${JSON.stringify(raw)}`);
  return checked.problems;
}

function rule(grantId: string, tool = "edit_file") {
  return {
    tool,
    promotedFrom: {
      grantId,
      sessionId: "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS",
      firstCall: { toolCallId: "t1", args: {} },
      promotedAt: 1,
    },
  };
}

function snapshotOf(layers: Partial<Record<SettingsLayer, unknown>>): SettingsSnapshot {
  const ordered = (["user", "project", "local"] as const)
    .filter((layer) => layers[layer] !== undefined)
    .map((layer) => ({ layer, file: valid(layer, layers[layer]) }));
  const merged = mergeSettingsLayers(ordered);
  return { ...emptySettingsSnapshot("/p"), ...merged };
}

test("合并优先级：项目个人 > 项目共享 > 用户级；对象按键逐层合并，标量与数组由高优先层整体替换", () => {
  const { merged, sectionSources, commandSources } = snapshotOf({
    user: {
      orchestration: { maxConcurrent: 2, worker: { maxTurns: 10, wallClockMinutes: 5 } },
      loopGuard: { exemptTools: ["a", "b"], remindAt: 3 },
      commands: { commands: { test: "npm test", lint: "npm run lint" } },
      web: { search: { backend: "tavily", maxResults: 3 } },
    },
    project: {
      orchestration: { maxConcurrent: 4, worker: { maxTurns: 20 } },
      loopGuard: { exemptTools: ["c"] },
      commands: { commands: { test: "node --test" } },
    },
    local: {
      orchestration: { maxDepth: 2 },
      web: { search: { maxResults: 7 } },
    },
  });
  // 标量：高优先层替换；对象：按键合并（worker.wallClockMinutes 来自用户级，maxTurns 来自项目共享）
  assert.deepEqual(merged.orchestration, {
    maxConcurrent: 4,
    maxDepth: 2,
    worker: { maxTurns: 20, wallClockMinutes: 5 },
  });
  // 数组整体替换（不拼接）
  assert.deepEqual(merged.loopGuard, { exemptTools: ["c"], remindAt: 3 });
  assert.deepEqual(merged.commands?.commands, { test: "node --test", lint: "npm run lint" });
  assert.deepEqual(merged.web, { search: { backend: "tavily", maxResults: 7 } });
  assert.deepEqual(sectionSources.orchestration, ["user", "project", "local"]);
  assert.deepEqual(commandSources, { test: "project", lint: "user" });
});

test("permissions：放权规则三层并集生效（项目个人在前），各带所在层与层内序号；旧设置里的 readDeny 照常加载（决策 412）", () => {
  const snapshot = snapshotOf({
    user: {
      permissions: {
        grants: [rule("grant_01J5Z7K8W9ABCDEFGHJKMNPQR1")],
        readDeny: ["~/.config/gh", "/etc/ssl/private"],
      },
    },
    project: { permissions: { grants: [rule("grant_01J5Z7K8W9ABCDEFGHJKMNPQR2")] } },
    local: {
      permissions: {
        grants: [
          rule("grant_01J5Z7K8W9ABCDEFGHJKMNPQR3"),
          rule("grant_01J5Z7K8W9ABCDEFGHJKMNPQR4"),
        ],
      },
    },
  });
  assert.deepEqual(
    snapshot.grants.map((entry) => [entry.layer, entry.index, entry.rule.promotedFrom.grantId]),
    [
      ["local", 0, "grant_01J5Z7K8W9ABCDEFGHJKMNPQR3"],
      ["local", 1, "grant_01J5Z7K8W9ABCDEFGHJKMNPQR4"],
      ["project", 0, "grant_01J5Z7K8W9ABCDEFGHJKMNPQR2"],
      ["user", 0, "grant_01J5Z7K8W9ABCDEFGHJKMNPQR1"],
    ]
  );
  assert.equal(configGrantRulesOf(snapshot).length, 4);
});

test("未知键：顶层与节内都报错，指出文件、键与所在层；$schema 不算未知", () => {
  const top = problemsOf("project", { orchestrations: {} });
  assert.match(top.join("\n"), /\.pigeon\/settings\.json（项目共享）：未知键 orchestrations/);
  const inner = problemsOf("user", { loopGuard: { stopAtt: 3 } });
  assert.match(
    inner.join("\n"),
    /~\/\.pigeon\/settings\.json（用户级）：loopGuard 一节里的未知键 stopAtt/
  );
  const version = problemsOf("local", { commands: { version: 1, commands: {} } });
  assert.match(
    version.join("\n"),
    /settings\.local\.json（项目个人）：commands 一节里的未知键 version/
  );
  // 更深一层（schema 关闭了多余属性）同样报错
  assert.ok(problemsOf("project", { web: { fetch: { timeout: 1 } } }).length > 0);
  valid("project", { $schema: "https://example.invalid/schema.json", commands: { commands: {} } });
});

test("key 不进设置文件：web 一节里写了 apiKey 即报错并给出应设的环境变量", () => {
  const zai = problemsOf("local", { web: { search: { zai: { apiKey: "sk-x" } } } });
  assert.match(zai.join("\n"), /web\.search\.zai\.apiKey.*ZAI_API_KEY/);
  assert.ok(!zai.join("\n").includes("sk-x"), "报错不回显 key");
  const tavily = problemsOf("user", { web: { search: { tavily: { apiKey: "t" } } } });
  assert.match(tavily.join("\n"), /TAVILY_API_KEY/);
});

test("trustedDirectories 只能写在用户级：项目共享与项目个人写了即报错", () => {
  valid("user", { trustedDirectories: ["/work"] });
  for (const layer of ["project", "local"] as const) {
    assert.match(
      problemsOf(layer, { trustedDirectories: ["/work"] }).join("\n"),
      /trustedDirectories 只能写在用户级设置里/
    );
  }
  // 只接受绝对路径或 ~ 开头；相对路径报错
  valid("user", { trustedDirectories: ["~", "~/code"] });
  assert.match(
    problemsOf("user", { trustedDirectories: ["work"] }).join("\n"),
    /work 不是绝对路径/
  );
  assert.match(problemsOf("user", { trustedDirectories: ["./a"] }).join("\n"), /不是绝对路径/);
  const { merged } = snapshotOf({ user: { trustedDirectories: ["/work"] } });
  assert.deepEqual(merged.trustedDirectories, ["/work"]);
});

test("合并后的组合判据：角色引用了各层都没有的短名、轮数不递增、image 与 dockerfile 同给、MCP 语义不明一律列出", () => {
  const { merged } = snapshotOf({
    user: { sandbox: { image: "a" }, loopGuard: { remindAt: 15 } },
    project: {
      commands: { roles: { tester: ["test"] } },
      sandbox: { dockerfile: "Dockerfile" },
      mcp: { servers: { ghost: { defaultTier: "read" } } },
    },
  });
  const problems = mergedSettingsProblems(merged).join("\n");
  assert.match(problems, /角色 tester 引用了未登记的短名：test/);
  assert.match(problems, /轮数须递增/);
  assert.match(problems, /image 与 dockerfile 只能给一个/);
  assert.match(problems, /ghost 没有启动定义/);
  // 短名在用户级登记、角色在项目级引用：合并后成立
  const ok = snapshotOf({
    user: { commands: { commands: { test: "npm test" } } },
    project: { commands: { roles: { tester: ["test"] } } },
  });
  assert.deepEqual(mergedSettingsProblems(ok.merged), []);
});

// 决策 323 / 324：hooks 一节是并列合并的第二个例外——各层条目都生效（不去重事件或 matcher），
// 只有「同一事件、同一 matcher、命令完全相同」才只留一份（第一份为准）。
test("hooks：三层条目并列生效（各层各命中一条都保留）；同一事件同一 matcher 下命令完全相同的只留一份；sectionSources 记录各层", () => {
  const snapshot = snapshotOf({
    user: {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node start.mjs" }] }] },
    },
    project: {
      hooks: {
        // 与用户级逐字相同（事件、matcher 都缺省、命令相同）：合并后只留用户级那一份
        SessionStart: [{ hooks: [{ type: "command", command: "node start.mjs" }] }],
        PreToolUse: [
          { matcher: "edit_file", hooks: [{ type: "command", command: "node guard.mjs" }] },
        ],
      },
    },
    local: {
      hooks: {
        // 同事件、不同 matcher、不同命令：并列保留
        PreToolUse: [
          {
            matcher: "run_command",
            hooks: [{ type: "command", command: "node cmd-guard.mjs", host: true, timeout: 5 }],
          },
        ],
      },
    },
  });
  assert.deepEqual(
    snapshot.hooks.map((hook) => [hook.layer, hook.event, hook.matcher, hook.command, hook.host]),
    [
      ["user", "SessionStart", undefined, "node start.mjs", false],
      ["project", "PreToolUse", "edit_file", "node guard.mjs", false],
      ["local", "PreToolUse", "run_command", "node cmd-guard.mjs", true],
    ]
  );
  // timeout 是秒（照 Claude Code 的配置写法），进合并后换算成毫秒
  assert.equal(snapshot.hooks[2]?.timeoutMs, 5000);
  assert.deepEqual(snapshot.sectionSources.hooks, ["user", "project", "local"]);
  // 同一层内命令相同但 matcher 不同：不去重
  const sameLayer = snapshotOf({
    local: {
      hooks: {
        PreToolUse: [
          { matcher: "edit_file", hooks: [{ type: "command", command: "node same.mjs" }] },
          { matcher: "run_command", hooks: [{ type: "command", command: "node same.mjs" }] },
        ],
      },
    },
  });
  assert.equal(sameLayer.hooks.length, 2);
  // 键按字段序列化而非拼串：matcher "Bash"+命令 "x" 与 matcher "Bas"+命令 "hx" 是两条不同钩子（复审 P2）
  const collision = snapshotOf({
    local: {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "x" }] },
          { matcher: "Bas", hooks: [{ type: "command", command: "hx" }] },
        ],
      },
    },
  });
  assert.equal(collision.hooks.length, 2);
});

test("disableAllHooks 与 stopHookBlockCap：三层按标量覆盖（高优先层说了算），缺省分别 false 与 8", () => {
  // 只有低优先层给了 true：仍然生效
  const userOnly = snapshotOf({
    user: { disableAllHooks: true },
    project: { commands: { commands: { test: "npm test" } } },
  });
  assert.equal(userOnly.merged.disableAllHooks, true);
  assert.equal(userOnly.merged.stopHookBlockCap, 8);
  // 高优先层（项目个人）用 false 覆盖低优先层的 true
  const localWins = snapshotOf({
    user: { disableAllHooks: true, stopHookBlockCap: 20 },
    local: { disableAllHooks: false, stopHookBlockCap: 3 },
  });
  assert.equal(localWins.merged.disableAllHooks, false);
  assert.equal(localWins.merged.stopHookBlockCap, 3);
  // 项目共享高优先于用户级
  const projectWins = snapshotOf({
    user: { stopHookBlockCap: 20 },
    project: { stopHookBlockCap: 2 },
  });
  assert.equal(projectWins.merged.stopHookBlockCap, 2);
  assert.equal(projectWins.merged.disableAllHooks, false);
});

test("钩子校验：非法 matcher 报问题、未知事件名被拒；未知顶层键的可用清单里有 disableAllHooks 与 stopHookBlockCap", () => {
  // matcher 须是合法正则；点名事件与原文
  const badMatcher = problemsOf("project", {
    hooks: { PreToolUse: [{ matcher: "([", hooks: [{ type: "command", command: "node x.mjs" }] }] },
  });
  assert.match(badMatcher.join("\n"), /hooks\.PreToolUse：matcher 不是合法正则：\(\[/);
  // 缺省、空串与 "*" 都匹配全部，不算非法
  valid("local", {
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node x.mjs" }] }] },
  });
  // hooks 一节的键限 13 个事件名：写错事件名即被拒（按节内未知键报出）
  const badEvent = problemsOf("user", {
    hooks: { PreToolCall: [{ hooks: [{ type: "command", command: "node x.mjs" }] }] },
  });
  assert.match(badEvent.join("\n"), /hooks 一节里的未知键 PreToolCall/);
  // 未知顶层键的报错文案列出全部可用键（含两个钩子顶层开关）
  const unknownKey = problemsOf("project", { hookz: {} }).join("\n");
  assert.match(unknownKey, /未知键 hookz/);
  assert.match(unknownKey, /disableAllHooks/);
  assert.match(unknownKey, /stopHookBlockCap/);
  // 开关类型与取值范围由 schema 兜底
  assert.ok(problemsOf("local", { stopHookBlockCap: 0 }).length > 0);
  assert.ok(problemsOf("local", { disableAllHooks: "yes" }).length > 0);
});

test("withHooksDisabled：清单清空、disableAllHooks 置位，其余各节原样；不改原快照", () => {
  const snapshot = snapshotOf({
    project: {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "node stop.mjs" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node prompt.mjs" }] }],
      },
      commands: { commands: { test: "npm test" } },
      loopGuard: { remindAt: 4 },
      orchestration: { maxConcurrent: 3 },
    },
  });
  assert.equal(snapshot.hooks.length, 2);
  const off = withHooksDisabled(snapshot);
  assert.deepEqual(off.hooks, []);
  assert.equal(off.merged.disableAllHooks, true);
  // 其余各节逐字不变
  assert.equal(off.merged.stopHookBlockCap, snapshot.merged.stopHookBlockCap);
  assert.deepEqual(off.merged.commands, snapshot.merged.commands);
  assert.deepEqual(off.merged.loopGuard, snapshot.merged.loopGuard);
  assert.deepEqual(off.merged.orchestration, snapshot.merged.orchestration);
  assert.deepEqual(off.sectionSources, snapshot.sectionSources);
  assert.deepEqual(off.grants, snapshot.grants);
  assert.deepEqual(off.commandSources, snapshot.commandSources);
  assert.equal(off.root, snapshot.root);
  // 原快照不动（不改就地）
  assert.equal(snapshot.merged.disableAllHooks, false);
  assert.equal(snapshot.hooks.length, 2);
});
test("memory 一节（决策 332）：两层上限各自可设，未知键与非正整数报错；按键逐层合并，不给的取缺省 4,000", () => {
  const { merged } = snapshotOf({
    user: { memory: { projectLimitChars: 1000, userLimitChars: 2000 } },
    project: { memory: { projectLimitChars: 3000 } },
  });
  assert.deepEqual(merged.memory, { projectLimitChars: 3000, userLimitChars: 2000 });
  assert.deepEqual(
    memoryLimitsOf(
      snapshotOf({ user: { memory: { userLimitChars: 2000 } }, local: { memory: {} } })
    ),
    { project: 4000, user: 2000 }
  );
  assert.deepEqual(memoryLimitsOf(emptySettingsSnapshot("/p")), { project: 4000, user: 4000 });
  assert.match(
    problemsOf("project", { memory: { limitChars: 10 } }).join("\n"),
    /\.pigeon\/settings\.json（项目共享）：memory 一节里的未知键 limitChars/
  );
  assert.ok(problemsOf("user", { memory: { userLimitChars: 0 } }).length > 0);
  assert.ok(problemsOf("user", { memory: { projectLimitChars: 1.5 } }).length > 0);
});
test("sessionSearch 一节（决策 382）：enabled 缺省开，三层按标量覆盖，未知键报错", () => {
  assert.equal(sessionSearchEnabledOf(emptySettingsSnapshot("/p")), true);
  assert.equal(
    sessionSearchEnabledOf(snapshotOf({ user: { sessionSearch: { enabled: false } } })),
    false
  );
  assert.equal(
    sessionSearchEnabledOf(
      snapshotOf({
        user: { sessionSearch: { enabled: false } },
        project: { sessionSearch: { enabled: true } },
      })
    ),
    true
  );
  assert.match(
    problemsOf("project", { sessionSearch: { off: true } }).join("\n"),
    /\.pigeon\/settings\.json（项目共享）：sessionSearch 一节里的未知键 off/
  );
});
