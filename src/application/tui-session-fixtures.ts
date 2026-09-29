// 测试夹具：终端界面会话的开、跑、退出（决策 283 的用例共用）。会话运行面与终端界面同一条装配路径（openSessionRuntime，
// 推送记忆开着、{冲突处理} 交互版），退出走 closeTuiSession；模型为按请求分派的假模型：复盘请求（末条用户消息以复盘指令开头）
// 与干活的请求各走各的剧本，记下每次请求的种类与消息。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchEntries,
  listSessionFiles,
  locateSessionFile,
  readSessionFile,
  type StoredEntry,
} from "../persistence/session-reader.ts";
import type { CompactionConfigInput } from "../pi-runtime/compaction.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import type { RunStartData } from "../state/session-entries.ts";
import { noMcpSession } from "./mcp.ts";
import type { ReviewModelChoice } from "./memory-review.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { closeTuiSession } from "./tui-exit.ts";
import { sessionsDirOf } from "./workspace.ts";

export interface LoggedCall {
  kind: "main" | "review" | "summary";
  // 请求发往的 provider 与模型号
  provider: string;
  model: string;
  messages: Array<{ role: string; content?: unknown }>;
}

export function textOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

function isReview(messages: LoggedCall["messages"]): boolean {
  return messages.some((m) => m.role === "user" && textOf(m).startsWith("【复盘 v1"));
}

// 压缩摘要请求的系统提示开头（上游口径）
const SUMMARY_PROMPT_HEAD = "You are a context summarization assistant.";

// 按请求分派的假模型：压缩摘要、复盘、干活的请求各走各的剧本
export function routedModel(input: {
  main?: FakeReply[];
  review?: FakeReply[];
  reviewDelayMs?: number;
  // 第 N 次复盘请求直接失败（从 1 起）
  reviewFailOnCall?: number;
}): { streamFn: StreamFn; calls: LoggedCall[] } {
  const main = createFakeStreamFn({ replies: input.main ?? [{ text: "好了" }] });
  const review = createFakeStreamFn({
    replies: input.review ?? [{ text: "不改" }],
    ...(input.reviewFailOnCall !== undefined
      ? { failOnCall: input.reviewFailOnCall, failureMessage: "模拟复盘请求失败" }
      : {}),
  });
  const summary = createFakeStreamFn({ replies: [{ text: "## Goal\n摘要" }] });
  const calls: LoggedCall[] = [];
  const streamFn: StreamFn = async (model, context, options) => {
    const messages = structuredClone(context.messages) as unknown as LoggedCall["messages"];
    const kind = (context.systemPrompt ?? "").startsWith(SUMMARY_PROMPT_HEAD)
      ? "summary"
      : isReview(messages)
        ? "review"
        : "main";
    calls.push({ kind, provider: String(model.provider), model: model.id, messages });
    if (kind === "review" && input.reviewDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, input.reviewDelayMs));
    }
    return (kind === "summary" ? summary : kind === "review" ? review : main)(
      model,
      context,
      options
    );
  };
  return { streamFn, calls };
}

export function tempRoot(prefix: string): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// 建一个有一次提交的 git 仓库（.pigeon 被忽略，与日常项目一致）
export function initRepo(root: string, files: Record<string, string>): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
}

// 终端界面会话的句柄：再跑一次、落盘、按退出路径收尾
export interface TuiSessionHandle {
  sessionId: SessionId;
  run(task: string): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

// 开一个终端界面会话（与 tui/main.ts 同一套装配），可选地跑一次；resume 给出会话号即续开它（决策 183 的续跑）
export async function openTuiSession(input: {
  root: string;
  streamFn: StreamFn;
  task?: string;
  resume?: SessionId;
  reviewModel?: ReviewModelChoice;
  compaction?: CompactionConfigInput;
}): Promise<TuiSessionHandle> {
  const sessionId = input.resume ?? newSessionId();
  const opened = await openSessionRuntime({
    governanceRoot: input.root,
    sessionId,
    streamFn: input.streamFn,
    flags: {
      yolo: true,
      provider: "custom",
      modelId: "custom",
      persistThinking: true,
      pushedMemory: true,
      ...(input.reviewModel !== undefined ? { reviewModel: input.reviewModel } : {}),
      ...(input.compaction !== undefined ? { compaction: input.compaction } : {}),
    },
    homeDir: input.root,
    startMcp: noMcpSession,
    ...(input.resume !== undefined ? { resume: true } : {}),
  });
  const handle: TuiSessionHandle = {
    sessionId,
    run: async (task) => {
      await opened.bundle.adapter.run(task);
    },
    flush: () => opened.bundle.sessionStore.flush(),
    close: () =>
      closeTuiSession({
        governanceRoot: input.root,
        sessionId,
        bundle: opened.bundle,
        workerGraceMs: 0,
      }),
  };
  if (input.task !== undefined) {
    await handle.run(input.task);
  }
  return handle;
}

// 会话主分支上的条目（session-reader 口径，带 seq）
export function mainEntries(root: string, sessionId: string): StoredEntry[] {
  const located = locateSessionFile(sessionsDirOf(root), sessionId);
  if (located === undefined) {
    throw new Error(`会话 ${sessionId} 没有文件`);
  }
  const view = readSessionFile(located.path);
  if (view === undefined) {
    throw new Error(`会话 ${sessionId} 的文件读不出来`);
  }
  return branchEntries(view, view.lanes.get("main") ?? null);
}

export function customOf<T>(entries: readonly StoredEntry[], type: string): T[] {
  return entries
    .filter((entry) => entry.type === "custom" && entry.customType === type)
    .map((entry) => entry.data as T);
}

// 以 source 为父的复盘会话（会话号与其复盘那次 Run 的开始条目）
export function reviewsOf(
  root: string,
  source: string
): Array<{ sessionId: string; start: RunStartData; entries: StoredEntry[] }> {
  const found: Array<{ sessionId: string; start: RunStartData; entries: StoredEntry[] }> = [];
  for (const dir of listSessionFiles(sessionsDirOf(root)).map((file) => file.sessionId)) {
    const located = locateSessionFile(sessionsDirOf(root), dir);
    const view = located !== undefined ? readSessionFile(located.path) : undefined;
    if (view?.header.parentSessionId !== source) continue;
    const entries = branchEntries(view, view.lanes.get("main") ?? null);
    const start = customOf<RunStartData>(entries, "pigeon.run-start").find(
      (data) => data.memoryReview !== undefined
    );
    if (start !== undefined) found.push({ sessionId: dir, start, entries });
  }
  return found;
}
