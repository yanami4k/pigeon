// run_command shell 修订端到端（048 修订）：真实装配根 + CLI 审批问答版。
// prompt 下需 shell 的命令经人确认后以 shell 执行，面板文案含"经 shell"并原样显示命令串；[a] 创建带 shell 标记的
// 精确命令放权，同串再来免审、不同串再问；不带 shell 标记的固化规则不能免审需 shell 的命令；yolo 下直接执行；
// 工具结果 details 里的执行证据标明经 shell。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCliApprovalHandler } from "../cli/approval-ui.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newGrantId, newSessionId } from "../state/ids.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import type { ExecEvidence } from "../tools/run-command.ts";
import { buildRuntime } from "./runtime.ts";

// 取值并断言在场（替代非空断言）
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined, "值应在场");
  return value;
}

const NODE = `"${process.execPath}"`;
const shellCommand = (a: string, b: string) =>
  `${NODE} -e "process.stdout.write('${a}')" && ${NODE} -e "process.stdout.write('${b}')"`;
const SHELL_1 = shellCommand("x", "y");
const SHELL_2 = shellCommand("x", "z");

// 读会话存储里本会话的全部工具结果消息（按顺序）与授权条目
function storeFacts(root: string, sessionId: string) {
  const loaded = loadStoreSession(join(root, ".pigeon", "sessions"), sessionId);
  assert.ok(loaded !== undefined, "会话存储里应有本会话");
  const toolResults = loaded.view.runs
    .flatMap((run) => run.messages.map((ref) => ref.message))
    .filter((message) => message.role === "toolResult");
  return { toolResults, grants: loaded.view.grants.map((record) => record.data) };
}

// 成功执行的工具结果 details 就是执行证据（外加运行面标记）；出错路径不带证据
function execOf(message: StoreMessage | undefined): Partial<ExecEvidence> {
  return (message?.details ?? {}) as Partial<ExecEvidence>;
}

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

    const { toolResults, grants } = storeFacts(root, runtime.sessionId);
    assert.equal(grants.length, 1);
    const grant = grants[0];
    assert.ok(grant?.event === "created");
    assert.equal(grant.command, SHELL_1);
    assert.equal(grant.shell, true);
    assert.equal(toolResults.length, 3);
    const [first, second, third] = toolResults;
    for (const message of [first, second]) {
      assert.equal(message?.isError, false);
      assert.equal(execOf(message).shell, true);
      assert.equal(execOf(message).command, SHELL_1);
      assert.equal(execOf(message).output, "xy");
    }
    // 被拒的调用没有执行：工具结果是错误、不带执行证据
    assert.equal(third?.isError, true);
    assert.equal(toolResultMark(required(third))?.gate?.outcome, "rejected");
    assert.equal(execOf(third).command, undefined);
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
      await runtime.bundle.sessionStore.close();
    }
    assert.equal(runtime.asked(), 1);
    assert.equal(executions[0]?.decision?.approvedBy, "human");
    const stored = storeFacts(root, runtime.sessionId).toolResults;
    assert.equal(stored.length, 1);
    assert.equal(toolResultMark(required(stored[0]))?.gate?.approvedBy, "human");
    assert.equal(execOf(stored[0]).shell, true);
    assert.equal(execOf(stored[0]).output, "xy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell 命令：yolo 下直接执行不问人，执行证据带经 shell 标记", async () => {
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
      await runtime.bundle.sessionStore.close();
    }
    assert.equal(runtime.asked(), 0);
    assert.equal(executions[0]?.decision?.approvedBy, "policy:yolo");
    const stored = storeFacts(root, runtime.sessionId).toolResults;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.isError, false);
    assert.equal(toolResultMark(required(stored[0]))?.gate?.approvedBy, "policy:yolo");
    assert.equal(execOf(stored[0]).command, SHELL_1);
    assert.equal(execOf(stored[0]).shell, true);
    assert.equal(execOf(stored[0]).output, "xy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
