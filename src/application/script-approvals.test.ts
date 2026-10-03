// "本次脚本内同类都允许"的同类口径（决策 303 的脚本部分）：跑命令取程序名加第一个子命令词；高危程序与两词命令不给同类（照常
// 逐次请示）；经 shell 或带串联、管道、重定向、命令替换的命令不给同类；网络档取网站；其余取工具加目录，无路径取工具。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalRequest } from "../approvals/handler.ts";
import {
  SCRIPT_KIND_DENY_COMMANDS,
  SCRIPT_KIND_DENY_PROGRAMS,
  scriptApprovalKind,
  wrapScriptApprovals,
} from "./script-approvals.ts";

const run = (command: string, needsShell = false): ApprovalRequest => ({
  toolName: "run_command",
  toolCallId: "c",
  args: { command },
  tier: "exec",
  command,
  needsShell,
});

test("跑命令的同类：程序名加第一个子命令词；参数像路径时只取程序名", () => {
  assert.equal(scriptApprovalKind(run("npm test"))?.text, "跑命令 npm test");
  assert.equal(scriptApprovalKind(run("npm test -- --watch"))?.text, "跑命令 npm test");
  assert.equal(scriptApprovalKind(run("git status"))?.text, "跑命令 git status");
  assert.equal(scriptApprovalKind(run("pytest tests/a.py"))?.text, "跑命令 pytest");
  assert.equal(scriptApprovalKind(run("node --test a.ts"))?.text, "跑命令 node");
});

test("高危名单不给同类：名单写成常量，任一词的程序名在名单里即不给", () => {
  assert.deepEqual(SCRIPT_KIND_DENY_PROGRAMS, [
    "rm",
    "sudo",
    "su",
    "chmod",
    "chown",
    "dd",
    "mkfs",
    "curl",
    "wget",
    "ssh",
    "scp",
  ]);
  assert.deepEqual(SCRIPT_KIND_DENY_COMMANDS, ["git push", "git reset", "git clean"]);
  for (const command of [
    "rm -rf build",
    "/bin/rm a",
    "sudo npm test",
    "chmod +x a.sh",
    "mkfs.ext4 /dev/x",
    "curl https://example.com",
    "xargs rm",
    "git push origin main",
    "git reset --hard",
    "git clean -fd",
    "ssh host",
  ]) {
    assert.equal(scriptApprovalKind(run(command)), undefined, command);
  }
});

test("经 shell 或带串联、管道、重定向与命令替换的命令不给同类", () => {
  for (const command of [
    "npm test && npm publish",
    "npm test | tee x",
    "npm test > out",
    "echo $(id)",
  ]) {
    assert.equal(scriptApprovalKind(run(command)), undefined, command);
  }
  assert.equal(scriptApprovalKind(run("npm test", true)), undefined);
});

test("网络档取网站；其余工具取工具加目录，无路径取工具", () => {
  const fetch: ApprovalRequest = {
    toolName: "web_fetch",
    toolCallId: "c",
    args: { url: "https://docs.example/a" },
    host: "docs.example",
  };
  assert.equal(scriptApprovalKind(fetch)?.text, "访问网站 docs.example");
  const edit: ApprovalRequest = {
    toolName: "edit_file",
    toolCallId: "c",
    args: { path: "src/a/b.ts" },
  };
  assert.equal(scriptApprovalKind(edit)?.text, "用 edit_file 处理 src/a/ 下的文件");
  assert.notEqual(
    scriptApprovalKind(edit)?.key,
    scriptApprovalKind({ ...edit, args: { path: "src/c.ts" } })?.key
  );
  assert.equal(
    scriptApprovalKind({ toolName: "mcp__x__y", toolCallId: "c", args: {} })?.text,
    "调用 mcp__x__y"
  );
});

test("决策 326 ①：写受保护路径的请示没有同类——不给 [s]，同类已放行也照常请示", async () => {
  const protectedWrite: ApprovalRequest = {
    toolName: "edit_file",
    toolCallId: "c",
    args: { path: ".pigeon/settings.json" },
    protectedPath: ".pigeon/settings.json",
    script: { runId: "r1" },
  };
  assert.equal(scriptApprovalKind(protectedWrite), undefined);
  const asked: ApprovalRequest[] = [];
  const allowed = new Set([`tool\nedit_file\n.pigeon`, "tool\nedit_file"]);
  const wrapped = wrapScriptApprovals(
    async (request) => {
      asked.push(request);
      return { approved: false };
    },
    () => ({
      title: () => "脚本",
      allows: (_runId, key) => allowed.has(key),
      allow: (_runId, key) => {
        allowed.add(key);
      },
    })
  );
  assert.deepEqual(await wrapped(protectedWrite), { approved: false });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.script?.kind, undefined);
});
