// run_command shell 修订端到端（048 修订）：真实装配根 + CLI 审批问答版。
// prompt 下需 shell 的命令经人确认后以 shell 执行，面板文案含"经 shell"并原样显示命令串；[a] 创建带 shell 标记的
// 精确命令放权，同串再来免审、不同串再问；不带 shell 标记的固化规则不能免审需 shell 的命令；yolo 下直接执行；
// Receipt 的执行证据标明经 shell。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCliApprovalHandler } from "../cli/approval-ui.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newGrantId, newSessionId } from "../state/ids.ts";
import { buildRuntime } from "./runtime.ts";

const NODE = `"${process.execPath}"`;
const shellCommand = (a: string, b: string) =>
  `${NODE} -e "process.stdout.write('${a}')" && ${NODE} -e "process.stdout.write('${b}')"`;
const SHELL_1 = shellCommand("x", "y");
const SHELL_2 = shellCommand("x", "z");

function call(command: string, text: string) {
  return { text, toolCalls: [{ name: "run_command", args: { command } }] };
}

function makeRuntime(
  root: string,
  options: { replies: unknown[]; yolo?: boolean; answer?: () => string }
) {
  const sessionId = newSessionId();
  const prompts: string[] = [];
  let screen = "";
  let asked = 0;
  const bundle = buildRuntime({
    streamFn: createFakeStreamFn({ replies: options.replies as never }),
    workspaceRoot: root,
    homeDir: root,
    sessionId,
    yolo: options.yolo === true,
    provider: "fake-provider",
    modelId: "fake-model-1",
    createApprovalHandler: (grants) =>
      createCliApprovalHandler(
        async (prompt) => {
          prompts.push(prompt);
          if (prompt.startsWith("拒绝理由")) {
            return "不跑这条";
          }
          asked += 1;
          return options.answer?.() ?? "y";
        },
        (text) => {
          screen += text;
        },
        { grants }
      ),
  });
  return {
    bundle,
    sessionId,
    prompts,
    screen: () => screen,
    asked: () => asked,
  };
}

test("shell 命令：prompt 下经确认以 shell 执行，面板含经 shell 与原样命令串；[a] 后同串免审、不同串再问", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-shell-e2e-"));
  try {
    let answers = 0;
    const runtime = makeRuntime(root, {
      replies: [
        call(SHELL_1, "第一次"),
        call(SHELL_1, "同一串"),
        call(SHELL_2, "不同串"),
        { text: "完成" },
      ],
      answer: () => {
        answers += 1;
        return answers === 1 ? "a" : "n";
      },
    });
    let executions: ReturnType<typeof runtime.bundle.adapter.toolExecutions>;
    try {
      const result = await runtime.bundle.adapter.run("跑 shell 命令");
      executions = result.toolExecutions;
    } finally {
      await runtime.bundle.adapter.dispose();
      runtime.bundle.eventLog.close();
      await runtime.bundle.sessionStore.close();
    }
    assert.equal(runtime.asked(), 2);
    assert.ok(runtime.screen().includes(`命令（经 shell）：${SHELL_1}`), runtime.screen());
    assert.ok(runtime.prompts[0]?.includes("经 shell"), runtime.prompts[0]);
    assert.ok(runtime.screen().includes(`命令（经 shell）：${SHELL_2}`), runtime.screen());
    assert.deepEqual(
      executions.map((record) => record.decision?.approvedBy),
      ["human", "human:grant", "human"]
    );
    assert.equal(executions[2]?.decision?.outcome, "rejected");

    const session = materializeSession(join(root, ".pigeon", "sessions"), runtime.sessionId);
    assert.equal(session.grantCreateds[0]?.command, SHELL_1);
    assert.equal(session.grantCreateds[0]?.shell, true);
    const [first, second, third] = session.receipts;
    for (const receipt of [first, second]) {
      assert.equal(receipt?.exec?.shell, true);
      assert.equal(receipt?.exec?.command, SHELL_1);
      assert.equal(receipt?.exec?.output, "xy");
    }
    assert.equal(third?.executed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell 命令：不带 shell 标记的固化规则不能免审，仍弹人工审批", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-shell-e2e-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(
      join(root, ".pigeon", "grants.json"),
      JSON.stringify({
        version: 1,
        grants: [
          {
            tool: "run_command",
            command: SHELL_1,
            promotedFrom: {
              grantId: newGrantId(),
              sessionId: newSessionId(),
              firstCall: { toolCallId: "toolu_1", args: { command: SHELL_1 } },
              promotedAt: 1,
            },
          },
        ],
      })
    );
    const runtime = makeRuntime(root, { replies: [call(SHELL_1, "跑"), { text: "完成" }] });
    let executions: ReturnType<typeof runtime.bundle.adapter.toolExecutions>;
    try {
      executions = (await runtime.bundle.adapter.run("跑")).toolExecutions;
    } finally {
      await runtime.bundle.adapter.dispose();
      runtime.bundle.eventLog.close();
      await runtime.bundle.sessionStore.close();
    }
    assert.equal(runtime.asked(), 1);
    assert.equal(executions[0]?.decision?.approvedBy, "human");
    const receipt = materializeSession(join(root, ".pigeon", "sessions"), runtime.sessionId)
      .receipts[0];
    assert.equal(receipt?.exec?.shell, true);
    assert.equal(receipt?.exec?.output, "xy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell 命令：yolo 下直接执行不问人，Receipt 带经 shell 标记", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-shell-e2e-"));
  try {
    const runtime = makeRuntime(root, {
      replies: [call(SHELL_1, "跑"), { text: "完成" }],
      yolo: true,
    });
    let executions: ReturnType<typeof runtime.bundle.adapter.toolExecutions>;
    try {
      executions = (await runtime.bundle.adapter.run("跑")).toolExecutions;
    } finally {
      await runtime.bundle.adapter.dispose();
      runtime.bundle.eventLog.close();
      await runtime.bundle.sessionStore.close();
    }
    assert.equal(runtime.asked(), 0);
    assert.equal(executions[0]?.decision?.approvedBy, "policy:yolo");
    const receipt = materializeSession(join(root, ".pigeon", "sessions"), runtime.sessionId)
      .receipts[0];
    assert.equal(receipt?.executed, true);
    assert.equal(receipt?.exec?.shell, true);
    assert.equal(receipt?.exec?.output, "xy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
