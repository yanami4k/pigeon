// 日常沙箱改回逐条询问时的终端界面审批（决策 253）：不能建目录放权的会话，面板不提供 [d]；能建的照旧。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { approvalBlockText, createTuiApprovalHandler, type TuiApprovalFace } from "./approval.ts";

const REQUEST: ApprovalRequest = {
  toolName: "edit_file",
  toolCallId: "c1",
  args: { path: "src/a.ts" },
  tier: "write",
};

async function panelText(pathScoped: boolean): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-approval-sandbox-"));
  try {
    let shown = "";
    const face: TuiApprovalFace = {
      askApproval: async (request, directoryGrant) => {
        shown = approvalBlockText(request, directoryGrant);
        return { key: "y" };
      },
      noteApproval: () => {},
    };
    const handler = createTuiApprovalHandler(
      new SessionGrantStore({ workspaceRoot: root, pathScoped }),
      () => face
    );
    assert.equal((await handler(REQUEST)).approved, true);
    return shown;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("沙箱会话（不能建目录放权）的审批面板不提供 [d]；能建的照旧提供", async () => {
  const sandboxed = await panelText(false);
  assert.doesNotMatch(sandboxed, /\[d\]/);
  assert.match(sandboxed, /\[a\] 本会话允许$/m);
  assert.match(await panelText(true), /\[d\] 本会话允许\(仅限当前调用所在目录\)/);
});
