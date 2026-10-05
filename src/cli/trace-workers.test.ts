// trace 的 worker 父子投影（M5.5 S4，决策 040）：父会话列出派出的 worker 与进入命令，未收尾如实标注，
// 孤立的收尾归异常项；worker 会话回指父会话。读新会话存储：派出与收尾是父会话里的 worker 条目，来历在子会话文件头。
// 主 agent 派 worker（264）的真实运行：spawn_worker 的调用与其他工具同样显示审批结果、出错归类与工具级分类。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { runHeadless } from "../application/headless-core.ts";
import { createFixtureSession, spawnFixtureWorker } from "../application/session-store-fixtures.ts";
import { isStatusText } from "../application/status-fixtures.ts";
import { createFakeStreamFn, type FakeStreamBehavior } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { runTraceCommand } from "./trace.ts";

test("trace：父会话列出 worker（已收尾给结果与进入命令、未收尾标注 resume 入口、孤立收尾归异常）；worker 会话回指父会话", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-workers-"));
  try {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const parent = createFixtureSession({ sessionsDir });
    parent.startRun({ task: "派活" });
    const done = spawnFixtureWorker(parent, { sessionsDir, name: "fix-a", task: "改" });
    done.startRun({ task: "改" });
    done.endRun();
    const { sessionId: doneId } = await done.close();
    parent.workerSettled({ childSessionId: doneId, name: "fix-a", turns: 2 });
    const hanging = spawnFixtureWorker(parent, { sessionsDir, name: "fix-b", task: "改" });
    const { sessionId: hangingId } = await hanging.close();
    const stray = newSessionId();
    parent.workerSettled({ childSessionId: stray, name: "ghost", status: "failed", turns: 0 });
    parent.endRun();
    const { sessionId: parentId } = await parent.close();

    const parentTrace = runTraceCommand({ root, sessionId: parentId });
    assert.ok(parentTrace.includes("派出的 worker（2）："), parentTrace);
    assert.ok(
      parentTrace.includes(
        `  fix-a（implementer）｜ 会话 ${doneId.slice(0, 13)}… ｜ completed ｜ 2 轮 ｜ 改动 0 个文件 ｜ 进入：trace ${doneId}`
      ),
      parentTrace
    );
    assert.ok(
      parentTrace.includes(
        `未收尾：有派出无收尾（进程中断可能；用 resume ${hangingId} 进入该 worker 会话）`
      ),
      parentTrace
    );
    assert.ok(
      parentTrace.includes(`  孤立的 worker 收尾：ghost（会话 ${stray.slice(0, 13)}…）无对应派出`),
      parentTrace
    );
    assert.ok(!parentTrace.includes("Receipt"), parentTrace);

    const workerTrace = runTraceCommand({ root, sessionId: doneId });
    assert.ok(
      workerTrace.includes(
        `worker 会话：fix-a（implementer）｜ 分支 fix-a ｜ 父会话 ${parentId}（查看：trace ${parentId}）`
      ),
      workerTrace
    );
    assert.equal(workerTrace.includes("派出的 worker"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

// 有一个提交的 git 仓库（worker 从当前提交开工）；.pigeon/ 不进版本
function initRepo(root: string, files: Record<string, string>): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(root, file), content);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
}

// 按会话的第一条人输入的用户消息分派剧本：主会话与 worker 各走各的回复队列
function firstUserText(context: Parameters<StreamFn>[1]): string {
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as Array<{ type: string; text?: string }>)
              .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
              .join("")
          : "";
    // 决策 363：开工状态块不是会话的第一条输入
    if (!isStatusText(text)) return text;
  }
  return "";
}

function routed(scripts: Array<[marker: string, behavior: FakeStreamBehavior]>): StreamFn {
  const fns = scripts.map(([marker, behavior]) => [marker, createFakeStreamFn(behavior)] as const);
  return ((model, context, options) => {
    const text = firstUserText(context);
    const match = fns.find(([marker]) => text.includes(marker));
    if (match === undefined) throw new Error(`没有剧本：${text}`);
    return match[1](model, context, options);
  }) as StreamFn;
}

