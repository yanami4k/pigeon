// 脚本续跑（决策 312、313、314）：按每个调用的指纹比对，而不是按顺序前缀。机器重启式中断后只重派未完成的；单个失败后只重派
// 失败的；改脚本后只重派受影响的调用；流水线派出顺序变化不影响复用；沿用开跑时的快照；接力上游重做时下游随之重做；
// 调高额度后续跑复用已做完的；等审批超时、补批做完后续跑即复用。
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, recordingSink, scriptHarness } from "./script-fixtures.ts";
import type { ScriptSpec } from "./script-runner.ts";

async function start(
  harness: ReturnType<typeof scriptHarness>,
  spec: ScriptSpec,
  budget?: Parameters<typeof harness.runs.start>[1]
): Promise<{ runId: string; notice: string }> {
  const notice = harness.nextNotice();
  const runId = await harness.runs.start(spec, budget);
  harness.toolResults.push({
    details: { runId, spec, ...(budget !== undefined ? { budget } : {}) },
  });
  return { runId, notice: await notice };
}

async function resume(
  harness: ReturnType<typeof scriptHarness>,
  runId: string,
  override: Parameters<typeof harness.runs.resume>[1] = {}
): Promise<string> {
  const notice = harness.nextNotice();
  assert.equal(await harness.runs.resume(runId, override), "resumed");
  return notice;
}

const tasks = (harness: ReturnType<typeof scriptHarness>) =>
  harness.sink.spawned.map((entry) => entry.task);

test("机器重启式中断后续跑：只重派没做完的，做完的直接复用结果与分支", async () => {
  const sink = recordingSink();
  const first = scriptHarness({
    sink,
    runIds: ["s1"],
    planner: (input) =>
      input.task === "二" ? { hang: true } : { files: { [`${input.task}.txt`]: "x" } },
  });
  const spec: ScriptSpec = {
    name: "t",
    phases: [],
    script: 'const a = await agent("一"); const b = await agent("二"); return { collect: [a, b] };',
  };
  const runId = await first.runs.start(spec, undefined);
  first.toolResults.push({ details: { runId, spec } });
  for (let i = 0; i < 200 && sink.spawned.length < 2; i += 1)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(sink.spawned.length, 2);
  // 进程死掉：此后的记录都不在（"二"只有派出、没有收尾）
  sink.frozen = true;
  const firstA = sink.spawned[0]?.name;
  // 新进程：新的编排器与运行器，同一会话、同一仓库
  sink.frozen = false;
  const second = scriptHarness({
    sink,
    repo: first.repo,
    sessionId: first.sessionId,
    toolResults: first.toolResults,
    planner: (input) => ({ files: { [`${input.task}.txt`]: "y" } }),
  });
  try {
    const notice = await resume(second, runId);
    assert.deepEqual(tasks(second), ["一", "二", "二"]);
    assert.match(notice, /已完成。worker 2 个：成功 2，失败 0，其中复用上次结果 1/);
    assert.equal(sink.spawned[2]?.name, "s1-3");
    // 复用的是原来那个 worker 的分支
    assert.match(notice, /收回：叠入 一\.txt、二\.txt/);
    assert.equal(firstA, "s1-1");
  } finally {
    // 旧进程里挂着的 worker 停掉（记录冻结，不影响断言）
    sink.frozen = true;
    for (const status of first.orchestrator.status()) {
      if (status.state === "running") await first.orchestrator.cancel(status.sessionId);
    }
    await first.runs.settled("s1");
  }
});

test("单个失败后续跑只重派失败的；改脚本后只重派受影响的调用", async () => {
  let broken = true;
  const harness = scriptHarness({
    planner: (input) =>
      input.task === "二" && broken ? { fail: "测不过" } : { reply: input.task },
  });
  const spec: ScriptSpec = {
    name: "t",
    phases: [],
    script: 'await agent("一"); await agent("二"); await agent("三"); return 1;',
  };
  const { runId, notice } = await start(harness, spec);
  assert.match(notice, /成功 2，失败 1/);
  broken = false;
  const again = await resume(harness, runId);
  assert.deepEqual(tasks(harness), ["一", "二", "三", "二"]);
  assert.match(again, /成功 3，失败 0，其中复用上次结果 2/);
  // 改了第三个调用的任务文字：只重派它
  const changed = await resume(harness, runId, {
    spec: {
      ...spec,
      script: 'await agent("一"); await agent("二"); await agent("三改"); return 1;',
    },
  });
  assert.deepEqual(tasks(harness), ["一", "二", "三", "二", "三改"]);
  assert.match(changed, /其中复用上次结果 2/);
});

