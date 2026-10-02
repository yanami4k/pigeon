// 会话级钩子调度（决策 323 / 324）：协议解释（退出码 0/2/其他、JSON 输出各字段）、结论汇合
// （拒绝 > 要人确认 > 放行、continue:false、上下文收集）、运行记录（pigeon.hook）、提示、执行位置选择
// （沙箱经执行端、host:true 在宿主）、并行与 matcher 过滤、disableAllHooks。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookCommandInput, HookCommandOutcome } from "../execution/hook-runner.ts";
import type { LayeredHook } from "../state/hooks.ts";
import { type SessionCustomEntry, SessionEntryType } from "../state/session-entries.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { interpretHookRun, SessionHooks } from "./hooks.ts";

const SESSION = "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS" as never;

function hook(overrides: Partial<LayeredHook> = {}): LayeredHook {
  return {
    event: "PreToolUse",
    command: "check.sh",
    host: false,
    layer: "user",
    ...overrides,
  };
}

function outcome(overrides: Partial<HookCommandOutcome> = {}): HookCommandOutcome {
  return {
    spawned: true,
    exitCode: 0,
    timedOut: false,
    durationMs: 5,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

interface Harness {
  hooks: SessionHooks;
  records: SessionCustomEntry[];
  notices: string[];
  inputs: HookCommandInput[];
  viaHost: HookCommandInput[];
}

function harness(
  hooks: readonly LayeredHook[],
  opts: {
    script?: (input: HookCommandInput) => HookCommandOutcome | Promise<HookCommandOutcome>;
    disableAllHooks?: boolean;
    workspaceHost?: WorkspaceHost;
    activeRunId?: () => string | undefined;
    permissionMode?: string;
  } = {}
): Harness {
  const records: SessionCustomEntry[] = [];
  const notices: string[] = [];
  const inputs: HookCommandInput[] = [];
  const viaHost: HookCommandInput[] = [];
  const runner = async (input: HookCommandInput): Promise<HookCommandOutcome> => {
    inputs.push(input);
    return opts.script?.(input) ?? outcome();
  };
  const viaRunner = async (
    _host: WorkspaceHost,
    input: HookCommandInput
  ): Promise<HookCommandOutcome> => {
    viaHost.push(input);
    return opts.script?.(input) ?? outcome();
  };
  const sessionHooks = new SessionHooks({
    sessionId: SESSION,
    governanceRoot: "D:/proj",
    workspaceRoot: "D:/proj",
    platform: "linux",
    hooks,
    disableAllHooks: opts.disableAllHooks === true,
    sink: { append: (entry) => records.push(entry) },
    notice: (line) => notices.push(line),
    runLocal: runner,
    runViaHost: viaRunner,
    ...(opts.workspaceHost !== undefined ? { workspaceHost: opts.workspaceHost } : {}),
    ...(opts.activeRunId !== undefined ? { activeRunId: opts.activeRunId } : {}),
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    env: {},
  });
  return { hooks: sessionHooks, records, notices, inputs, viaHost };
}

const EDIT_FIELDS = { tool_name: "edit_file", tool_input: { path: "a.ts" }, tool_use_id: "tc-1" };
const PATH_TARGET = "edit_file";

test("事件信息以 JSON 经标准输入交给命令：公共字段 + 事件字段 + PIGEON_PROJECT_DIR 与 permission_mode", async () => {
  const h = harness([hook()], { permissionMode: "prompt" });
  await h.hooks.runEvent("PreToolUse", PATH_TARGET, EDIT_FIELDS);
  assert.equal(h.inputs.length, 1);
  const parsed = JSON.parse(h.inputs[0]?.stdin ?? "") as Record<string, unknown>;
  assert.equal(parsed.session_id, SESSION);
  assert.equal(parsed.hook_event_name, "PreToolUse");
  assert.equal(parsed.tool_name, "edit_file");
  assert.equal(parsed.cwd, "D:/proj");
  assert.equal(parsed.permission_mode, "prompt");
  assert.deepEqual(parsed.tool_input, { path: "a.ts" });
  assert.equal(h.inputs[0]?.env?.PIGEON_PROJECT_DIR, "D:/proj");
  // 没有命中的事件不执行
  const empty = await h.hooks.runEvent("Stop", "x", {});
  assert.equal(empty.ran, false);
  assert.equal(h.inputs.length, 1);
});

test("disableAllHooks：全部不执行，list 为空", async () => {
  const h = harness([hook()], { disableAllHooks: true });
  const report = await h.hooks.runEvent("PreToolUse", PATH_TARGET, EDIT_FIELDS);
  assert.equal(report.ran, false);
  assert.equal(h.inputs.length, 0);
  assert.deepEqual(h.hooks.list(), []);
  assert.ok(h.hooks.disabled);
});

test("退出码 2：PreToolUse 记拒绝（标准错误为理由）；Stop 记拦截；都进 blocked 汇合", async () => {
  const deny = harness([hook()], {
    script: () => outcome({ exitCode: 2, stderr: "参数里不许带 rm" }),
  });
  const report = await deny.hooks.runEvent("PreToolUse", PATH_TARGET, EDIT_FIELDS);
  assert.deepEqual(report.blocked, { reason: "参数里不许带 rm" });
  assert.equal(report.runs[0]?.conclusion, "deny");
  assert.deepEqual(deny.notices, ["钩子拦下（PreToolUse）：参数里不许带 rm"]);

  const stop = harness([hook({ event: "Stop", command: "gate.sh" })], {
    script: () => outcome({ exitCode: 2, stderr: "测试没过" }),
  });
  const stopReport = await stop.hooks.runEvent("Stop", "", { stop_hook_active: false });
  assert.deepEqual(stopReport.blocked, { reason: "测试没过" });
  assert.equal(stopReport.runs[0]?.conclusion, "block");
});

test("其他退出码（含超时与拉不起来）：钩子自身出错，不拦只提示", async () => {
  const h = harness([hook()], { script: () => outcome({ exitCode: 1, stderr: "boom" }) });
  const report = await h.hooks.runEvent("PreToolUse", PATH_TARGET, EDIT_FIELDS);
  assert.equal(report.blocked, undefined);
  assert.equal(report.runs[0]?.conclusion, "error");
  assert.match(h.notices[0] ?? "", /钩子出错/);

  const timedOut = harness([hook()], { script: () => outcome({ exitCode: null, timedOut: true }) });
  const timedReport = await timedOut.hooks.runEvent("PreToolUse", PATH_TARGET, EDIT_FIELDS);
  assert.equal(timedReport.blocked, undefined);
  assert.match(timedReport.runs[0]?.reason ?? "", /超时/);
});

test("PreToolUse 的 JSON 决策：allow / ask / deny 与理由；updatedInput 透传", async () => {
  const allow = harness([hook()], {
    script: () =>
      outcome({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { path: "b.ts" },
            additionalContext: "在受保护目录里",
          },
        }),
      }),
  });
  const allowReport = await allow.hooks.runEvent("PreToolUse", PATH_TARGET, EDIT_FIELDS);
  assert.equal(allowReport.allow, true);
  assert.equal(allowReport.blocked, undefined);
  assert.equal(allowReport.runs[0]?.conclusion, "allow");
  assert.deepEqual(allowReport.updatedInput, { path: "b.ts" });
  assert.deepEqual(allowReport.additionalContext, ["在受保护目录里"]);

  const ask = harness([hook()], {
    script: () =>
      outcome({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: "这条命令动到生产库",
          },
        }),
      }),
  });
  const askReport = await ask.hooks.runEvent("PreToolUse", PATH_TARGET, EDIT_FIELDS);
  assert.deepEqual(askReport.ask, { reason: "这条命令动到生产库" });
  assert.equal(askReport.allow, undefined);
});

