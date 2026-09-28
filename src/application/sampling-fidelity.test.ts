// 采样参数的保真（决策 087 修订、110）：分叉重试必须沿用原尝试的采样温度与工作方式指令。
// 同一个模型换一个温度就是换了尺子——087 修订说"日后新增同类维度按本条推定"，温度与工作方式指令都属于这一类。
// 失效判定的封闭清单（091）本轮不纳入温度，是已知缺口，见审计。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { runHeadless } from "./headless.ts";
import type { McpSession } from "./mcp.ts";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("分叉重试沿用来源尝试的温度与工作方式指令：重试那次的调用选项与 Run 开始条目与来源尝试一致", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-sampling-fork-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-sampling-fork-home-"));
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "pigeon@example.invalid"]);
    git(dir, ["config", "user.name", "pigeon-test"]);
    git(dir, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
    writeFileSync(join(dir, "a.txt"), "old\n");
    writeFileSync(
      join(dir, "check.mjs"),
      'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("a.txt", "utf8") === "new\\n" ? 0 : 1);\n'
    );
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
    const edit = (content: string) => ({
      text: "改",
      toolCalls: [
        { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: content } },
      ],
    });
    const fake = createFakeStreamFn({
      replies: [edit("wrong\n"), { text: "改好了" }, edit("new\n"), { text: "这次对了" }],
    });
    const calls: Array<{ temperature: unknown; systemPrompt: string }> = [];
    const streamFn: StreamFn = (model, context, options) => {
      calls.push({
        temperature: (options as { temperature?: unknown } | undefined)?.temperature,
        systemPrompt: context.systemPrompt ?? "",
      });
      return fake(model, context, options);
    };
    const directive = "Your task is to make a.txt read new.";
    const result = await runHeadless({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn,
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      verify: { command: `"${process.execPath}" check.mjs`, timeoutMs: 30_000 },
      retryOnFail: 1,
      temperature: 0,
      taskDirective: directive,
    });
    assert.equal(result.retries?.length, 1);
    const branchId = result.retries?.[0]?.branchSessionId;
    assert.ok(branchId !== undefined);
    // 来源尝试两轮、重试两轮：每一次调用都带温度 0 与同一句指令
    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.equal(call.temperature, 0);
      assert.ok(call.systemPrompt.endsWith(directive));
    }
    // 分支会话自己的 Run（不含从来源复制过来的那一段）的开始条目
    const branch = loadStoreSession(join(dir, ".pigeon", "sessions"), branchId);
    assert.ok(branch !== undefined, "会话存储里应有分支会话");
    assert.equal(branch.view.runs.length, 1);
    assert.equal(branch.view.runs[0]?.start.model.temperature, 0);
    assert.equal(branch.view.runs[0]?.start.taskDirective, directive);
  } finally {
    try {
      git(dir, ["worktree", "prune"]);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
