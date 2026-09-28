// 日常沙箱与推送记忆的交汇处（决策 192、207、237、245、252）：沙箱会话开着推送记忆时，收尾顺序为
// 最后一次验证 → 收尾复盘 → 交回分支 → 删除容器；收尾复盘与压缩前复盘的 read_file 都经同一个容器执行端，复盘不启动 MCP；
// update_memory 写宿主治理根下的 .pigeon/learned/MEMORY.md，不经容器执行端。容器以假 docker 代替，工作区是真 git 仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeSandboxDocker } from "../execution/sandbox-docker-fixtures.ts";
import { memoryFileOf } from "../memory/learned-store.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { disposeRuntime } from "./runtime.ts";
import { closeSandbox, runHeadlessInSandbox, startSandbox } from "./sandbox-session.ts";
import { openSessionRuntime } from "./session-runtime.ts";

const SUMMARY_PROMPT_HEAD = "You are a context summarization assistant.";
const CONTAINER_TEXT = "only-in-container";

interface LoggedMessage {
  role: string;
  content?: unknown;
  toolName?: string;
}

function textOf(message: LoggedMessage | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

function isReview(messages: readonly LoggedMessage[]): boolean {
  return messages.some((m) => m.role === "user" && textOf(m).startsWith("【复盘 v1"));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pigeon-sandbox-memory-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@example.invalid");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), ".pigeon/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

// 配一个 MCP 服务：一旦被启动就写下标记文件（沙箱里包括复盘都不该启动它）
function configureMarkerMcp(root: string): string {
  const marker = join(root, "mcp-started.marker");
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: {
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
        },
      },
    })
  );
  return marker;
}

// 容器工作区里有没有 .pigeon/learned（假 docker 的"容器内"路径即本机目录）
function containerHasLearned(containerRoot: string): boolean {
  const walk = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false;
      const full = join(dir, entry.name);
      if (entry.name === "learned" && dir.endsWith(".pigeon")) return true;
      return entry.name !== ".git" && walk(full);
    });
  return existsSync(containerRoot) && walk(containerRoot);
}

// 按请求分派：摘要、复盘、干活各走各的剧本；每次复盘请求时由 onReview 记下当时的外部状态
function routed(input: { main: FakeReply[]; review: FakeReply[]; onReview: () => void }) {
  const main = createFakeStreamFn({ replies: input.main });
  const review = createFakeStreamFn({ replies: input.review });
  const summary = createFakeStreamFn({ replies: [{ text: "## Goal\n摘要" }] });
  const reviewCalls: LoggedMessage[][] = [];
  const streamFn: StreamFn = (model, context, options) => {
    const messages = context.messages as unknown as LoggedMessage[];
    const system = context.systemPrompt ?? "";
    if (system.startsWith(SUMMARY_PROMPT_HEAD)) {
      return summary(model, context, options);
    }
    if (isReview(messages)) {
      input.onReview();
      reviewCalls.push(structuredClone(messages));
      return review(model, context, options);
    }
    return main(model, context, options);
  };
  return { streamFn, reviewCalls };
}

// 复盘自己的 read_file 结果文字（复盘指令之后的部分；之前是分叉带来的来源会话消息）
function reviewReadResults(reviewCalls: readonly LoggedMessage[][]): string[] {
  const last = reviewCalls.at(-1) ?? [];
  const start = last.findIndex((m) => m.role === "user" && textOf(m).startsWith("【复盘 v1"));
  return last
    .slice(start + 1)
    .filter((m) => m.role === "toolResult" && m.toolName === "read_file")
    .map((m) => textOf(m));
}

const REVIEW_READS_AND_WRITES: FakeReply[] = [
  {
    text: "看一下容器里的产物",
    toolCalls: [
      { name: "read_file", args: { path: "inside.txt" } },
      {
        name: "update_memory",
        args: {
          action: "add",
          fact: "复盘时记下的事实",
          refs: ["inside.txt"],
          reason: "复盘发现",
        },
      },
    ],
  },
  { text: "记好了" },
];

