// M4 S5：Session 列表投影测试（D5：派生不落库——每次从会话文件现算，不写任何文件；默认安静：创建时间 + Run 数）。
// 读新会话存储：逐会话摘要字段（ULID 创建时间 / Run 数 / 工具名 / Run 级与工具级失败分类 / 用量 / 父子关系）、
// 最小过滤器（tool / class / since / until）、排序、只读（读正被写入的文件不改文件）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFixtureSession,
  type FixtureSession,
  spawnFixtureWorker,
  tearTail,
} from "../application/session-store-fixtures.ts";
import { asSessionId, newSessionId, type SessionId } from "../state/ids.ts";
import { sessionCreatedAt } from "../state/session-summary.ts";
import { listSessionSummaries } from "./session-list.ts";

function makeDir(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-list-"));
  return {
    dir: join(root, ".pigeon", "state", "sessions"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function seed(
  dir: string,
  write: (session: FixtureSession) => void,
  sessionId: SessionId = newSessionId()
): Promise<SessionId> {
  const session = createFixtureSession({ sessionsDir: dir, sessionId });
  write(session);
  await session.close();
  return sessionId;
}

// 手工编码 ULID 时间分量（与 ids.ts 同字母表）：伪造指定创建时刻的会话 id 供时间过滤测试
function fakeSessionIdAt(timeMs: number): SessionId {
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = timeMs;
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD.charAt(time % 32) + head;
    time = Math.floor(time / 32);
  }
  return asSessionId(`sess_${head}0000000000000000`);
}

test("会话摘要：创建时间取自 ULID、Run 数、工具名、失败分类与用量逐会话现算", async () => {
  const { dir, cleanup } = makeDir();
  try {
    const healthy = await seed(dir, (s) => {
      s.startRun({ task: "改 a" });
      s.toolTurn({ name: "edit_file" });
      s.toolTurn({ name: "read_file" });
      s.toolTurn({ name: "edit_file" });
      s.assistant({
        text: "好了",
        usage: { totalTokens: 120, cost: { ...zeroCost(), total: 0.5 } },
      });
      s.endRun();
    });
    const crashed = await seed(dir, (s) => {
      s.startRun({ task: "读 b" });
      s.toolTurn({ name: "read_file" });
    });

    const summaries = listSessionSummaries(dir);
    assert.equal(summaries.length, 2);
    const [first, second] = summaries;
    // 列表序 = 创建时间序（先建在前）
    assert.equal(first?.sessionId, healthy);
    assert.equal(second?.sessionId, crashed);
    assert.equal(first?.createdAt, sessionCreatedAt(healthy));
    assert.equal(first?.runCount, 1);
    assert.deepEqual(first?.toolNames, ["edit_file", "read_file"]);
    assert.deepEqual(first?.failureClasses, []);
    assert.equal(first?.totalTokens, 120);
    assert.equal(first?.totalCost, 0.5);
    assert.equal("pendingReconcile" in (first ?? {}), false);
    // 崩溃残留：有 Run 开始无收尾 → Run 落未知桶
    assert.equal(second?.runCount, 1);
    assert.deepEqual(second?.toolNames, ["read_file"]);
    assert.deepEqual(second?.failureClasses, ["unknown"]);
  } finally {
    cleanup();
  }
});

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

test("sessionCreatedAt：解码 SessionId 内嵌 ULID 的 48 位毫秒时间（与 ids.ts 编码互逆）", () => {
  const known = fakeSessionIdAt(1_757_000_000_000);
  assert.equal(sessionCreatedAt(known), 1_757_000_000_000);
  assert.ok(Math.abs(sessionCreatedAt(newSessionId()) - Date.now()) < 60_000);
});

test("Run 级失败分类：取消、熔断、业务（输出截断）、基础设施（上游合成失败消息）、未知分别入列；正常收尾不入列", async () => {
  const { dir, cleanup } = makeDir();
  try {
    const run = (ending: Parameters<FixtureSession["endRun"]>[0], stop?: string, error?: string) =>
      seed(dir, (s) => {
        s.startRun({ task: "t" });
        s.assistant({
          text: stop === "error" ? "" : "回复",
          ...(stop !== undefined ? { stopReason: stop } : {}),
          ...(error !== undefined ? { errorMessage: error } : {}),
        });
        s.endRun(ending);
      });
    const aborted = await run({ ending: "aborted" }, "aborted");
    const turnLimit = await run({ ending: "turn-limit" }, "aborted");
    const breaker = await run({ ending: "breaker" }, "aborted");
    const length = await run({ ending: "completed" }, "length");
    const synthetic = await run({ ending: "error" }, "error", "provider 故障");
    const plainError = await run({ ending: "error" }, "error");
    const normal = await run({ ending: "completed" }, "stop");

    const classes = new Map(
      listSessionSummaries(dir).map((summary) => [summary.sessionId, summary.failureClasses])
    );
    assert.deepEqual(classes.get(aborted), ["cancelled"]);
    assert.deepEqual(classes.get(turnLimit), ["cancelled"]);
    assert.deepEqual(classes.get(breaker), ["cancelled"]);
    assert.deepEqual(classes.get(length), ["business"]);
    assert.deepEqual(classes.get(synthetic), ["infrastructure"]);
    assert.deepEqual(classes.get(plainError), ["unknown"]);
    assert.deepEqual(classes.get(normal), []);
  } finally {
    cleanup();
  }
});

test("worker 父子关系：子会话摘要回指父会话，父会话计派出数与未收尾数", async () => {
  const { dir, cleanup } = makeDir();
  try {
    const parent = createFixtureSession({ sessionsDir: dir });
    parent.startRun({ task: "派两个 worker" });
    const done = spawnFixtureWorker(parent, { sessionsDir: dir, name: "impl-1", task: "a" });
    done.startRun({ task: "a" });
    done.endRun();
    const { sessionId: doneId } = await done.close();
    parent.workerSettled({ childSessionId: doneId, name: "impl-1" });
    const pending = spawnFixtureWorker(parent, { sessionsDir: dir, name: "impl-2", task: "b" });
    await pending.close();
    parent.endRun();
    const { sessionId: parentId } = await parent.close();

    const byId = new Map(listSessionSummaries(dir).map((summary) => [summary.sessionId, summary]));
    assert.deepEqual(byId.get(parentId)?.children, { count: 2, unsettled: 1 });
    assert.deepEqual(byId.get(doneId)?.worker, {
      name: "impl-1",
      role: "implementer",
      parentSessionId: parentId,
    });
  } finally {
    cleanup();
  }
});

// 工具级失败分类（账本重构第二段的现算口径：工具结果消息上的运行面标记，没有标记时按消息正文与策略）并入摘要，
// 接在 Run 级之后按出现序去重；--class 据此过滤。三个会话的 Run 都正常收尾，Run 级没有分类
test("摘要含工具级失败分类：环境异常、上游拦截计入，审批闸拒绝不计；--class 按它过滤", async () => {
  const { dir, cleanup } = makeDir();
  try {
    const toolCall = (s: FixtureSession, name: string): string => {
      const [id = ""] = s.assistant({ toolCalls: [{ name }] });
      return id;
    };
    const environment = await seed(dir, (s) => {
      s.startRun({ task: "a" });
      s.toolResult({
        toolCallId: toolCall(s, "edit_file"),
        toolName: "edit_file",
        text: "EACCES",
        isError: true,
        details: {
          pigeon: {
            errorKind: "environment",
            gate: { outcome: "approved", approvedBy: "policy:yolo" },
          },
        },
      });
      s.assistant({ text: "改不了" });
      s.endRun();
    });
    const intercepted = await seed(dir, (s) => {
      s.startRun({ task: "b" });
      s.toolResult({
        toolCallId: toolCall(s, "ghost"),
        toolName: "ghost",
        text: "Tool ghost not found",
        isError: true,
      });
      s.assistant({ text: "没有这个工具" });
      s.endRun();
    });
    const rejected = await seed(dir, (s) => {
      s.startRun({ task: "c" });
      s.toolResult({
        toolCallId: toolCall(s, "edit_file"),
        toolName: "edit_file",
        text: "用户拒绝",
        isError: true,
        details: { pigeon: { gate: { outcome: "rejected", approvedBy: "human" } } },
      });
      s.assistant({ text: "好的" });
      s.endRun();
    });
    const classes = new Map(
      listSessionSummaries(dir).map((summary) => [summary.sessionId, summary.failureClasses])
    );
    assert.deepEqual(classes.get(environment), ["infrastructure"]);
    assert.deepEqual(classes.get(intercepted), ["business"]);
    assert.deepEqual(classes.get(rejected), []);
    assert.deepEqual(
      listSessionSummaries(dir, { class: "infrastructure" }).map((s) => s.sessionId),
      [environment]
    );
    assert.deepEqual(
      listSessionSummaries(dir, { class: "business" }).map((s) => s.sessionId),
      [intercepted]
    );
  } finally {
    cleanup();
  }
});

test("最小过滤器：--tool 按工具名、--class 按失败分类", async () => {
  const { dir, cleanup } = makeDir();
  try {
    const healthy = await seed(dir, (s) => {
      s.startRun({ task: "a" });
      s.toolTurn({ name: "edit_file" });
      s.endRun();
    });
    const crashed = await seed(dir, (s) => {
      s.startRun({ task: "b" });
      s.toolTurn({ name: "read_file" });
    });
    await seed(dir, (s) => {
      s.startRun({ task: "c" });
      s.assistant({ text: "", stopReason: "aborted" });
      s.endRun({ ending: "aborted" });
    });
    assert.deepEqual(
      listSessionSummaries(dir, { tool: "edit_file" }).map((s) => s.sessionId),
      [healthy]
    );
    assert.deepEqual(
      listSessionSummaries(dir, { tool: "read_file" }).map((s) => s.sessionId),
      [crashed]
    );
    assert.deepEqual(listSessionSummaries(dir, { tool: "不存在" }), []);
    assert.deepEqual(
      listSessionSummaries(dir, { class: "unknown" }).map((s) => s.sessionId),
      [crashed]
    );
    assert.equal(listSessionSummaries(dir, { class: "cancelled" }).length, 1);
    assert.deepEqual(listSessionSummaries(dir, { class: "infrastructure" }), []);
  } finally {
    cleanup();
  }
});

test("--since/--until：按创建时间过滤（闭区间），多条件叠加为与；无 Run 的会话照列、Run 数为 0", async () => {
  const { dir, cleanup } = makeDir();
  try {
    const t1 = fakeSessionIdAt(1_000_000);
    const t2 = fakeSessionIdAt(2_000_000);
    const t3 = fakeSessionIdAt(3_000_000);
    // 写入先后与创建时间相反：排序按创建时间
    for (const sessionId of [t3, t1, t2]) {
      await seed(dir, (s) => s.user("Run 之外的消息不计入"), sessionId);
    }
    const ids = (list: ReturnType<typeof listSessionSummaries>) =>
      list.map((summary) => summary.sessionId);
    assert.deepEqual(ids(listSessionSummaries(dir)), [t1, t2, t3], "默认按创建时间升序");
    assert.deepEqual(
      listSessionSummaries(dir).map((summary) => summary.runCount),
      [0, 0, 0]
    );
    assert.deepEqual(ids(listSessionSummaries(dir, { since: 2_000_000 })), [t2, t3]);
    assert.deepEqual(ids(listSessionSummaries(dir, { until: 2_000_000 })), [t1, t2]);
    assert.deepEqual(ids(listSessionSummaries(dir, { since: 2_000_000, until: 2_000_000 })), [t2]);
    // 叠加 --class：无 Run 的会话没有任何分类，被过滤掉
    assert.deepEqual(ids(listSessionSummaries(dir, { since: 1_000_000, class: "unknown" })), []);
  } finally {
    cleanup();
  }
});

test("只读：正被写入（末行撕裂）的会话照常列出、文件不改；旧格式平铺文件与写了一半的文件头不算会话", async () => {
  const { dir, cleanup } = makeDir();
  try {
    const session = createFixtureSession({ sessionsDir: dir });
    session.startRun({ task: "a" });
    const { sessionId, path } = await session.close();
    tearTail(path);
    const before = readFileSync(path);
    writeFileSync(join(dir, `${newSessionId()}.jsonl`), "");
    const half = join(path, "..", `2026-01-01T00-00-00-000Z_${newSessionId()}.jsonl`);
    writeFileSync(half, '{"kind":"header","vers');
    assert.deepEqual(
      listSessionSummaries(dir).map((summary) => [summary.sessionId, summary.runCount]),
      [[sessionId, 1]]
    );
    assert.deepEqual(readFileSync(path), before);
  } finally {
    cleanup();
  }
});
