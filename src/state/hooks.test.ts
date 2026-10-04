// 钩子一节（决策 323 / 324）：schema 校验（未知事件名、非法 matcher、非正超时）、三层并列与同命令去重、
// matcher 匹配（正则、非锚定、*与缺省）、各事件的缺省超时（UserPromptSubmit 30 秒、SessionEnd 1.5 秒且单个最长 60 秒）。
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { test } from "vitest";
import {
  DEFAULT_STOP_HOOK_BLOCK_CAP,
  HooksSectionSchema,
  hookDefaultTimeoutMs,
  hookMatcherMatches,
  hooksForEvent,
  hooksOfLayer,
  hooksSectionProblems,
  hookTimeoutMs,
  type LayeredHook,
  mergeHookLayers,
  SESSION_END_HOOK_MAX_TIMEOUT_MS,
} from "./hooks.ts";

function layer(layerName: LayeredHook["layer"], hooks: Array<Partial<LayeredHook>>): LayeredHook[] {
  return hooks.map((hook) => ({
    event: hook.event ?? "PreToolUse",
    command: hook.command ?? "true",
    host: hook.host ?? false,
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
    ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
    layer: layerName,
  }));
}

test("schema：13 个事件名各自可选数组；未知事件名被拒", () => {
  assert.ok(
    Value.Check(HooksSectionSchema, { Stop: [{ hooks: [{ type: "command", command: "true" }] }] })
  );
  assert.ok(Value.Check(HooksSectionSchema, { SessionStart: [] }));
  assert.ok(
    !Value.Check(HooksSectionSchema, {
      NotAnEvent: [{ hooks: [{ type: "command", command: "x" }] }],
    })
  );
  // type 只认 command；command 不能为空；timeout 须正整数
  assert.ok(
    !Value.Check(HooksSectionSchema, { Stop: [{ hooks: [{ type: "http", command: "x" }] }] })
  );
  assert.ok(
    !Value.Check(HooksSectionSchema, { Stop: [{ hooks: [{ type: "command", command: "" }] }] })
  );
  assert.ok(
    !Value.Check(HooksSectionSchema, {
      Stop: [{ hooks: [{ type: "command", command: "x", timeout: 0 }] }],
    })
  );
});

test("matcher 须是合法正则：非法即报问题，合法与缺省通过", () => {
  assert.deepEqual(
    hooksSectionProblems({ Stop: [{ hooks: [{ type: "command", command: "x" }] }] }),
    []
  );
  assert.deepEqual(
    hooksSectionProblems({
      PreToolUse: [{ matcher: "^edit_file$", hooks: [{ type: "command", command: "x" }] }],
    }),
    []
  );
  const problems = hooksSectionProblems({
    PreToolUse: [{ matcher: "[", hooks: [{ type: "command", command: "x" }] }],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /不是合法正则/);
});

test("一层展开：matcher 组与钩子都并进扁平清单，超时按秒换算", () => {
  const flat = hooksOfLayer(
    {
      PreToolUse: [
        { matcher: "edit_file", hooks: [{ type: "command", command: "a", timeout: 5 }] },
        { hooks: [{ type: "command", command: "b" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "c", host: true }] }],
    },
    "project"
  );
  assert.deepEqual(flat, [
    {
      event: "PreToolUse",
      matcher: "edit_file",
      command: "a",
      timeoutMs: 5000,
      host: false,
      layer: "project",
    },
    { event: "PreToolUse", command: "b", host: false, layer: "project" },
    { event: "Stop", command: "c", host: true, layer: "project" },
  ]);
});

test("三层合并：条目并列生效；同一事件同一 matcher 下命令完全相同的只留一份（先出现者留）", () => {
  const merged = mergeHookLayers([
    layer("user", [{ command: "shared" }, { command: "user-only", event: "Stop" }]),
    layer("project", [{ command: "shared" }]),
    layer("local", [{ command: "shared", matcher: "edit_file" }, { command: "shared" }]),
  ]);
  assert.deepEqual(
    merged.map((hook) => `${hook.layer}:${hook.matcher ?? "-"}:${hook.command}`),
    ["user:-:shared", "user:-:user-only", "local:edit_file:shared"]
  );
});

test("matcher：缺省、空串与 * 匹配全部；其余按正则非锚定匹配", () => {
  assert.ok(hookMatcherMatches(undefined, "edit_file"));
  assert.ok(hookMatcherMatches("", "edit_file"));
  assert.ok(hookMatcherMatches("*", "edit_file"));
  assert.ok(hookMatcherMatches("edit", "edit_file"));
  assert.ok(hookMatcherMatches("^edit_file$", "edit_file"));
  assert.ok(!hookMatcherMatches("^edit_file$", "read_file"));
  assert.ok(!hookMatcherMatches("[", "edit_file"));
});

test("命中筛选：按事件与 matcher 过滤", () => {
  const hooks = layer("user", [
    { command: "a", matcher: "edit" },
    { command: "b", matcher: "read" },
    { command: "c", event: "Stop" },
  ]);
  assert.deepEqual(
    hooksForEvent(hooks, "PreToolUse", "edit_file").map((h) => h.command),
    ["a"]
  );
  assert.deepEqual(
    hooksForEvent(hooks, "Stop", "x").map((h) => h.command),
    ["c"]
  );
});

function first(hooks: LayeredHook[]): LayeredHook {
  const hook = hooks[0];
  assert.ok(hook !== undefined);
  return hook;
}

test("缺省超时：UserPromptSubmit 30 秒、SessionEnd 1.5 秒（每个钩子可提高、最长 60 秒）、其余 600 秒", () => {
  assert.equal(hookDefaultTimeoutMs("UserPromptSubmit"), 30_000);
  assert.equal(hookDefaultTimeoutMs("SessionEnd"), 1_500);
  assert.equal(hookDefaultTimeoutMs("Stop"), 600_000);
  assert.equal(hookTimeoutMs("SessionEnd", first(layer("user", [{}]))), 1_500);
  assert.equal(hookTimeoutMs("SessionEnd", first(layer("user", [{ timeoutMs: 5_000 }]))), 5_000);
  assert.equal(
    hookTimeoutMs("SessionEnd", first(layer("user", [{ timeoutMs: 120_000 }]))),
    SESSION_END_HOOK_MAX_TIMEOUT_MS
  );
  assert.equal(hookTimeoutMs("Stop", first(layer("user", [{ timeoutMs: 5_000 }]))), 5_000);
});

test("收尾钩子连续拦截上限缺省 8", () => {
  assert.equal(DEFAULT_STOP_HOOK_BLOCK_CAP, 8);
});