test("多个钩子的结论合并：拒绝 > 要人确认 > 放行", async () => {
  const make = (decision: string) => hook({ command: `h-${decision}.sh` });
  const h = harness([make("allow"), make("ask"), make("deny")], {
    script: (input) => {
      const decision = /h-(\w+)\.sh/.exec(input.command)?.[1] ?? "allow";
      return outcome({
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision },
        }),
      });
    },
  });
  const report = await h.hooks.runEvent("PreToolUse", PATH_TARGET, EDIT_FIELDS);
  assert.equal(report.runs.length, 3);
  assert.ok(report.blocked !== undefined, "拒绝压过其余");
  assert.equal(report.allow, undefined);
  assert.equal(report.ask, undefined);
});

test("continue:false 与 stopReason 汇合；systemMessage 收集", async () => {
  const h = harness([hook({ event: "UserPromptSubmit" })], {
    script: () =>
      outcome({
        stdout: JSON.stringify({
          continue: false,
          stopReason: "构建挂了，修完再来",
          systemMessage: "注意：构建挂了",
        }),
      }),
  });
  const report = await h.hooks.runEvent("UserPromptSubmit", "", { prompt: "继续" });
  assert.deepEqual(report.continueFalse, { stopReason: "构建挂了，修完再来" });
  assert.deepEqual(report.systemMessages, ["注意：构建挂了"]);
});

