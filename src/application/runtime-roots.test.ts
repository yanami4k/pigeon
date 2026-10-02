// 治理根与工作区根分离（M5.5 S1，决策 040）：会话文件、固化 grant 配置、常驻 Memory 取治理根
// 的 .pigeon/；工具路径围栏取工作区根。worker 的工作区是自己的 git 工作树，治理根恒在主仓库根。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendGrantConfigRule } from "../persistence/grants-config.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newGrantId, newSessionId } from "../state/ids.ts";
import type { EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { buildRuntime } from "./runtime.ts";

test("装配根：governanceRoot 与 workspaceRoot 分离——治理文件读写治理根，工具只动工作区", async () => {
  const governanceRoot = mkdtempSync(join(tmpdir(), "pigeon-gov-root-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pigeon-ws-root-"));
  const homeDir = mkdtempSync(join(tmpdir(), "pigeon-home-"));
  try {
    const original = "alpha\nbeta\n";
    writeFileSync(join(workspaceRoot, "a.ts"), original);
    appendGrantConfigRule(governanceRoot, {
      tool: "edit_file",
      promotedFrom: {
        grantId: newGrantId(),
        sessionId: newSessionId(),
        firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
        promotedAt: 1_757_000_000_000,
      },
    });
    // 决策 330：人写的说明从工作区根往上读（worker 即它自己的工作树）；治理根的 AGENTS.md 不读
    writeFileSync(join(workspaceRoot, "AGENTS.md"), "暗号：工作区\n");
    writeFileSync(join(governanceRoot, "AGENTS.md"), "暗号：治理根\n");

    const editArgs: EditFileParams = {
      path: "a.ts",
      snapshot: snapshotTag(original),
      edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
    };
    const sessionId = newSessionId();
    let handlerCalls = 0;
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editArgs }] },
          { text: "完成" },
        ],
      }),
      workspaceRoot,
      governanceRoot,
      // 决策 325：放权规则取自设置快照（由入口在会话开始时读治理根的设置）
      settings: loadSettings(governanceRoot, { homeDir }),
      homeDir,
      sessionId,
      yolo: false,
      provider: "fake-provider",
      modelId: "fake-model-1",
      // 剧本按 hashline 参数编辑（决策 062 起缺省为 replace，这里显式指定）
      editMode: "hashline",
      createApprovalHandler: () => async () => {
        handlerCalls += 1;
        return { approved: false, reason: "不应弹审批" };
      },
    });
    try {
      const result = await bundle.adapter.run("改 beta");
      assert.equal(result.status, "completed");
      // 固化规则来自治理根：prompt 模式下写调用免审放行
      assert.equal(handlerCalls, 0);
      assert.equal(result.toolExecutions[0]?.decision?.approvedBy, "policy:config");
      // 工具围栏在工作区根
      assert.equal(readFileSync(join(workspaceRoot, "a.ts"), "utf8"), "alpha\nBETA\n");
      // 人写的说明来自工作区根
      assert.equal(bundle.adapter.snapshot().memory[0]?.path, "AGENTS.md");
      assert.ok(bundle.adapter.snapshot().context.systemPrompt.includes("暗号：工作区"));
      assert.ok(!bundle.adapter.snapshot().context.systemPrompt.includes("暗号：治理根"));
    } finally {
      await bundle.adapter.dispose();
      await bundle.sessionStore.close();
    }
    // 会话文件落治理根；工作区根不出现 .pigeon/
    const located = locateSessionFile(
      join(governanceRoot, ".pigeon", "state", "sessions"),
      sessionId
    );
    assert.ok(located !== undefined, "治理根的会话存储里应有本会话文件");
    assert.ok(existsSync(located.path));
    assert.equal(existsSync(join(workspaceRoot, ".pigeon")), false);
  } finally {
    for (const dir of [governanceRoot, workspaceRoot, homeDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
