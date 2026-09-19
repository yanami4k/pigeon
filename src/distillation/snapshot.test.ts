// 提炼器输入（M7 S4，决策 076）与只读工具作用域（决策 074）：
// - 沿用 M6 单条正文截断；每侧上限 24,000 字符、共享前缀 12,000 字符，超出从最早处丢弃并标注；
// - 任务描述只喂一次（两侧的第 1 条是同一任务，不重复）；分叉场景以分叉点为界，共享前缀只喂一次；
// - 独立尝试不做分歧步对齐：两侧按各自条目号原样列出；
// - Run 内局部对（人写拒绝、域错误后成功重试）单列；
// - distill_entry 只能读这一组尝试范围内的条目，范围外与其他会话一律读不到。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { DISTILL_ENTRY_TOOL, type DistillTarget } from "../state/distill.ts";
import {
  newEntryId,
  newExecutionId,
  newRunId,
  newSessionId,
  type RunId,
  type SessionId,
} from "../state/ids.ts";
import {
  buildDistillSnapshot,
  DISTILL_PREFIX_MAX_CHARS,
  DISTILL_SIDE_MAX_CHARS,
  renderDistillSnapshot,
} from "./snapshot.ts";
import { createDistillTools } from "./tools.ts";

type Message = {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

function writeAttempt(
  root: string,
  messages: Message[],
  extra?: (log: JsonlEventLog, runId: RunId) => void
): { sessionId: SessionId; runId: RunId } {
  const sessionId = newSessionId();
  const runId = newRunId();
  const log = new JsonlEventLog(join(root, ".pigeon", "sessions"), sessionId);
  for (const [index, message] of messages.entries()) {
    log.appendEntry({ runSeq: index + 1, role: message.role as "user", runId, message });
  }
  extra?.(log, runId);
  log.close();
  return { sessionId, runId };
}

const user = (text: string): Message => ({ role: "user", content: text });
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolResult = (toolCallId: string, text: string, isError = false): Message => ({
  role: "toolResult",
  toolCallId,
  toolName: "edit_file",
  isError,
  content: [{ type: "text", text }],
});

test("同任务：任务描述只出现一次；两侧按各自条目号原样列出（不做分歧步对齐）；标签与范围标注在侧头", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-snap-"));
  try {
    const task = "把 add 函数的溢出问题修好并跑测试";
    const ok = writeAttempt(root, [user(task), assistant("先读 add.ts"), assistant("测试通过")]);
    const bad = writeAttempt(root, [user(task), assistant("直接改了，没跑测试")]);
    const target: DistillTarget = {
      kind: "task",
      taskKey: "task_01",
      task: { governanceRoot: root, ...ok },
      successful: { governanceRoot: root, ...ok, from: 1, to: 3, label: "Passed" },
      failed: { governanceRoot: root, ...bad, from: 1, to: 2, label: "Failed" },
      others: [],
    };
    const text = renderDistillSnapshot(buildDistillSnapshot(target));
    assert.equal(text.split(task).length - 1, 1, "任务描述只喂一次");
    assert.ok(text.includes("先读 add.ts") && text.includes("直接改了，没跑测试"), text);
    assert.ok(text.includes("成功侧") && text.includes("Passed"), text);
    assert.ok(text.includes("失败侧") && text.includes("Failed"), text);
    assert.ok(text.includes("[第 3 条 assistant]"), "条目号按各侧原样保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("每侧上限 24,000 字符：超出从最早处整条丢弃并标注省略条数与字符数；单条沿用 M6 头尾截断", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-cap-"));
  try {
    const long = (label: string) => `${label}${"x".repeat(1_990)}`;
    const messages = [user("任务")];
    for (let index = 0; index < 30; index++) {
      messages.push(assistant(long(`第${index}段`)));
    }
    messages.push(assistant("y".repeat(5_000)));
    const attempt = writeAttempt(root, messages);
    const snapshot = buildDistillSnapshot({
      kind: "task",
      task: { governanceRoot: root, ...attempt },
      failed: { governanceRoot: root, ...attempt, from: 1, to: messages.length, label: "Failed" },
      others: [],
    });
    const side = snapshot.failed;
    assert.ok(side !== undefined);
    const total = side.entries.reduce((sum, entry) => sum + entry.text.length, 0);
    assert.ok(total <= DISTILL_SIDE_MAX_CHARS, String(total));
    assert.ok(side.omittedEntries > 0);
    assert.equal(side.entries[0]?.text.startsWith("第0段"), false, "最早的条目先被丢弃");
    assert.equal(side.entries.at(-1)?.truncated, true, "单条超限头尾截断");
    const text = renderDistillSnapshot(snapshot);
    assert.ok(text.includes(`最早的 ${side.omittedEntries} 条已省略`), text.slice(0, 400));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 决策 076 修订：共享前缀单独设 12,000 字符上限（两侧仍各 24,000）
test("共享前缀上限 12,000 字符：超出从最早处整条丢弃并标注、可按条目号回查；两侧上限不受影响", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-prefix-cap-"));
  try {
    const long = (label: string) => `${label}${"x".repeat(1_990)}`;
    // 前缀 20 条（约 40,000 字符），分叉点之后来源侧再 20 条（同样约 40,000）
    const messages = [user("任务")];
    for (let index = 0; index < 20; index++) {
      messages.push(assistant(long(`前缀${index}段`)));
    }
    for (let index = 0; index < 20; index++) {
      messages.push(assistant(long(`来源${index}段`)));
    }
    const source = writeAttempt(root, messages);
    const branch = writeAttempt(root, [assistant("分支很短")]);
    const snapshot = buildDistillSnapshot({
      kind: "fork",
      task: { governanceRoot: root, ...source },
      sharedPrefix: { governanceRoot: root, ...source, from: 1, to: 21 },
      failed: {
        governanceRoot: root,
        ...source,
        from: 22,
        to: messages.length,
        label: "Failed",
      },
      successful: { governanceRoot: root, ...branch, from: 1, to: 1, label: "Passed" },
      others: [],
    });
    const prefix = snapshot.prefix;
    assert.ok(prefix !== undefined);
    const prefixChars = prefix.entries.reduce((sum, entry) => sum + entry.text.length, 0);
    assert.ok(prefixChars <= DISTILL_PREFIX_MAX_CHARS, `前缀 ${prefixChars} 字符`);
    assert.ok(prefix.omittedEntries > 0, "超出部分从最早处整条丢弃");
    assert.equal(prefix.entries[0]?.text.startsWith("前缀0段"), false, "最早的先丢");
    const text = renderDistillSnapshot(snapshot);
    assert.ok(text.includes(`最早的 ${prefix.omittedEntries} 条已省略`), text.slice(0, 400));
    assert.ok(text.includes(DISTILL_ENTRY_TOOL), "省略处标注可按条目号回查");
    // 两侧仍按 24,000：来源侧留下的字符数明显多于前缀上限
    const failedChars = (snapshot.failed?.entries ?? []).reduce(
      (sum, entry) => sum + entry.text.length,
      0
    );
    assert.ok(failedChars <= DISTILL_SIDE_MAX_CHARS, `失败侧 ${failedChars} 字符`);
    assert.ok(failedChars > DISTILL_PREFIX_MAX_CHARS, `失败侧不受前缀上限影响：${failedChars}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("分叉：共享前缀只喂一次，来源侧从分叉点之后开始，分支侧从第 1 条开始", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-fork-"));
  try {
    const source = writeAttempt(root, [
      user("修复构建"),
      assistant("共享的第一步：读配置"),
      assistant("来源走岔：删掉了锁文件"),
    ]);
    const branch = writeAttempt(root, [assistant("分支：改用 npm ci")]);
    const text = renderDistillSnapshot(
      buildDistillSnapshot({
        kind: "fork",
        task: { governanceRoot: root, ...source },
        sharedPrefix: { governanceRoot: root, ...source, from: 1, to: 2 },
        failed: { governanceRoot: root, ...source, from: 3, to: 3, label: "Failed" },
        successful: { governanceRoot: root, ...branch, from: 1, to: 1, label: "Passed" },
        others: [],
      })
    );
    assert.equal(text.split("共享的第一步：读配置").length - 1, 1, "共享前缀只喂一次");
    assert.equal(text.split("修复构建").length - 1, 1, "任务描述只喂一次");
    assert.ok(text.includes("来源走岔：删掉了锁文件") && text.includes("分支：改用 npm ci"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Run 内局部对单列：人写拒绝理由与域错误后紧跟的成功重试", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-local-"));
  try {
    const attempt = writeAttempt(
      root,
      [
        user("任务"),
        assistant("改生成文件"),
        toolResult("tc-rej", "拒绝：别改生成文件", true),
        assistant("改源模板"),
        toolResult("tc-bad", "锚点不对", true),
        assistant("重试"),
        toolResult("tc-good", "已编辑"),
      ],
      (log, runId) => {
        log.appendDecision({
          runId,
          executionId: newExecutionId(),
          toolCallId: "tc-rej",
          toolName: "edit_file",
          rawArgs: {},
          decision: {
            outcome: "rejected",
            approvedBy: "human",
            decidedAt: 1,
            reason: "别改生成文件，改源模板",
            reasonSource: "human",
          },
          at: 1,
        });
        for (const [id, isError] of [
          ["tc-bad", true],
          ["tc-good", false],
        ] as const) {
          log.appendRuntimeEvent({
            version: 1,
            id: newEntryId(),
            sessionId: log.sessionId,
            runId,
            timestamp: 1,
            kind: "tool.settled",
            payload: {
              toolCallId: id,
              toolName: "edit_file",
              isError,
              ...(isError ? { errorKind: "domain" } : {}),
            },
          } as never);
        }
      }
    );
    const text = renderDistillSnapshot(
      buildDistillSnapshot({
        kind: "task",
        task: { governanceRoot: root, ...attempt },
        failed: { governanceRoot: root, ...attempt, from: 1, to: 7, label: "Failed" },
        others: [],
      })
    );
    assert.ok(text.includes("Run 内局部对"), text);
    assert.ok(text.includes("别改生成文件，改源模板"), text);
    assert.ok(text.includes("第 5 条") && text.includes("第 7 条"), text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("distill_entry 作用域：只读这组尝试范围内的条目；范围外与未纳入的会话读不到；快照首读后冻结", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-tools-"));
  try {
    const attempt = writeAttempt(root, [user("任务"), assistant("第二条"), assistant("第三条")]);
    const outsider = writeAttempt(root, [user("别的会话")]);
    const [snapshotTool, entryTool] = createDistillTools({
      kind: "task",
      task: { governanceRoot: root, ...attempt },
      failed: { governanceRoot: root, ...attempt, from: 1, to: 2, label: "Failed" },
      others: [],
    });
    assert.ok(snapshotTool !== undefined && entryTool !== undefined);
    const first = await snapshotTool.execute("c1", {});
    const again = await snapshotTool.execute("c2", {});
    assert.deepEqual(first.content, again.content);
    const read = await entryTool.execute("c3", { side: "failed", runSeq: 2 });
    assert.ok(JSON.stringify(read.content).includes("第二条"));
    await assert.rejects(() => entryTool.execute("c4", { side: "failed", runSeq: 3 }), /范围/);
    await assert.rejects(() => entryTool.execute("c5", { side: "successful", runSeq: 1 }), /没有/);
    await assert.rejects(() =>
      entryTool.execute("c6", { side: "failed", runSeq: 1, sessionId: outsider.sessionId } as never)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
