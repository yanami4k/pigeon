// TUI 审批面板对网络档请求（决策 290）：审批块显示网站行与“以后都允许访问 <网站>”键，不提供 [d]；[a] 建按网站的放权。
import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { asRunId } from "../state/ids.ts";
import { approvalBlockText, createTuiApprovalHandler, type TuiApprovalFace } from "./approval.ts";

const request: ApprovalRequest = {
  toolName: "web_fetch",
  toolCallId: "toolu_01",
  args: { url: "https://docs.example/a", prompt: "找什么" },
  tier: "network",
  host: "docs.example",
  runId: asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
};

test("审批块：网站行 + 以后都允许访问该网站；不提供 [d]", () => {
  const text = approvalBlockText(request);
  assert.match(text, /工具：web_fetch\n网站：docs\.example\n参数：/);
  assert.match(text, /\[a\] 以后都允许访问 docs\.example$/);
  assert.doesNotMatch(text, /\[d\]/);
});

test("[a] 建按网站的放权，结果行点名网站；[y] 只批准一次", async () => {
  const store = new SessionGrantStore({ workspaceRoot: "/nonexistent" });
  const notes: string[] = [];
  let key: "a" | "y" = "a";
  const face: TuiApprovalFace = {
    askApproval: async (_request, directoryGrant) => {
      assert.equal(directoryGrant, false, "网络档不提供 [d]");
      return { key };
    },
    noteApproval: (line) => notes.push(line),
  };
  const handler = createTuiApprovalHandler(store, () => face);
  assert.deepEqual(await handler(request), { approved: true });
  assert.deepEqual(
    store.list().map((grant) => [grant.tool, grant.host]),
    [["web_fetch", "docs.example"]]
  );
  assert.match(
    notes.join("\n"),
    /已创建会话放权 grant_[0-9A-Z]+（web_fetch，仅限网站 docs\.example）/
  );
  key = "y";
  assert.deepEqual(await handler(request), { approved: true });
  assert.equal(store.list().length, 1);
});
