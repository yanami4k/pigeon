// 网络档审批的作用域（决策 290）：请求带主机名时 [a]/[d] 都收窄为该网站；不提供 [d]；提示文案点名网站。
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRunId } from "../state/ids.ts";
import {
  type ApprovalRequest,
  commandScopeNote,
  grantScopeFor,
  hostGrantKeyLabel,
  offersDirectoryGrant,
} from "./handler.ts";

const request: ApprovalRequest = {
  toolName: "web_fetch",
  toolCallId: "toolu_01",
  args: { url: "https://docs.example/a", prompt: "找什么", path: "misleading" },
  tier: "network",
  host: "docs.example",
  runId: asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
};

test("带主机名的请求：[a] 与 [d] 都建按网站的放权；不提供目录放权；文案为“以后都允许访问 <网站>”", () => {
  assert.deepEqual(grantScopeFor(request, "a"), { host: "docs.example" });
  assert.deepEqual(grantScopeFor(request, "d"), { host: "docs.example" });
  assert.equal(offersDirectoryGrant(request, undefined), false);
  assert.equal(hostGrantKeyLabel(request), "[a] 以后都允许访问 docs.example");
  assert.equal(commandScopeNote({ host: "docs.example" }), "，仅限网站 docs.example");
  assert.equal(commandScopeNote({ command: "ls" }), "，仅限命令 ls");
});

test("不带主机名的请求照旧：exec 档为精确命令，其余按目录或工具级", () => {
  const { host: _host, ...plain } = request;
  assert.deepEqual(grantScopeFor({ ...plain, tier: "write" }, "d"), { pathPrefix: "." });
  assert.deepEqual(grantScopeFor({ ...plain, tier: "write" }, "a"), {});
});
