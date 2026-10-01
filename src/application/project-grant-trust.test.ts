// 项目共享层的放行规则按内容确认（决策 341）：克隆来的仓库在 .pigeon/settings.json 里自带放行全部命令的规则
// （不写具体命令、带 shell 标记的 run_command），未确认前命令照常请示；确认后生效；规则内容一变重新请确认。
// pigeon run 遇未确认即报错退出，--trust-config 只放行本次；信任目录免检；用户级与项目个人层的放权不需确认。
// /reload 时新出现的项目规则随其他条目列出，skip 不生效、confirm 生效。用户级一律指到临时目录。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { withoutTrustEntries } from "../state/config-trust.ts";
import { newSessionId } from "../state/ids.ts";
import {
  configTrustPathOf,
  projectLocalSettingsPath,
  projectSettingsPath,
  userSettingsPath,
} from "../state/paths.ts";
import { configGrantRulesOf, type SettingsSnapshot } from "../state/settings.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";
import {
  ConfigNotConfirmedError,
  openSessionSettings,
  pendingTrustEntries,
  type TrustChoice,
} from "./session-settings.ts";
import { createSettingsReloader } from "./settings-reload.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function write(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

const PROMOTED = {
  grantId: "grant_01J5Z7K8W9ABCDEFGHJKMNPQRS",
  sessionId: "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS",
  firstCall: { toolCallId: "t0", args: {} },
  promotedAt: 1,
};

// 不写具体命令、允许经 shell 运行：放行全部命令
const RUN_ANYTHING = { tool: "run_command", shell: true, promotedFrom: PROMOTED };

// 需 shell 的命令（重定向）
const NODE = `"${process.execPath}"`;
const SHELL_COMMAND = `${NODE} -e "process.stdout.write('x')" > out.txt`;

function asker(choice: TrustChoice, seen: string[][]) {
  return {
    kind: "interactive" as const,
    ask: async (entries: readonly { kind: string; id: string; summary: string }[]) => {
      seen.push(entries.map((entry) => `${entry.kind}:${entry.summary}`));
      return choice;
    },
  };
}

// 按快照跑一轮 run_command，返回这一轮是否问了人与批准方
async function runOnce(root: string, home: string, settings: SettingsSnapshot) {
  const asked: ApprovalRequest[] = [];
  const bundle = buildRuntime({
    streamFn: createFakeStreamFn({
      replies: [
        { text: "跑", toolCalls: [{ name: "run_command", args: { command: SHELL_COMMAND } }] },
        { text: "好" },
      ],
    }),
    workspaceRoot: root,
    homeDir: home,
    settings,
    sessionId: newSessionId(),
    yolo: false,
    provider: "fake-provider",
    modelId: "fake-model-1",
    createApprovalHandler: () => async (request) => {
      asked.push(request);
      return { approved: true };
    },
  });
  try {
    const result = await bundle.adapter.run("跑一条命令");
    return {
      asked: asked.length,
      approvedBy: result.toolExecutions.at(-1)?.decision?.approvedBy,
    };
  } finally {
    await disposeRuntime(bundle);
  }
}

