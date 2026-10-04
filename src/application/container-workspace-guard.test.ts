// 容器工作区的护栏（M9）：按路径限定的放权规则以宿主路径判定，对容器工作区只会静默失配。路径放权在容器工作区下
// 暂不支持——拿到非本地执行端的运行面，凡是带审批通道（交互场景）或装了按路径限定的固化放权规则的，装配时
// 明确报错；无审批通道、无路径规则的无人值守运行（Eval）照常。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import { newGrantId, newSessionId } from "../state/ids.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { buildRuntime, disposeRuntime, type RuntimeDeps } from "./runtime.ts";

function containerLikeHost(root: string): WorkspaceHost {
  // 形状上就是"不是 workspaceRoot 上的本地实现"：根在别处
  return { ...createLocalWorkspaceHost(root), root: "/testbed", platform: "linux" };
}

// 固化规则的来历字段与本用例无关，给一份合法的占位
function rule(fields: { tool: string; pathPrefix?: string; command?: string }): ConfigGrantRule {
  return {
    ...fields,
    promotedFrom: {
      grantId: newGrantId(),
      sessionId: newSessionId(),
      firstCall: { toolCallId: "call-1", args: {} },
      promotedAt: 0,
    },
  };
}

function deps(root: string, overrides: Partial<RuntimeDeps>): RuntimeDeps {
  return {
    streamFn: createFakeStreamFn({ replies: [{ text: "完成" }] }),
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: true,
    provider: "custom",
    modelId: "custom",
    homeDir: root,
    skillRoots: [],
    agentsMd: false,
    ...overrides,
  };
}

test("容器工作区加审批通道（交互场景）：装配时明确报错说暂不支持，不让路径放权静默失配", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-guard-"));
  try {
    assert.throws(
      () =>
        buildRuntime(
          deps(root, {
            workspaceHost: containerLikeHost(root),
            createApprovalHandler: () => async () => ({ approved: false, reason: "测试" }),
          })
        ),
      /容器工作区暂不支持交互审批.*路径.*放权/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("容器工作区加按路径限定的固化放权规则：装配时明确报错并点出是哪条规则；不带路径的规则不受影响", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-guard-"));
  try {
    assert.throws(
      () =>
        buildRuntime(
          deps(root, {
            workspaceHost: containerLikeHost(root),
            configGrants: [rule({ tool: "edit_file", pathPrefix: "src/" })],
          })
        ),
      /容器工作区暂不支持按路径限定的放权规则：edit_file（src\/）/
    );
    const bundle = buildRuntime(
      deps(root, {
        workspaceHost: containerLikeHost(root),
        configGrants: [rule({ tool: "run_command", command: "npm test" })],
      })
    );
    await disposeRuntime(bundle);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("本地工作区不受护栏影响：审批通道与路径放权规则照常装配", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-guard-"));
  try {
    const bundle = buildRuntime(
      deps(root, {
        createApprovalHandler: () => async () => ({ approved: false, reason: "测试" }),
        configGrants: [rule({ tool: "edit_file", pathPrefix: "src/" })],
      })
    );
    await disposeRuntime(bundle);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