test("pigeon run --sandbox 开着推送：最后一次验证 → 收尾复盘（容器仍在、read_file 读容器里的文件、不启动 MCP）→ 交回分支 → 删除容器；记忆写在宿主", async () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "pigeon-sandbox-memory-home-"));
  const fake = fakeSandboxDocker();
  try {
    const marker = configureMarkerMcp(repo);
    const sessionId = newSessionId();
    const branch = `pigeon/sandbox-${sessionId}`;
    const seen: Array<{ containers: number; exported: boolean }> = [];
    const { streamFn, reviewCalls } = routed({
      main: [
        {
          text: "在容器里建文件",
          toolCalls: [
            { name: "run_command", args: { command: `printf ${CONTAINER_TEXT} > inside.txt` } },
          ],
        },
        { text: "完成" },
      ],
      review: REVIEW_READS_AND_WRITES,
      onReview: () => {
        seen.push({
          containers: Object.keys(fake.state().containers).length,
          exported: branchExists(repo, branch),
        });
      },
    });
    const result = await runHeadlessInSandbox(
      {
        task: "在工作区里建 inside.txt",
        governanceRoot: repo,
        workspaceRoot: repo,
        sessionId,
        streamFn,
        yolo: true,
        homeDir: home,
        skillRoots: [],
        memoryRoots: [],
        pushedMemory: true,
        verify: { command: "test -f inside.txt", timeoutMs: 30_000, source: "flag" },
      },
      {
        flags: { sandbox: { network: "on", approval: "yolo" } },
        log: () => {},
        overrides: {
          docker: fake.docker,
          image: { kind: "image", image: "sandbox-test:latest" },
          containerRoot: fake.containerRoot,
          cacheRoot: fake.cacheRoot,
        },
      }
    );
    assert.equal(result.status, "completed", result.errorMessage);
    assert.equal(result.verification?.verdict, "pass");
    assert.deepEqual(
      (result.reviews ?? []).map((review) => [review.kind, review.status]),
      [["closing", "completed"]]
    );
    // 最后一次验证在复盘之前：复盘指令里的验证结论是这次验证的结论
    const instruction = textOf(reviewCalls[0]?.at(-1));
    assert.ok(instruction.includes("验证门的最终结论：通过\n"), instruction);
    // 复盘期间容器仍在、还没交回
    assert.ok(seen.length >= 2, "复盘发了两次请求");
    assert.ok(
      seen.every((state) => state.containers === 1 && !state.exported),
      JSON.stringify(seen)
    );
    // 复盘的 read_file 读的是容器里的文件（宿主上没有这个文件）
    assert.equal(existsSync(join(repo, "inside.txt")), false);
    const reads = reviewReadResults(reviewCalls);
    assert.equal(reads.length, 1);
    assert.ok(reads[0]?.includes(CONTAINER_TEXT), reads[0]);
    // 复盘之后交回、删除容器
    assert.equal(git(repo, "show", `${branch}:inside.txt`), CONTAINER_TEXT);
    assert.deepEqual(fake.state().containers, {}, "交回后删除容器");
    // 记忆写在宿主治理根，容器里没有
    assert.ok(readFileSync(memoryFileOf(repo), "utf8").includes("事实：复盘时记下的事实"));
    assert.equal(containerHasLearned(fake.containerRoot), false, "容器里没有 .pigeon/learned");
    // 沙箱里包括复盘都不启动 MCP 服务
    assert.equal(existsSync(marker), false, "MCP 服务没有被启动");
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("交互沙箱会话开着推送：update_memory 写宿主的 MEMORY.md、容器里没有；压缩前复盘的 read_file 经同一个容器执行端，不启动 MCP", async () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "pigeon-sandbox-memory-home-"));
  const fake = fakeSandboxDocker();
  try {
    const marker = configureMarkerMcp(repo);
    const sessionId = newSessionId();
    const sandbox = await startSandbox({
      flags: { sandbox: { network: "on", approval: "yolo" } },
      governanceRoot: repo,
      sessionId,
      log: () => {},
      overrides: {
        docker: fake.docker,
        image: { kind: "image", image: "sandbox-test:latest" },
        containerRoot: fake.containerRoot,
        cacheRoot: fake.cacheRoot,
      },
    });
    assert.ok(sandbox !== undefined);
    let containersDuringReview = -1;
    const { streamFn, reviewCalls } = routed({
      main: [
        {
          text: "建文件并记一条",
          toolCalls: [
            { name: "run_command", args: { command: `printf ${CONTAINER_TEXT} > inside.txt` } },
            {
              name: "update_memory",
              args: {
                action: "add",
                fact: "干活时记下的事实",
                refs: ["a.txt"],
                reason: "干活时发现",
              },
            },
          ],
        },
        {
          // 足够长：保留量落在这条助手消息上，前面进待摘要段，轮间即压缩
          text: "我再读一下文件。".repeat(20),
          toolCalls: [{ name: "read_file", args: { path: "a.txt" } }],
          contextTokens: 5000,
        },
        { text: "读完了", contextTokens: 300 },
      ],
      review: [
        { text: "看一下", toolCalls: [{ name: "read_file", args: { path: "inside.txt" } }] },
        { text: "不记" },
      ],
      onReview: () => {
        containersDuringReview = Object.keys(fake.state().containers).length;
      },
    });
    const opened = await openSessionRuntime({
      governanceRoot: repo,
      sessionId,
      streamFn,
      flags: {
        yolo: true,
        provider: "custom",
        modelId: "custom",
        persistThinking: true,
        pushedMemory: true,
        compaction: { thresholdTokens: 1000, keepRecentTokens: 20 },
      },
      workspaceHost: sandbox.host,
      homeDir: home,
    });
    try {
      await opened.bundle.adapter.run(`请建文件再读 a.txt。${"背景说明。".repeat(60)}`);
    } finally {
      await disposeRuntime(opened.bundle);
    }
    // 压缩前复盘确实做了，期间容器在；read_file 读的是容器里的文件
    assert.ok(reviewCalls.length >= 2, "压缩前复盘发了请求");
    assert.ok(textOf(reviewCalls[0]?.at(-1)).startsWith("【复盘 v1·压缩前】"));
    assert.equal(containersDuringReview, 1);
    const reads = reviewReadResults(reviewCalls);
    assert.equal(reads.length, 1);
    assert.ok(reads[0]?.includes(CONTAINER_TEXT), reads[0]);
    assert.equal(existsSync(join(repo, "inside.txt")), false);
    // update_memory 写宿主治理根，容器里没有
    assert.ok(readFileSync(memoryFileOf(repo), "utf8").includes("事实：干活时记下的事实"));
    assert.equal(containerHasLearned(fake.containerRoot), false, "容器里没有 .pigeon/learned");
    assert.equal(existsSync(marker), false, "MCP 服务没有被启动");
    await closeSandbox(sandbox);
    assert.deepEqual(fake.state().containers, {});
  } finally {
    fake.cleanup();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
