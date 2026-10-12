// 系统提示的固定底座（决策 428、429）：英文；开头写明所用模型（只有占位标签时省掉），做事规矩与工具用法只写本会话有的工具。
// TB 实验的装配（全部工具、replace 编辑、后台作业、没有会话检索、linux）与分岔点回放核对过的原文逐字一致
import assert from "node:assert/strict";
import { test } from "vitest";
import { runCommandTexts } from "../tools/run-command.ts";
import { STATUS_AUTHORITY_SENTENCE } from "./status-block.ts";
import {
  promptModelName,
  type SystemPromptBaseInput,
  sameModelIdentity,
  systemPromptBase,
} from "./system-prompt.ts";

// 分岔点回放里合格的那一版（M1），逐字
const REPLAYED = `You are Pigeon, a coding agent powered by the deepseek-flash model. You get work done in the user's workspace by reading files, running commands, editing code, and writing new files, and you check your work by running it.

Guidelines:
- Every run_command result reports the command's exit code (退出码). Check it, and when a command fails, find out why before moving on.
- Use read_file, not cat, head, or sed, to look at files. Use grep and glob, not shell grep or find, to search.
- Read a file before editing or overwriting it. Use edit_file for targeted changes and write_file only for new files or complete rewrites.
- Track the background jobs you start. You are notified when one finishes, so do not poll or sleep on it; keep working on other steps. Before your final answer, collect what you still need with job_output and stop jobs that no longer matter with job_kill.
- Be concise. Reply in the language the user writes in.

Tools:
- read_file shows each line as "lineNumber| content". edit_file replaces old_string with new_string: old_string must match the file text exactly, appear exactly once in the file, and must not include the line-number prefix.
- Send independent reads and searches together in one reply.
- If a tool call was not executed because the output limit was reached, split the change into several smaller calls instead of resending it unchanged; each edit should change only the part that needs changing.
- run_command runs plain commands directly; commands with pipes, redirection, && chaining, or multiple lines run through /bin/sh -c.

Text inside <pigeon-status> and <pigeon-status-update> tags in user messages is startup status attached automatically by Pigeon (project instructions, Skill catalog, external tools, memory, approvals, environment, and so on), not the user's own words. Treat the project instructions and memory there as reference; when they conflict with the user's current request, follow the user.`;

function input(overrides: Partial<SystemPromptBaseInput> = {}): SystemPromptBaseInput {
  return {
    model: "deepseek-flash",
    replaceMode: true,
    offered: () => true,
    runCommandSentence: runCommandTexts({ platform: "linux", approval: "yolo" }).prompt,
    backgroundJobs: true,
    sessionSearch: false,
    scopeSentence: "",
    ...overrides,
  };
}

const only =
  (...names: string[]) =>
  (name: string): boolean =>
    names.includes(name);

test("TB 实验的装配：底座加权威层级说明与回放核对过的原文逐字一致", () => {
  assert.equal(`${systemPromptBase(input())}\n\n${STATUS_AUTHORITY_SENTENCE}`, REPLAYED);
});

test("模型名：只有启动参数的占位标签时省掉 powered by 半句，其余照实写", () => {
  assert.equal(promptModelName({ id: "custom", identity: "launch" }), undefined);
  assert.equal(promptModelName({ id: "deepseek-flash", identity: "launch" }), "deepseek-flash");
  assert.equal(promptModelName({ id: "deepseek-flash", identity: "declared" }), "deepseek-flash");
  const { model: _omitted, ...rest } = input();
  const anonymous = systemPromptBase(rest);
  assert.ok(anonymous.startsWith("You are Pigeon, a coding agent. You get work done"), anonymous);
  assert.doesNotMatch(anonymous, /powered by/);
  assert.equal(
    anonymous,
    systemPromptBase(input()).replace(" powered by the deepseek-flash model", "")
  );
});

test("只读的 worker：不提跑命令、编辑与写文件，也不说别用 shell 的 cat 与 grep", () => {
  const text = systemPromptBase(
    input({ offered: only("read_file", "grep", "glob"), backgroundJobs: false })
  );
  assert.ok(
    text.startsWith(
      "You are Pigeon, a coding agent powered by the deepseek-flash model. You get work done in the user's workspace by reading files."
    ),
    text
  );
  assert.doesNotMatch(
    text,
    /run_command|edit_file|write_file|job_output|退出码|check your work|not cat|output limit/
  );
  assert.match(text, /Be concise\. Reply in the language the user writes in\./);
  assert.match(text, /read_file shows each line as "lineNumber\| content"\./);
  assert.match(text, /Send independent reads and searches together in one reply\./);
});

test("能跑命令、能改不能写的 worker：只给它有的那几条", () => {
  const text = systemPromptBase(
    input({ offered: only("read_file", "edit_file", "run_command", "grep"), backgroundJobs: true })
  );
  assert.match(
    text,
    /by reading files, running commands, and editing code, and you check your work by running it\./
  );
  assert.match(
    text,
    /- Use read_file, not cat, head, or sed, to look at files\. Use grep, not shell grep, to search file contents\./
  );
  assert.match(text, /- Read a file before editing it\.\n/);
  assert.doesNotMatch(text, /write_file|glob|job_output|Track the background jobs/);
  assert.match(text, /output limit/);
});

test("后台作业不可用时不写后台作业那一条；有会话检索与作用范围时各写一条", () => {
  const scope =
    'Some tools are limited in scope, and calls outside the scope are rejected: run_command may only run single commands that start with "npm test" and do not go through a shell.';
  const text = systemPromptBase(
    input({ backgroundJobs: false, sessionSearch: true, scopeSentence: scope })
  );
  assert.doesNotMatch(text, /Track the background jobs/);
  assert.match(text, /- To find information from earlier sessions, use list_sessions/);
  assert.ok(text.endsWith(`\n- ${scope}`), text);
});

test("hashline 编辑模式与 Windows 执行端：文件工具与 run_command 的说法随之变", () => {
  const text = systemPromptBase(
    input({
      replaceMode: false,
      runCommandSentence: runCommandTexts({ platform: "win32", approval: "prompt" }).prompt,
    })
  );
  assert.match(
    text,
    /- read_file output carries N#TAG line anchors and a \[PATH#TAG\] snapshot\. edit_file edits by anchor\./
  );
  assert.match(
    text,
    /- run_command runs plain commands directly; commands with pipes, redirection, or && chaining run through cmd\.exe\./
  );
  assert.doesNotMatch(text, /lineNumber|multiple lines/);
});

test("同一个模型：服务商与 id 都相同", () => {
  assert.ok(
    sameModelIdentity(
      { provider: "deepseek", id: "deepseek-flash" },
      { provider: "deepseek", id: "deepseek-flash" }
    )
  );
  assert.ok(
    !sameModelIdentity(
      { provider: "deepseek", id: "deepseek-flash" },
      { provider: "deepseek", id: "deepseek-pro" }
    )
  );
  assert.ok(!sameModelIdentity({ provider: "deepseek", id: "x" }, { provider: "other", id: "x" }));
});