test("克隆来的仓库自带放行全部命令的规则：未确认前命令照常请示；确认后生效；规则内容一变重新请确认", async () => {
  const root = temp("pigeon-grant-trust-");
  const home = temp("pigeon-grant-trust-home-");
  write(projectSettingsPath(root), { permissions: { grants: [RUN_ANYTHING] } });
  // 启动时列出这条规则；本次不用：规则不生效，命令照常请示
  const seen: string[][] = [];
  const skipped = await openSessionSettings(root, {
    homeDir: home,
    confirmation: asker("skip", seen),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.length, 1);
  assert.match(seen[0]?.[0] ?? "", /^permission:.*"tool":"run_command"/);
  assert.match(seen[0]?.[0] ?? "", /"shell":true/);
  assert.deepEqual(configGrantRulesOf(skipped), []);
  assert.ok(!existsSync(configTrustPathOf(home)), "本次不用不记指纹");
  const before = await runOnce(root, home, skipped);
  assert.equal(before.asked, 1, "未确认前命令照常请示");
  assert.equal(before.approvedBy, "human");
  // 确认：记下指纹，规则生效，命令免审
  const trusted = await openSessionSettings(root, {
    homeDir: home,
    confirmation: asker("trust", seen),
  });
  assert.equal(seen.length, 2, "未确认的规则下次启动再列出");
  assert.equal(configGrantRulesOf(trusted).length, 1);
  const afterTrust = await runOnce(root, home, trusted);
  assert.equal(afterTrust.asked, 0, "确认后生效");
  assert.equal(afterTrust.approvedBy, "policy:config");
  // 同样内容不再问
  await openSessionSettings(root, { homeDir: home, confirmation: asker("quit", seen) });
  assert.equal(seen.length, 2);
  // 规则内容一变：重新请确认，确认前不生效
  write(projectSettingsPath(root), {
    permissions: { grants: [{ ...RUN_ANYTHING, promotedFrom: { ...PROMOTED, promotedAt: 2 } }] },
  });
  const changed = await openSessionSettings(root, {
    homeDir: home,
    confirmation: asker("skip", seen),
  });
  assert.equal(seen.length, 3, "内容变了重新请确认");
  assert.match(seen[2]?.[0] ?? "", /"promotedAt":2/);
  assert.deepEqual(configGrantRulesOf(changed), []);
});

test("用户级与项目个人层的放权不需确认、直接生效；项目共享层的同一条规则未确认时只去掉项目层那一条", async () => {
  const root = temp("pigeon-grant-trust-layers-");
  const home = temp("pigeon-grant-trust-home-");
  const local = { ...RUN_ANYTHING, command: "echo local" };
  const user = { ...RUN_ANYTHING, command: "echo user" };
  write(userSettingsPath(home), { permissions: { grants: [user] } });
  write(projectLocalSettingsPath(root), { permissions: { grants: [local, RUN_ANYTHING] } });
  const snapshot = loadSettings(root, { homeDir: home });
  assert.deepEqual(pendingTrustEntries(snapshot, home), [], "用户级与项目个人层不列出");
  // 项目共享层加一条（与项目个人层的一条内容相同）：只有它待确认；本次不用时用户级与项目个人层的照常生效
  write(projectSettingsPath(root), { permissions: { grants: [RUN_ANYTHING, RUN_ANYTHING] } });
  const withProject = loadSettings(root, { homeDir: home });
  const pending = pendingTrustEntries(withProject, home);
  assert.equal(pending.length, 1, "同样内容的两条规则只确认一次");
  const kept = withoutTrustEntries(withProject, pending);
  assert.deepEqual(
    kept.grants.map((entry) => [entry.layer, entry.rule.command]),
    [
      ["local", "echo local"],
      ["local", undefined],
      ["user", "echo user"],
    ]
  );
});

test("pigeon run：未确认的项目规则开跑前报错并列出；--trust-config 只放行本次；信任目录免检", async () => {
  const root = temp("pigeon-grant-trust-run-");
  const home = temp("pigeon-grant-trust-home-");
  write(projectSettingsPath(root), { permissions: { grants: [RUN_ANYTHING] } });
  await assert.rejects(
    openSessionSettings(root, {
      homeDir: home,
      confirmation: { kind: "unattended", trustConfig: false },
    }),
    (error: unknown) =>
      error instanceof ConfigNotConfirmedError &&
      /\[项目共享\] 放行规则 [0-9a-f]{12}：.*"tool":"run_command"/.test(error.message) &&
      /--trust-config/.test(error.message)
  );
  const once = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "unattended", trustConfig: true },
  });
  assert.equal(configGrantRulesOf(once).length, 1, "--trust-config 放行本次");
  assert.ok(!existsSync(configTrustPathOf(home)), "不记指纹");
  write(userSettingsPath(home), { trustedDirectories: [join(root, "..")] });
  const exempt = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "unattended", trustConfig: false },
  });
  assert.equal(configGrantRulesOf(exempt).length, 1, "信任目录免检");
});

test("/reload：新出现的项目规则随其他条目列出；确认前与 skip 后不生效，confirm 后生效并记下", async () => {
  const root = temp("pigeon-grant-trust-reload-");
  const home = temp("pigeon-grant-trust-home-");
  let settings = await openSessionSettings(root, {
    homeDir: home,
    confirmation: asker("trust", []),
  });
  const reload = createSettingsReloader({
    current: () => settings,
    homeDir: home,
    apply: async (snapshot) => {
      settings = snapshot;
    },
  });
  write(projectSettingsPath(root), {
    permissions: { grants: [RUN_ANYTHING] },
    commands: { commands: { t: "npm test" } },
  });
  const listed = (await reload([])).join("\n");
  assert.match(listed, /\[项目共享\] 放行规则 [0-9a-f]{12}：.*"tool":"run_command"/);
  assert.match(listed, /命令短名 t：npm test/);
  assert.deepEqual(configGrantRulesOf(settings), [], "确认之前不变");
  await reload(["skip"]);
  assert.deepEqual(configGrantRulesOf(settings), [], "不确认即不生效");
  assert.equal((await runOnce(root, home, settings)).asked, 1, "命令照常请示");
  await reload([]);
  const confirmed = (await reload(["confirm"])).join("\n");
  assert.match(confirmed, /改了 .*permissions/);
  assert.equal(configGrantRulesOf(settings).length, 1);
  assert.equal((await runOnce(root, home, settings)).approvedBy, "policy:config");
  assert.deepEqual(pendingTrustEntries(settings, home), [], "确认即记下指纹");
});