// 报告里各次工具调用（按出现顺序）：工具名与名下的审批、出错归类、分类三行
function toolCallVerdicts(output: string): Array<{ tool: string; lines: string[] }> {
  const calls: Array<{ tool: string; lines: string[] }> = [];
  for (const line of output.split("\n")) {
    const head = /^ {4}工具调用 \S+ \[(.+)\]$/.exec(line);
    if (head !== null) {
      calls.push({ tool: head[1] ?? "", lines: [] });
      continue;
    }
    const last = calls.at(-1);
    if (last === undefined || !line.startsWith("      ")) continue;
    const trimmed = line.trim();
    if (/^(审批|出错归类|分类)：/.test(trimmed)) last.lines.push(trimmed);
  }
  return calls;
}

test("trace（真实运行）：主 agent 派 worker 的会话——spawn_worker 的调用照常显示审批结果（只读档，策略自动放行）与出错归类，分类与其他工具同一口径（做成为正常、上游拦截为业务失败），不落进未知或无；worker 会话自己的调用同样有审批与分类", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-spawn-"));
  try {
    initRepo(root, { "a.txt": "a\n" });
    // 无人值守的 prompt 模式（不是 yolo）：只读档的调用由策略自动放行，spawn_worker 与 read_file 同样不经人批
    const result = await runHeadless({
      task: "MAIN 派两个",
      governanceRoot: root,
      workspaceRoot: root,
      yolo: false,
      spawnWorkers: true,
      streamFn: routed([
        [
          "MAIN",
          {
            replies: [
              {
                text: "派",
                toolCalls: [
                  {
                    name: "spawn_worker",
                    args: { role: "explorer", task: "WORKER 看一眼", name: "reader" },
                  },
                  // 角色写错：上游的参数校验先拒绝，没到审批闸
                  {
                    name: "spawn_worker",
                    args: { role: "janitor", task: "WORKER 扫地", name: "sweeper" },
                  },
                ],
              },
              { text: "收到" },
            ],
          },
        ],
        [
          "WORKER",
          {
            replies: [
              { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
              { text: "看过了" },
            ],
          },
        ],
      ]),
    });
    assert.equal(result.status, "completed");
    const parentTrace = runTraceCommand({ root, sessionId: result.sessionId });
    assert.ok(parentTrace.includes("派出的 worker（1）："), parentTrace);
    assert.match(parentTrace, /^ {2}reader（explorer）｜ 会话 \S+ ｜ completed ｜ /m);
    assert.deepEqual(
      toolCallVerdicts(parentTrace),
      [
        { tool: "spawn_worker", lines: ["审批：策略自动放行（policy:auto）", "分类：正常"] },
        {
          tool: "spawn_worker",
          lines: ["审批：未经审批闸（上游拦截）", "出错归类：域错误", "分类：业务失败"],
        },
      ],
      parentTrace
    );
    assert.ok(!parentTrace.includes("分类：未知"), parentTrace);
    assert.ok(!parentTrace.includes("分类：无（"), parentTrace);
    const workerId = /进入：trace (\S+)/.exec(parentTrace)?.[1];
    assert.ok(workerId !== undefined, parentTrace);
    const workerTrace = runTraceCommand({ root, sessionId: workerId });
    // 决策 377：只读的 explorer 不建工作树
    assert.match(
      workerTrace,
      /^worker 会话：reader（explorer）｜ 只读派出方工作区（不建工作树） ｜ 父会话 /m
    );
    assert.deepEqual(
      toolCallVerdicts(workerTrace),
      [{ tool: "read_file", lines: ["审批：策略自动放行（policy:auto）", "分类：正常"] }],
      workerTrace
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
