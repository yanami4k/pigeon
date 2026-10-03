// 容器执行端的装配护栏（112 的延伸）：注入了非本地执行端时，workspaceRoot 在宿主一侧、不是 agent 干活的工作区。
// 分支会话要在 workspaceRoot 上打 git 快照——对执行端另一侧的工作区只会得到假结果，故装配前一律拒绝，且不写任何账本；
// 本地工作区照常。失败自动分叉重试与会话级验证命令已随决策 322 删除，不再有此处的组合护栏。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { BranchHeaderInput } from "../state/session-payloads.ts";
import { asWorkspaceHost } from "../tools/local-host.ts";
import { runHeadless } from "./headless-core.ts";

test("容器执行端不与分支会话同用：装配前拒绝、不写账本；不带执行端（本地工作区）时照常", async () => {
  const governance = mkdtempSync(join(tmpdir(), "pigeon-guard-gov-"));
  const placeholder = mkdtempSync(join(tmpdir(), "pigeon-guard-ws-"));
  const remote = mkdtempSync(join(tmpdir(), "pigeon-guard-remote-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-guard-home-"));
  try {
    // 执行端本身是什么不重要：注入即视为非本地（与 112 的判定一致）；它的工作区与宿主一侧的 workspaceRoot 不是同一处
    const host = asWorkspaceHost(remote);
    const base = {
      task: "什么也不用做",
      governanceRoot: governance,
      workspaceRoot: placeholder,
      workspaceHost: host,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      yolo: true,
      homeDir: home,
    };
    await assert.rejects(
      runHeadless({ ...base, branchHeader: {} as BranchHeaderInput }),
      (error: Error) => /容器工作区/.test(error.message) && /分支会话/.test(error.message)
    );
    assert.equal(
      existsSync(join(governance, ".pigeon", "state", "sessions")),
      false,
      "被拒的装配不写账本"
    );
    // 对照：不带执行端（本地工作区）时照常跑完
    const { workspaceHost: _host, ...local } = base;
    const result = await runHeadless(local);
    assert.equal(result.status, "completed");
  } finally {
    rmSync(governance, { recursive: true, force: true });
    rmSync(placeholder, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
