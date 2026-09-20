// 回放的权限形态（M8 S5，决策 083）：验证器的命令档工具只在固化命令规则内放行。
// 端到端走真实的 worker 运行面工厂——角色要一路传到 run_command 的清单围栏上，中间断一处这条测试就红。
//
// 这不是隔离：放行一条脚本命令即等于放行该脚本能做的一切，网络也不受限；
// 真正的断网与文件白名单只有沙箱能给，已排入 M9 前置（决策 083）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROLE_TOOLS } from "../orchestration/roles.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

const NODE = `"${process.execPath}"`;
const REGISTERED = `${NODE} -e "process.stdout.write('ok')"`;
const UNREGISTERED = `${NODE} -e "process.stdout.write('nope')"`;

function runCommandCall(command: string, text: string) {
  return { text, toolCalls: [{ name: "run_command", args: { command } }] };
}

// 派一个真的验证器 worker 跑几条命令，回执从它自己的会话账本读
async function receiptsOf(root: string, replies: ReturnType<typeof runCommandCall>[]) {
  const sessionId = newSessionId();
  const factory = createWorkerRuntimeFactory({
    streamFnFor: () => createFakeStreamFn({ replies: [...replies, { text: "完成" }] }),
    provider: "fake-provider",
    modelId: "fake-model-1",
    homeDir: root,
  });
  const handle = factory({
    sessionId,
    name: "verify-aaaaaaaa-fw-1",
    role: "verifier",
    task: "重跑这次尝试",
    policy: { allow: [...ROLE_TOOLS.verifier], deny: [], approvalMode: "yolo" },
    governanceRoot: root,
    workspace: { kind: "git-worktree", path: root, branch: "pigeon/verify-aaaaaaaa-fw-1" },
    lineage: { parentSessionId: newSessionId() },
    approvalHandler: async () => ({ approved: false, reason: "回放没有审批通道" }),
  });
  try {
    await handle.run("重跑这次尝试");
  } finally {
    await handle.dispose();
  }
  return materializeSession(join(root, ".pigeon", "sessions"), sessionId, { content: false })
    .receipts;
}

function governanceRoot(verifierCommands?: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "pigeon-verifier-commands-"));
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  writeFileSync(
    join(root, ".pigeon", "commands.json"),
    JSON.stringify({
      version: 1,
      commands: { check: REGISTERED },
      ...(verifierCommands !== undefined ? { roles: { verifier: verifierCommands } } : {}),
    }),
    "utf8"
  );
  return root;
}

test("验证器：登记在固化命令规则里的命令能跑，规则外的一律拒绝且不产生副作用", async () => {
  const root = governanceRoot(["check"]);
  try {
    const receipts = await receiptsOf(root, [
      runCommandCall("check", "跑登记的"),
      runCommandCall(UNREGISTERED, "跑没登记的"),
    ]);
    assert.equal(receipts[0]?.exec?.alias, "check");
    assert.equal(receipts[0]?.exec?.output, "ok");
    assert.equal(receipts[1]?.executed, false);
    assert.equal(receipts[1]?.exec, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("验证器：commands.json 没给 verifier 登记任何命令时一条也跑不了（fail-closed）", async () => {
  const root = governanceRoot();
  try {
    const receipts = await receiptsOf(root, [runCommandCall("check", "试试别的角色登记过的短名")]);
    assert.equal(receipts[0]?.executed, false);
    assert.equal(receipts[0]?.exec, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("验证器：拿到的是写代码那一组工具，不含跨会话检索或只读快照工具", () => {
  assert.deepEqual([...ROLE_TOOLS.verifier].sort(), ["edit_file", "read_file", "run_command"]);
});
