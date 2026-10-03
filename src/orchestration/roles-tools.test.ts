// 派 worker 时的工具清单与作用范围（决策 360）：清单只能取派出方能交出的工具（主会话专用的、deny 的、没有的一律拒绝），
// 不给即按角色预设；范围须是 worker 有的工具、种类对得上、路径相对工作树根且不含 .. 或绝对路径、命令前缀不含 shell 语法；
// 嵌套派出时只能比派出方更窄，没另给即沿用。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolScope } from "../state/session-payloads.ts";
import { assertPolicySubset, deriveWorkerPolicy, WorkerPolicyError } from "./roles.ts";

const PARENT = {
  allow: [
    "read_file",
    "edit_file",
    "run_command",
    "web_search",
    "update_memory",
    "take_worker",
    "spawn_worker",
    "wait_workers",
  ],
  deny: ["edit_file"],
  approvalMode: "yolo" as const,
};

function refused(run: () => unknown): void {
  assert.throws(run, WorkerPolicyError);
}

test("工具清单：给了即只用清单（不套预设），只能取派出方能交出的工具；编排工具仍按层数自动给", () => {
  assert.deepEqual(
    deriveWorkerPolicy(PARENT, "explorer", { tools: ["run_command", "read_file", "read_file"] })
      .allow,
    ["run_command", "read_file"]
  );
  // 不给清单即按角色预设（与派出方现有工具取交）
  assert.deepEqual(deriveWorkerPolicy(PARENT, "tester").allow, [
    "read_file",
    "run_command",
    "web_search",
  ]);
  assert.deepEqual(
    deriveWorkerPolicy(PARENT, "tester", { tools: ["read_file"], orchestration: true }).allow,
    ["read_file", "spawn_worker", "wait_workers"]
  );
  for (const tools of [
    [],
    [""],
    ["edit_file"],
    ["update_memory"],
    ["take_worker"],
    ["spawn_worker"],
    ["grep"],
  ]) {
    refused(() => deriveWorkerPolicy(PARENT, "tester", { tools }));
  }
});

test("作用范围：规整后写进策略；没给的工具、种类不对、不能附加的工具、重复、坏路径与坏前缀一律拒绝", () => {
  const policy = deriveWorkerPolicy(PARENT, "tester", {
    scopes: [
      { tool: "read_file", paths: ["./src/", "docs\\api", "src"] },
      { tool: "run_command", commandPrefixes: [" npm test "] },
    ],
  });
  assert.deepEqual(policy.scopes, [
    { tool: "read_file", paths: ["src", "docs/api"] },
    { tool: "run_command", commandPrefixes: ["npm test"] },
  ]);
  const bad: ToolScope[][] = [
    [{ tool: "edit_file", paths: ["src"] }],
    [{ tool: "run_command", paths: ["src"] }],
    [{ tool: "read_file", commandPrefixes: ["npm test"] }],
    [{ tool: "web_search", paths: ["src"] }],
    [
      { tool: "read_file", paths: ["src"] },
      { tool: "read_file", paths: ["docs"] },
    ],
    [{ tool: "read_file", paths: ["src/../secret"] }],
    [{ tool: "read_file", paths: [".."] }],
    [{ tool: "read_file", paths: ["/etc"] }],
    [{ tool: "read_file", paths: ["C:\\Windows"] }],
    ...["npm test; rm x", "npm test && rm x", "npm | tee", "npm\ntest", "npm $(x)", '"npm'].map(
      (prefix) => [{ tool: "run_command", commandPrefixes: [prefix] }]
    ),
  ];
  for (const scopes of bad) {
    refused(() => deriveWorkerPolicy(PARENT, "tester", { scopes }));
  }
});

test("嵌套派出：派出方限定过的工具只能更窄，没另给即沿用；第二道校验拒绝放宽或丢掉范围", () => {
  const worker = {
    allow: ["read_file", "run_command", "spawn_worker"],
    deny: [],
    approvalMode: "yolo" as const,
    scopes: [
      { tool: "read_file", paths: ["src"] },
      { tool: "run_command", commandPrefixes: ["npm test"] },
    ],
  };
  assert.deepEqual(deriveWorkerPolicy(worker, "tester").scopes, worker.scopes);
  const narrower = deriveWorkerPolicy(worker, "tester", {
    scopes: [
      { tool: "read_file", paths: ["src/a"] },
      { tool: "run_command", commandPrefixes: ["npm test -- --grep x"] },
    ],
  });
  assert.doesNotThrow(() => assertPolicySubset(narrower, worker));
  for (const scopes of [
    [{ tool: "read_file", paths: ["docs"] }],
    [{ tool: "read_file", paths: ["."] }],
    [{ tool: "run_command", commandPrefixes: ["npm"] }],
    [{ tool: "run_command", commandPrefixes: ["npm testing"] }],
  ]) {
    refused(() => deriveWorkerPolicy(worker, "tester", { scopes }));
  }
  const { scopes: _dropped, ...unscoped } = narrower;
  refused(() => assertPolicySubset(unscoped, worker));
  refused(() =>
    assertPolicySubset(
      {
        ...narrower,
        scopes: [{ tool: "read_file", paths: ["docs"] }, worker.scopes[1] as ToolScope],
      },
      worker
    )
  );
});
