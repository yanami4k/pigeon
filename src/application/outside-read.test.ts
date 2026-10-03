// 工作区外只读（决策 355）——真实 pi-agent-core Agent + 审批闸：放手模式自动放行；非放手模式经人批准（[d] 按目录放权后
// 同目录不再问；PreToolUse 钩子放行算批准）；无人值守（没有审批通道）拒绝；工作区内的读取照旧免审；
// 禁读名单放手模式也拒；写与编辑仍限工作区。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler, ApprovalRequest } from "../approvals/handler.ts";
import { createCliApprovalHandler } from "../cli/approval-ui.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "../pi-runtime/snapshot.ts";
import { newSessionId } from "../state/ids.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import {
  createReadFileTool,
  type OutsideReadMode,
  ReadFileParamsSchema,
} from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createReplaceEditTool, ReplaceEditParamsSchema } from "../tools/replace-edit.ts";
import { createToolGovernance, type ToolGovernanceOptions } from "./governance.ts";

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pigeon-outside-read-")));
  const ws = join(base, "ws");
  const home = join(base, "home");
  mkdirSync(join(base, "lib", "pkg"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(ws);
  writeFileSync(join(ws, "in.txt"), "inside\n");
  writeFileSync(join(base, "lib", "pkg", "a.js"), "lib a\n");
  writeFileSync(join(base, "lib", "pkg", "b.js"), "lib b\n");
  writeFileSync(join(home, ".ssh", "id_rsa"), "key\n");
  return { base, ws, home, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const read = (path: string): FakeReply => ({
  text: "读",
  toolCalls: [{ name: "read_file", args: { path } }],
});

async function run(input: {
  ws: string;
  home: string;
  approvalMode: "prompt" | "yolo";
  outsideReads: OutsideReadMode;
  replies: FakeReply[];
  governance?: Omit<ToolGovernanceOptions, "registry">;
}) {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "读文件",
    parameters: ReadFileParamsSchema,
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "parallel",
  });
  registry.register({
    name: "edit_file",
    description: "改文件",
    parameters: ReplaceEditParamsSchema,
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  const host = createLocalWorkspaceHost(input.ws, { homeDir: input.home });
  const snapshot: InjectionSnapshot = {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: {
      policy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: input.approvalMode },
      advertised: ["read_file", "edit_file"],
    },
    context: { systemPrompt: "测试" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
  const streamFn = createFakeStreamFn({ replies: [...input.replies, { text: "完" }] });
  const adapter = new PiRuntimeAdapter({
    snapshot,
    streamFn,
    governance: createToolGovernance({ registry, workspaceRoot: input.ws, ...input.governance }),
    tools: [
      createReadFileTool(host, { outsideReads: input.outsideReads }),
      createReplaceEditTool(host),
    ],
    sessionId: newSessionId(),
  });
  const result = await adapter.run("读文件");
  await adapter.dispose();
  const messages = streamFn.calls.at(-1)?.context.messages ?? [];
  const results = messages
    .filter((message) => message.role === "toolResult")
    .map((message) =>
      (message.content as Array<{ type: string; text?: string }>)
        .map((block) => block.text ?? "")
        .join("")
    );
  const decisions = result.toolExecutions.map((record) => [
    record.decision?.outcome,
    record.decision?.approvedBy,
  ]);
  return { decisions, results, reasons: result.toolExecutions.map((r) => r.decision?.reason) };
}

test("放手模式：工作区外读取自动放行并读到内容；禁读文件照样拒；edit_file 改工作区外文件仍被围栏拒绝", async () => {
  const { base, ws, home, cleanup } = layout();
  try {
    const outside = join(base, "lib", "pkg", "a.js");
    const { decisions, results } = await run({
      ws,
      home,
      approvalMode: "yolo",
      outsideReads: "allowed",
      replies: [
        read(outside),
        read(join(home, ".ssh", "id_rsa")),
        {
          text: "改",
          toolCalls: [
            { name: "edit_file", args: { path: outside, old_string: "lib a", new_string: "x" } },
          ],
        },
      ],
    });
    assert.deepEqual(decisions, [
      ["approved", "policy:yolo"],
      ["approved", "policy:yolo"],
      ["approved", "policy:yolo"],
    ]);
    assert.match(results[0] ?? "", /lib a/);
    assert.match(results[1] ?? "", /禁读/);
    assert.match(results[2] ?? "", /路径越出工作区根/);
    assert.equal(readFileSync(outside, "utf8"), "lib a\n");
  } finally {
    cleanup();
  }
});

test("非放手模式：工作区内不问人；工作区外问人（请求带真实路径），拒绝即不读；[d] 按目录放权后同目录不再问", async () => {
  const { base, ws, home, cleanup } = layout();
  try {
    const store = new SessionGrantStore({ workspaceRoot: ws });
    const answers = ["n", "d"];
    const prompts: string[] = [];
    const outputs: string[] = [];
    const approvalHandler = createCliApprovalHandler(
      async (prompt) => {
        prompts.push(prompt);
        return prompt.startsWith("拒绝理由") ? "" : (answers.shift() ?? "n");
      },
      (text) => outputs.push(text),
      { grants: store }
    );
    const pkg = join(base, "lib", "pkg");
    const { decisions, results } = await run({
      ws,
      home,
      approvalMode: "prompt",
      outsideReads: "approval",
      replies: [
        read("in.txt"),
        read(join(pkg, "a.js")),
        read(join(pkg, "a.js")),
        read(join(pkg, "b.js")),
      ],
      governance: { approvalHandler, sessionGrants: store },
    });
    assert.deepEqual(decisions, [
      ["approved", "policy:auto"],
      ["rejected", "human"],
      ["approved", "human"],
      ["approved", "human:grant"],
    ]);
    assert.match(results[0] ?? "", /inside/);
    assert.doesNotMatch(results[1] ?? "", /lib a/);
    assert.match(results[2] ?? "", /lib a/);
    assert.match(results[3] ?? "", /lib b/);
    assert.ok(outputs.join("").includes(`工作区以外（只读）：${join(pkg, "a.js")}`));
    assert.deepEqual(
      store.list().map((grant) => [grant.tool, grant.pathPrefix]),
      [["read_file", pkg]]
    );
  } finally {
    cleanup();
  }
});

test("非放手模式：PreToolUse 钩子放行算批准，不再问人", async () => {
  const { base, ws, home, cleanup } = layout();
  try {
    const requests: ApprovalRequest[] = [];
    const approvalHandler: ApprovalHandler = async (request) => {
      requests.push(request);
      return { approved: false };
    };
    const { decisions, results } = await run({
      ws,
      home,
      approvalMode: "prompt",
      outsideReads: "approval",
      replies: [read(join(base, "lib", "pkg", "a.js"))],
      governance: { approvalHandler, preToolUseHooks: async () => ({ decision: "allow" }) },
    });
    assert.deepEqual(decisions, [["approved", "policy:hook"]]);
    assert.equal(requests.length, 0);
    assert.match(results[0] ?? "", /lib a/);
  } finally {
    cleanup();
  }
});

test("无人值守（没有审批通道）：工作区外读取拒绝、理由点明路径，工具不执行；工作区内照常", async () => {
  const { base, ws, home, cleanup } = layout();
  try {
    const outside = join(base, "lib", "pkg", "a.js");
    const { decisions, results, reasons } = await run({
      ws,
      home,
      approvalMode: "prompt",
      outsideReads: "refused",
      replies: [read(outside), read("in.txt")],
    });
    assert.deepEqual(decisions, [
      ["rejected", "policy:deny"],
      ["approved", "policy:auto"],
    ]);
    assert.ok(reasons[0]?.includes(outside), reasons[0]);
    assert.doesNotMatch(results[0] ?? "", /lib a/);
    assert.match(results[1] ?? "", /inside/);
  } finally {
    cleanup();
  }
});
