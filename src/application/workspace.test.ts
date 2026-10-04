// 工作区准备与恢复种子（M2 审计 note-1）：两个 Actor 入口共用的启动装配——
// prepareWorkspace = realpath 规范化（决策 128 删除了 M3 旧账本一次性转换）；restoreGrantSeed = 从会话存储现算目标会话的
// 生效 grant（created − revoked，决策 3b）作 buildRuntime 的 restoredGrants 种子。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";
import { prepareWorkspace, restoreGrantSeed, sessionsDirOf } from "./workspace.ts";

test("prepareWorkspace：返回 realpath 规范化的根，不再触碰 M3 旧账本（决策 128）", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-workspace-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    const legacyLine = '{"kind":"intent"}\n';
    writeFileSync(join(root, ".pigeon", "ledger.jsonl"), legacyLine, "utf8");
    const workspaceRoot = prepareWorkspace(root);
    assert.equal(workspaceRoot, realpathSync(root));
    // 旧账本原样留在原处：不改名、不转换、不建会话目录
    assert.equal(readFileSync(join(root, ".pigeon", "ledger.jsonl"), "utf8"), legacyLine);
    assert.deepEqual(readdirSync(join(root, ".pigeon")), ["ledger.jsonl"]);
    assert.equal(existsSync(join(root, ".pigeon", "state", "sessions")), false);
    assert.equal(prepareWorkspace(root), workspaceRoot);
    assert.equal(sessionsDirOf(workspaceRoot), join(workspaceRoot, ".pigeon", "state", "sessions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreGrantSeed：从会话存储的授权条目现算生效集合（建立减撤销）；无会话文件 = 空种子", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grant-store-"));
  try {
    const sessionsDir = sessionsDirOf(root);
    const session = createFixtureSession({ sessionsDir, cwd: root });
    const kept = session.grantCreated({ tool: "edit_file", pathPrefix: "src" });
    const dropped = session.grantCreated({ tool: "run_command" });
    session.grantRevoked(dropped);
    const { sessionId } = await session.close();
    const seed = restoreGrantSeed(root, sessionId);
    assert.deepEqual(
      seed.map((grant) => [grant.grantId, grant.tool, grant.pathPrefix]),
      [[kept, "edit_file", "src"]]
    );
    assert.deepEqual(restoreGrantSeed(root, newSessionId()), [], "无会话文件 = 空种子");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
