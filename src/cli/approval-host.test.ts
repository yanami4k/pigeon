// 命令行审批对网络档请求（决策 290）：显示网站，[a] 建按网站的放权，不提供 [d]。
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { asRunId } from "../state/ids.ts";
import { createCliApprovalHandler } from "./approval-ui.ts";

const request: ApprovalRequest = {
  toolName: "web_fetch",
  toolCallId: "toolu_01",
  args: { url: "https://docs.example/a", prompt: "找什么" },
  tier: "network",
  host: "docs.example",
  runId: asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
};

test("[a] 以后都允许访问该网站：建按网站的放权；提示不带 [d]", async () => {
  const store = new SessionGrantStore({ workspaceRoot: "/nonexistent" });
  const outputs: string[] = [];
  const handler = createCliApprovalHandler(
    async (prompt) => {
      outputs.push(prompt);
      return "a";
    },
    (text) => outputs.push(text),
    { grants: store }
  );
  assert.deepEqual(await handler(request), { approved: true });
  const text = outputs.join("");
  assert.match(text, /工具：web_fetch\n网站：docs\.example\n参数：/);
  assert.match(text, /\[a\] 以后都允许访问 docs\.example/);
  assert.doesNotMatch(text, /\[d\]/);
  assert.match(text, /已创建会话放权 grant_[0-9A-Z]+（web_fetch，仅限网站 docs\.example）/);
  assert.deepEqual(
    store.list().map((grant) => [grant.tool, grant.host, grant.pathPrefix]),
    [["web_fetch", "docs.example", undefined]]
  );
});
