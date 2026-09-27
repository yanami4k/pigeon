// M4 S4：CLI replay 命令（只读黑匣子时间线，D4 一次性渲染）测试——读新会话存储（决策 180 / 181）。
// 运行头终态（结束方式）+ 四分类、逐条时间戳 / 条目类型 / 关键字段按会话文件里的顺序、七种自定义条目原位呈现、
// 崩溃残留如实标注、只读性（读正被写入的文件不改文件）、响亮失败列出可选项、子进程端到端。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { shortId } from "../application/format.ts";
import { createToolGovernance } from "../application/governance.ts";
import {
  createFixtureSession,
  forkFixture,
  spawnFixtureWorker,
  tearTail,
} from "../application/session-store-fixtures.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { openSessionStoreWriter } from "../pi-runtime/session-store.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import { newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { runReplayCommand } from "./replay.ts";

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "读取工作区内文件内容",
    parameters: Type.Object({ path: Type.String() }),
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "parallel",
  });
  registry.register({
    name: "edit_file",
    description: "hashline 锚定稀疏编辑",
    parameters: Type.Object({}),
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  return registry;
}

function editCall(content: string): EditFileParams {
  return {
    path: "a.ts",
    snapshot: snapshotTag(content),
    edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
  };
}

// 经真实 Adapter 跑一次（写进会话存储）：读、改（批准）、再改（人工拒绝）、收尾
async function scriptSession(root: string): Promise<{ sessionId: SessionId; runId: RunId }> {
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  const store = openSessionStoreWriter({
    sessionsRoot: sessionsDir,
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
  });
  let edits = 0;
  const adapter = new PiRuntimeAdapter({
    snapshot: {
      version: INJECTION_SNAPSHOT_VERSION,
      model: { provider: "fake-provider", id: "fake-model-1" },
      tools: {
        policy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" },
        advertised: [],
      },
      context: { systemPrompt: "你是 Pigeon 测试助手。" },
      memory: [],
      skills: [],
      createdAt: 1700000000000,
    },
    streamFn: createFakeStreamFn({
      replies: [
        { text: "先读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
        {
          text: "再改",
          toolCalls: [{ name: "edit_file", args: editCall("alpha\nbeta\ngamma\n") }],
        },
        {
          text: "继续改",
          toolCalls: [{ name: "edit_file", args: editCall("alpha\nbeta\ngamma\n") }],
        },
        { text: "完成" },
      ],
    }),
    governance: createToolGovernance({
      registry: makeRegistry(),
      approvalHandler: async ({ toolName }) => {
        if (toolName === "edit_file") {
          edits += 1;
          return edits === 1 ? { approved: true } : { approved: false, reason: "先别动这个文件" };
        }
        return { approved: true };
      },
    }),
    tools: [createReadFileTool(root), createEditFileTool(root)],
    sessionId,
    sessionStore: store,
  });
  const result = await adapter.run("改文件");
  await adapter.dispose();
  await store.close();
  return { sessionId, runId: result.runId };
}

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replay-cli-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const TIMELINE = /^\d{2}:\d{2}:\d{2}\.\d{3} /;

test("replay 报告（真实运行）：运行头终态与分类，时间线按会话文件顺序，每个条目恰好一行", () =>
  withRoot(async (root) => {
    const { sessionId, runId } = await scriptSession(root);
    const output = runReplayCommand({ root, runId, sessionId });
    const run = loadSessionView(join(root, ".pigeon", "sessions"), sessionId)?.runs[0];
    assert.ok(run !== undefined);
    const lines = output.split("\n");
    assert.equal(
      lines[0],
      `回放 Run ${shortId(runId)} ｜ 会话 ${shortId(sessionId)} ｜ 条目 ${run.items.length} 条 ｜ ` +
        "终态：结束方式 completed，stopReason=stop ｜ 分类：正常"
    );
    const timeline = lines.filter((line) => TIMELINE.test(line));
    assert.equal(timeline.length, run.items.length, "每个条目恰好在时间线出现一次");
    const kinds = timeline.map((line) => line.split(" ")[1]);
    assert.deepEqual(kinds, [
      "pigeon.run-start",
      ...Array.from({ length: 8 }, () => "message"),
      "pigeon.run-end",
    ]);
    assert.ok(timeline[0]?.includes("Run 启动快照 ｜ 模型 fake-provider/fake-model-1"), output);
    const [first, second, third] = run.messages;
    assert.ok(
      timeline[1]?.endsWith(`｜ 消息 ${first?.entryId}：run 内第 1 条（user）`),
      timeline[1]
    );
    assert.ok(
      timeline[2]?.endsWith(
        `｜ 消息 ${second?.entryId}：run 内第 2 条（assistant） ｜ stopReason=toolUse ｜ 工具调用 read_file（tc-1-1）参数 {"path":"a.ts"}`
      ),
      timeline[2]
    );
    assert.ok(
      timeline[3]?.endsWith(
        `｜ 消息 ${third?.entryId}：run 内第 3 条（toolResult） ｜ 工具结果 read_file（tc-1-1）成功`
      ),
      timeline[3]
    );
    assert.ok(timeline[7]?.endsWith("工具结果 edit_file（tc-3-1）失败"), timeline[7]);
    assert.ok(
      timeline
        .at(-1)
        ?.endsWith("｜ Run 收尾 ｜ 结束方式 completed ｜ 新增消息 8 条 ｜ stopReason=stop"),
      timeline.at(-1)
    );
    for (const retired of ["Receipt", "意图落账", "待对账", "entry 映射"]) {
      assert.ok(!output.includes(retired), `不应再出现"${retired}"\n${output}`);
    }
  }));

test("replay 报告：七种自定义条目原位呈现（快照、验证、worker、分叉、授权、收尾）", () =>
  withRoot(async (root) => {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const session = createFixtureSession({ sessionsDir, cwd: root });
    const runId = session.startRun({ task: "改" });
    session.toolTurn({ name: "edit_file", checkpoint: true });
    const grantId = session.grantCreated({ tool: "edit_file", pathPrefix: "src/" });
    session.grantRevoked(grantId);
    const worker = spawnFixtureWorker(session, { sessionsDir, name: "impl-1", task: "子任务" });
    const { sessionId: childId } = await worker.close();
    session.workerSettled({ childSessionId: childId, name: "impl-1", turns: 3 });
    session.endRun({ ending: "wall-clock-limit", stopReason: "aborted" });
    session.verification({ verdict: "pass" });
    const { sessionId } = await session.close();
    const branch = await forkFixture({ sessionsDir, sourceSessionId: sessionId, runId, runSeq: 2 });
    await branch.close();

    const output = runReplayCommand({ root, runId, sessionId });
    const timeline = output.split("\n").filter((line) => TIMELINE.test(line));
    const detail = (kind: string) =>
      timeline
        .filter((line) => line.split(" ")[1] === kind)
        .map((line) => line.split(" ｜ ").slice(1).join(" ｜ "));
    assert.deepEqual(detail("pigeon.checkpoint"), [
      `工作区快照 ${"a".repeat(12)} ｜ 工具调用 tc-1`,
    ]);
    assert.deepEqual(detail("pigeon.grant"), [
      `放权创建 ${shortId(grantId)} ｜ edit_file，仅限目录 src/ ｜ 首调 tc-grant`,
      `放权撤销 ${shortId(grantId)}`,
    ]);
    assert.deepEqual(detail("pigeon.worker"), [
      `派出 worker impl-1（implementer）｜ 会话 ${shortId(childId)} ｜ 分支 impl-1 ｜ 工具 read_file、edit_file ｜ 审批模式 yolo ｜ 上限 20 轮 / 600 秒`,
      `worker 收尾 impl-1 ｜ 会话 ${shortId(childId)} ｜ completed ｜ 3 轮 ｜ 改动 0 个文件`,
    ]);
    assert.deepEqual(detail("pigeon.run-end"), [
      "Run 收尾 ｜ 结束方式 wall-clock-limit ｜ 新增消息 3 条 ｜ stopReason=aborted",
    ]);
    assert.deepEqual(detail("pigeon.verification"), [
      `尝试验证 ｜ 会话 ${shortId(sessionId)} Run ${shortId(runId)} ｜ 通过 ｜ 退出码 0 ｜ 命令 npm test ｜ 10 毫秒`,
    ]);
    assert.equal(detail("pigeon.fork").length, 1);
    assert.match(
      detail("pigeon.fork")[0] ?? "",
      new RegExp(`^分叉 ｜ 分叉点 Run ${shortId(runId)} 第 2 条 ｜ 分支会话 `)
    );
    assert.match(
      output.split("\n")[0] ?? "",
      /终态：结束方式 wall-clock-limit，stopReason=aborted ｜ 分类：取消/
    );
  }));

test("replay 报告：有开始无收尾的 Run 标注「记录到此中断」+ 未知分类", () =>
  withRoot(async (root) => {
    const session = createFixtureSession({ sessionsDir: join(root, ".pigeon", "sessions") });
    const runId = session.startRun({ task: "改" });
    session.assistant({ toolCalls: [{ name: "edit_file" }] });
    const { sessionId } = await session.close();
    const output = runReplayCommand({ root, runId, sessionId });
    assert.match(output.split("\n")[0] ?? "", /终态：Run 收尾缺失 ｜ 分类：未知$/);
    assert.ok(output.endsWith("记录到此中断（崩溃可能）：本 Run 无收尾条目\n"), output);
  }));

test("replay 命令只读：正被写入（末行撕裂）的会话照常回放，会话文件字节、目录清单与工作区均不变", () =>
  withRoot(async (root) => {
    const { sessionId, runId } = await scriptSession(root);
    const sessionsDir = join(root, ".pigeon", "sessions");
    const files = readdirSync(sessionsDir, { recursive: true })
      .map((file) => join(sessionsDir, String(file)))
      .filter((path) => path.endsWith(".jsonl"));
    const current = files.find((path) => path.includes(`_${sessionId}.jsonl`));
    assert.ok(current !== undefined);
    tearTail(current);
    const snapshot = () => files.map((path) => readFileSync(path, "utf8"));
    const before = snapshot();
    const listing = readdirSync(sessionsDir, { recursive: true });
    const first = runReplayCommand({ root, runId, sessionId, withContent: true });
    assert.equal(runReplayCommand({ root, runId, sessionId, withContent: true }), first);
    assert.deepEqual(snapshot(), before, "会话文件字节不得变化");
    assert.deepEqual(readdirSync(sessionsDir, { recursive: true }), listing);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");
  }));

test("replay 命令：未知 Run/会话响亮失败并列出可选项；--session 定位与跨会话扫描；歧义要求消歧", () =>
  withRoot(async (root) => {
    const { sessionId, runId } = await scriptSession(root);
    const sessionsDir = join(root, ".pigeon", "sessions");

    assert.throws(
      () => runReplayCommand({ root, runId, sessionId: newSessionId() }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("会话不存在"));
        assert.ok(error.message.includes(sessionId), "必须列出已有会话帮助定位");
        return true;
      }
    );
    assert.throws(
      () => runReplayCommand({ root, runId: newRunId(), sessionId }),
      new RegExp(`该会话无 Run .*。已有 Run：${runId}`)
    );
    assert.throws(
      () => runReplayCommand({ root, runId: newRunId() }),
      new RegExp(`Run 不存在：.*。已有 Run：${runId}（会话 ${sessionId}）`)
    );
    assert.ok(runReplayCommand({ root, runId }).includes("回放 Run"), "跨会话扫描定位并渲染");

    const other = createFixtureSession({ sessionsDir });
    other.startRun({ runId, task: "同号" });
    const { sessionId: otherId } = await other.close();
    assert.throws(
      () => runReplayCommand({ root, runId }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("多个会话"), "跨会话歧义必须响亮失败");
        assert.ok(error.message.includes("--session"), "必须提示消歧手段");
        return true;
      }
    );
    assert.ok(runReplayCommand({ root, runId, sessionId: otherId }).includes("回放 Run"));
  }));

test("replay 子进程端到端：无 streamFn 也能回放（分流在模型接入检查之前）", () =>
  withRoot(async (root) => {
    const { sessionId, runId } = await scriptSession(root);
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const env = { ...process.env };
    delete env.PIGEON_STREAM_FN;
    const cliEntry = fileURLToPath(new URL("./index.ts", import.meta.url));
    const ok = spawnSync(process.execPath, [cliEntry, "replay", runId, "--root", root], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(ok.status, 0, `回放应成功退出：${ok.stderr}`);
    assert.ok(ok.stdout.includes("回放 Run"), "子进程输出时间线报告");
    assert.ok(ok.stdout.includes(shortId(sessionId)), "报告含会话短哈希");

    const missing = spawnSync(process.execPath, [cliEntry, "replay", newRunId(), "--root", root], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.notEqual(missing.status, 0, "未知 Run 必须失败退出");
    assert.ok(missing.stderr.includes("Run 不存在"));
    assert.ok(missing.stderr.includes(runId), "报错列出已有 Run 帮助定位");
  }));