test("PostToolUse 的 updatedToolOutput 透传（决策：替换工具结果）", async () => {
  const h = harness([hook({ event: "PostToolUse" })], {
    script: () =>
      outcome({
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "[redacted]" },
        }),
      }),
  });
  const report = await h.hooks.runEvent("PostToolUse", "read_file", {
    tool_name: "read_file",
    tool_input: {},
    tool_response: "secret",
  });
  assert.equal(report.updatedToolOutput, "[redacted]");
});

test("纯文本 stdout：SessionStart 与 UserPromptSubmit 当上下文；其余事件不进上下文", async () => {
  const h = harness([hook({ event: "SessionStart" })], {
    script: () => outcome({ stdout: "当前分支 main\n有未提交改动" }),
  });
  const report = await h.hooks.runEvent("SessionStart", "startup", { source: "startup" });
  assert.deepEqual(report.additionalContext, ["当前分支 main\n有未提交改动"]);

  const other = harness([hook({ event: "Stop" })], {
    script: () => outcome({ stdout: "只是日志" }),
  });
  const stopReport = await other.hooks.runEvent("Stop", "", {});
  assert.deepEqual(stopReport.additionalContext, []);
});

test("运行记录：每次运行写 pigeon.hook 条目（事件、命令、退出码、用时、结论、输出摘要），带活动 Run", async () => {
  const h = harness([hook({ matcher: "edit" })], {
    script: () => outcome({ exitCode: 2, stderr: "拦下了", durationMs: 42 }),
    activeRunId: () => "run_01J5Z7K8W9ABCDEFGHJKMNPQRS",
  });
  await h.hooks.runEvent("PreToolUse", PATH_TARGET, EDIT_FIELDS);
  assert.equal(h.records.length, 1);
  const entry = h.records[0];
  assert.equal(entry?.customType, SessionEntryType.Hook);
  const data = entry?.data as Record<string, unknown>;
  assert.equal(data.event, "PreToolUse");
  assert.equal(data.command, "check.sh");
  assert.equal(data.matcher, "edit");
  assert.equal(data.exitCode, 2);
  assert.equal(data.durationMs, 42);
  assert.equal(data.conclusion, "deny");
  assert.equal(data.output, "拦下了");
  assert.equal(data.runId, "run_01J5Z7K8W9ABCDEFGHJKMNPQRS");
});

test("执行位置：沙箱会话经执行端；host:true 的在宿主执行", async () => {
  const fakeHost = {} as WorkspaceHost;
  const h = harness([hook(), hook({ command: "host.sh", host: true })], {
    workspaceHost: fakeHost,
  });
  await h.hooks.runEvent("PreToolUse", PATH_TARGET, EDIT_FIELDS);
  assert.deepEqual(
    h.viaHost.map((input) => input.command),
    ["check.sh"]
  );
  assert.deepEqual(
    h.inputs.map((input) => input.command),
    ["host.sh"]
  );
});

test("同一命令在一次事件里只跑一次：不同 matcher 的两层都命中时按命令（与执行位置）去重（复审 P2）", async () => {
  const h = harness(
    [
      hook({ matcher: "read_file", command: "check.sh", layer: "user" }),
      hook({ matcher: "read", command: "check.sh", layer: "project" }),
      // 执行位置不同（host:true）是另一条：不去重
      hook({ matcher: "read_file", command: "check.sh", host: true, layer: "project" }),
    ],
    { workspaceHost: {} as WorkspaceHost }
  );
  await h.hooks.runEvent("PreToolUse", "read_file", EDIT_FIELDS);
  assert.deepEqual(
    h.viaHost.map((input) => input.command),
    ["check.sh"],
    "同命令同执行位置只跑一次（第一份为准）"
  );
  assert.deepEqual(
    h.inputs.map((input) => input.command),
    ["check.sh"],
    "host:true 是另一执行位置，照常跑"
  );
});

test("interpretHookRun 直测：0 + 无输出记 pass；0 + additionalContext 记 context", () => {
  const pass = interpretHookRun("Stop", hook(), outcome());
  assert.equal(pass.conclusion, "pass");
  const context = interpretHookRun(
    "PostToolUse",
    hook(),
    outcome({
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "下次先跑测试" },
      }),
    })
  );
  assert.equal(context.conclusion, "context");
  assert.equal(context.additionalContext, "下次先跑测试");
});
