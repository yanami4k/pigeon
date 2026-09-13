// 工作区准备与恢复种子（M2 审计 note-1）：两个 Actor 入口共用的启动装配——
// prepareWorkspace = realpath 规范化 + D8 旧账本一次性迁移；restoreGrantSeed = 物化目标会话的
// 生效 grant（created − revoked，决策 3b）作 buildRuntime 的 restoredGrants 种子。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { newGrantId, newSessionId } from "../state/ids.ts";
import { prepareWorkspace, restoreGrantSeed, sessionsDirOf } from "./workspace.ts";

test("prepareWorkspace：返回 realpath 规范化的根，并把旧账本一次性迁移归档（D8）", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-workspace-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    // 空账本：迁移管线归档退役（改名 *.legacy.jsonl），不落事件文件
    writeFileSync(join(root, ".pigeon", "ledger.jsonl"), "", "utf8");
    const workspaceRoot = prepareWorkspace(root);
    assert.equal(workspaceRoot, realpathSync(root));
    assert.equal(existsSync(join(root, ".pigeon", "ledger.jsonl")), false, "旧账本应已改名退役");
    assert.ok(existsSync(join(root, ".pigeon", "ledger.legacy.jsonl")), "归档文件应在");
    // 重跑 no-op（一次性）
    assert.equal(prepareWorkspace(root), workspaceRoot);
    assert.equal(sessionsDirOf(workspaceRoot), join(workspaceRoot, ".pigeon", "sessions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreGrantSeed：物化目标会话的生效 grant（created − revoked）；无会话文件 = 空种子", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-workspace-"));
  try {
    const workspaceRoot = realpathSync(root);
    const sessionId = newSessionId();
    const log = new JsonlEventLog(sessionsDirOf(workspaceRoot), sessionId);
    const kept = log.appendGrantCreated({
      grantId: newGrantId(),
      tool: "edit_file",
      pathPrefix: "src",
      createdAt: 1,
      firstCall: { toolCallId: "tc-1", args: { path: "src/a.ts" } },
    });
    const revoked = log.appendGrantCreated({
      grantId: newGrantId(),
      tool: "read_file",
      createdAt: 2,
      firstCall: { toolCallId: "tc-2", args: {} },
    });
    log.appendGrantRevoked({ grantId: revoked.grantId, revokedAt: 3 });
    log.close();

    const seed = restoreGrantSeed(workspaceRoot, sessionId);
    assert.deepEqual(
      seed.map((grant) => [grant.grantId, grant.tool, grant.pathPrefix]),
      [[kept.grantId, "edit_file", "src"]]
    );
    assert.deepEqual(restoreGrantSeed(workspaceRoot, newSessionId()), [], "无会话文件 = 空种子");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
