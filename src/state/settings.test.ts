// 三层设置的纯判据（决策 325）：合并优先级（项目个人 > 项目共享 > 用户级；对象按键逐层合并，标量与数组整体替换）、
// permissions 三层并集、未知键报错（顶层与节内，指出文件、键与层）、$schema 不算未知、设置里写 key 报错并给出环境变量、
// trustedDirectories 只许写在用户级。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configGrantRulesOf,
  emptySettingsSnapshot,
  mergedSettingsProblems,
  mergeSettingsLayers,
  type SettingsFile,
  type SettingsLayer,
  type SettingsSnapshot,
  validateSettingsLayer,
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

test("permissions：放权规则三层并集生效（项目个人在前），各带所在层与层内序号", () => {
  const snapshot = snapshotOf({
    user: { permissions: { grants: [rule("grant_01J5Z7K8W9ABCDEFGHJKMNPQR1")] } },
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