test("流水线派出顺序变化不影响复用；同内容的调用按出现序号区分", async () => {
  const harness = scriptHarness({ planner: (input) => ({ reply: input.task }) });
  const script =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是脚本原文（容器里执行的 JavaScript），不是本文件的模板字符串
    'const out = await pipeline(args, (item) => agent(`做 ${item}`), (prev) => agent("复查")); return out.length;';
  const { runId } = await start(harness, { name: "t", phases: [], script, args: ["x", "y"] });
  assert.equal(harness.sink.spawned.length, 4);
  const notice = await resume(harness, runId, {
    spec: { name: "t", phases: [], script, args: ["y", "x"] },
  });
  assert.equal(harness.sink.spawned.length, 4);
  assert.match(notice, /其中复用上次结果 4/);
});

test("续跑沿用开跑时的快照：主目录之后又改了、提交了，重派的 worker 仍从原快照开工", async () => {
  let broken = true;
  const harness = scriptHarness({
    planner: (input) => (input.task === "二" && broken ? { fail: "x" } : {}),
  });
  const { runId } = await start(harness, {
    name: "t",
    phases: [],
    script: 'await agent("一"); await agent("二"); return 1;',
  });
  const base = (entry: (typeof harness.sink.spawned)[number] | undefined) =>
    entry?.workspace.kind === "git-worktree" ? entry.workspace.baseCommit : undefined;
  const original = base(harness.sink.spawned[0]);
  writeFileSync(join(harness.repo, "a.txt"), "changed\n");
  git(harness.repo, "commit", "-qam", "later");
  broken = false;
  await resume(harness, runId);
  assert.equal(harness.sink.spawned.length, 3);
  assert.equal(base(harness.sink.spawned[2]), original);
  assert.notEqual(git(harness.repo, "rev-parse", "HEAD"), original);
});

test("接力上游重做时下游随之重做", async () => {
  const harness = scriptHarness({
    planner: (input) => ({ files: { [`${input.task}.txt`]: "1" } }),
  });
  const { runId } = await start(harness, {
    name: "t",
    phases: [],
    script:
      'const up = await agent("上"); const down = await agent("下", { relay: up }); await agent("旁"); return 1;',
  });
  assert.equal(harness.sink.spawned.length, 3);
  // 上游的工作树没了：续跑时上游重做，下游跟着重做；不相干的"旁"复用
  const up = harness.sink.spawned[0];
  assert.ok(up !== undefined && up.workspace.kind === "git-worktree");
  git(harness.repo, "worktree", "remove", "--force", up.workspace.path);
  const notice = await resume(harness, runId);
  assert.deepEqual(tasks(harness), ["上", "下", "旁", "上", "下"]);
  assert.equal(harness.sink.spawned[4]?.script?.relayFrom, harness.sink.spawned[3]?.childSessionId);
  assert.match(notice, /其中复用上次结果 1/);
});

test("调高额度后续跑：复用已做完的，接着派没做的", async () => {
  const harness = scriptHarness({ planner: () => ({ cost: 0.1 }) });
  const spec: ScriptSpec = {
    name: "t",
    phases: [],
    script: 'await agent("一"); await agent("二"); await agent("三"); await agent("四"); return 1;',
  };
  const { runId, notice } = await start(harness, spec, { unit: "usd", amount: 0.15 });
  assert.match(notice, /额度用完/);
  assert.equal(harness.sink.spawned.length, 2);
  const again = await resume(harness, runId, { budget: { unit: "usd", amount: 1 } });
  assert.deepEqual(tasks(harness), ["一", "二", "三", "四"]);
  assert.match(again, /已完成。worker 4 个：成功 4，失败 0，其中复用上次结果 2。花费 \$0\.40/);
});

test("等审批超时：补批做完后续跑即复用，不再重派", async () => {
  const harness = scriptHarness({
    planner: (input) => (input.task === "跑测试" ? { ask: "npm test" } : {}),
    approvals: () => new Promise(() => {}),
    approvalTimeoutMs: 50,
  });
  const { runId, notice } = await start(harness, {
    name: "t",
    phases: [],
    script: 'await agent("跑测试"); await agent("别的"); return 1;',
  });
  assert.match(notice, /等审批超时/);
  const blocked = harness.sink.spawned[0]?.childSessionId;
  assert.ok(blocked !== undefined);
  // 人进入 worker 会话补批：它重新发起同一个调用（只放行一次）并做完
  harness.orchestrator.resume(blocked, { approve: true });
  const outcome = await harness.orchestrator.awaitResult(blocked);
  assert.equal(outcome.status, "completed");
  const again = await resume(harness, runId);
  assert.equal(harness.sink.spawned.length, 2);
  assert.match(again, /已完成。worker 2 个：成功 2，失败 0，其中复用上次结果 2/);
});
