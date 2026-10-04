// 日常沙箱改回逐条询问时的命令行审批（决策 253）：不能建目录放权的会话不提供 [d]，只给 [y]/[n]/[a]；
// 与"调用不带路径"同一做法。能建目录放权的会话照旧提供 [d]（见 approval-ui.test.ts）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { createCliApprovalHandler } from "./approval-ui.ts";

const REQUEST: ApprovalRequest = {
  toolName: "edit_file",
  toolCallId: "c1",
  args: { path: "src/a.ts" },
  tier: "write",
};

async function prompts(pathScoped: boolean, answer: string) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-sandbox-"));
  try {
    const grants = new SessionGrantStore({ workspaceRoot: root, pathScoped });
    const asked: string[] = [];
    const handler = createCliApprovalHandler(
      async (prompt) => {
        asked.push(prompt);
        return answer;
      },
      () => {},
      { grants }
    );
    const decision = await handler(REQUEST);
    return { asked, decision };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("沙箱会话（不能建目录放权）的审批不提供 [d]，只给 [y]/[n]/[a]", async () => {
  const { asked, decision } = await prompts(false, "y");
  assert.equal(asked.length, 1);
  assert.doesNotMatch(asked[0] ?? "", /\[d\]/);
  assert.match(asked[0] ?? "", /\[y\].*\[n\].*\[a\]/);
  assert.equal(decision.approved, true);
});
