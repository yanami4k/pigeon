// 脚本编排验收后的三处（决策 313、314）：模型没有价格却给了金额额度即开跑拒绝（token 额度照常）；额度用完、被停或卡住时不自动
// 收回，汇总列出已做完的 worker 与分支并写明取用与续跑的办法；脚本卡住监控——没有 worker 在跑或排队、脚本又没结束，持续到
// 判定时长即停掉容器、以"卡住"结束（脚本自身死循环同样停得掉），等 worker 的脚本不被误停。
import assert from "node:assert/strict";
import { test } from "node:test";
import { orchestrationSettings } from "../state/orchestration-config.ts";
import { scriptHarness } from "./script-fixtures.ts";
import { modelPricing } from "./script-host.ts";
import { ScriptGate } from "./script-naming.ts";
import { ScriptBudgetError, type ScriptRuns } from "./script-runner.ts";
import { SCRIPT_BUDGET_NO_PRICE } from "./script-texts.ts";
import { createOrchestrateTool, ScriptSlot } from "./script-tool.ts";

const spec = (script: string) => ({ name: "t", phases: [], script });

test("模型没有价格：金额额度开跑即拒绝，token 额度与不设额度照常；续跑换成金额额度同样拒绝", async () => {
  const harness = scriptHarness({ planner: () => ({ tokens: 100 }), pricing: () => "none" });
  await assert.rejects(
    harness.runs.start(spec('await agent("一");'), { unit: "usd", amount: 1 }),
    (error: unknown) =>
      error instanceof ScriptBudgetError && error.message === SCRIPT_BUDGET_NO_PRICE
  );
  await assert.rejects(
    harness.runs.start(spec('await agent("一");'), { unit: "cny", amount: 1 }),
    ScriptBudgetError
  );
  assert.equal(harness.sink.spawned.length, 0);
  const notice = harness.nextNotice();
  const runId = await harness.runs.start(spec('await agent("一");'), {
    unit: "tokens",
    amount: 10_000,
  });
  assert.match(await notice, /已完成/);
  await harness.runs.settled(runId);
  await assert.rejects(
    harness.runs.resume(runId, { budget: { unit: "usd", amount: 1 } }),
    ScriptBudgetError
  );
  // 有价格的模型照常
  const priced = scriptHarness({ planner: () => ({ cost: 0.01 }), pricing: () => "usd" });
  const pricedNotice = priced.nextNotice();
  await priced.runs.start(spec('await agent("一");'), { unit: "usd", amount: 1 });
  assert.match(await pricedNotice, /已完成/);
});

test("工具把拒绝原样交回；计价口径：DeepSeek 按人民币、回复自带价格按美元、价格为 0 即没有价格、还没有回复即看不出来", async () => {
  const slot = new ScriptSlot(new ScriptGate({ modelDecides: true }));
  slot.bind({
    governanceRoot: process.cwd(),
    runs: {
      start: async () => {
        throw new ScriptBudgetError(SCRIPT_BUDGET_NO_PRICE);
      },
    } as unknown as ScriptRuns,
  });
  const result = await createOrchestrateTool(slot).execute("c1", {
    name: "t",
    script: "return 1;",
  });
  assert.deepEqual(result.content, [{ type: "text", text: SCRIPT_BUDGET_NO_PRICE }]);
  const reply = (total: number) => ({
    role: "assistant",
    usage: { totalTokens: 10, cost: { total } },
  });
  assert.equal(modelPricing("deepseek", []), "cny");
  assert.equal(modelPricing("x", [reply(0), reply(0.01)]), "usd");
  assert.equal(modelPricing("x", [reply(0.01), reply(0)]), "none");
  assert.equal(modelPricing("x", [{ role: "user" }]), undefined);
});

test("额度用完不自动收回：汇总列出已做完的 worker 与分支，写明用 /take 取用或调高额度续跑", async () => {
  const harness = scriptHarness({
    planner: () => ({ cost: 0.1, files: { "x.txt": "x" } }),
    runIds: ["s9"],
  });
  const notice = harness.nextNotice();
  await harness.runs.start(
    spec(
      'const a = await agent("一"); await agent("二"); await agent("三"); return { collect: [a] };'
    ),
    { unit: "usd", amount: 0.15 }
  );
  const text = await notice;
  assert.match(
    text,
    /已做完：s9-1（分支 pigeon\/s9-1）、s9-2（分支 pigeon\/s9-2）。可用 \/take 逐个取用，或调高额度后续跑，已做完的会复用。/
  );
  assert.match(text, /未收回：脚本没有正常结束。/);
});

test("脚本卡住监控：没有 worker 在跑或排队、脚本又没结束（脚本自身死循环），到判定时长即停掉、以卡住结束", async () => {
  const harness = scriptHarness({
    planner: () => ({ files: { "d.txt": "d" } }),
    // 窗口取宽：执行器是真实子进程，冷启动在慢机器上可能几百毫秒，窗口须留出余量
    stallMs: 2500,
    runIds: ["s7"],
  });
  const notice = harness.nextNotice();
  const startedAt = Date.now();
  await harness.runs.start(spec('await agent("一"); while (true) {}'), undefined);
  const text = await notice;
  assert.ok(Date.now() - startedAt < 8000, "宿主侧计时停掉，不等执行器自己的同步时限");
  assert.match(text, /卡住：1 分钟没有 worker 在跑或排队，脚本也没有结束，已停掉/);
  assert.match(text, /已做完：s7-1（分支 pigeon\/s7-1）/);
  await harness.runs.settled("s7");
  const [node] = harness.runs.nodes();
  assert.equal(node?.state, "stalled");
});

test("等 worker 的脚本不被误停：worker 跑得比判定时长久，脚本照常做完", async () => {
  const harness = scriptHarness({
    // worker 各自跑满 5000ms，远长于 2500ms 的判定窗口；窗口同时要留出子进程冷启动的余量
    planner: () => ({ wait: new Promise((resolve) => setTimeout(resolve, 5000)) }),
    stallMs: 2500,
  });
  const notice = harness.nextNotice();
  // 两个调用先一起发出（等结果前都不在等：两个 worker 各自跑满 5000ms＞2500ms 的判定窗口，脚本不该被误停）；
  // 不写成先后等待——两个调用之间的进程调度间隔在慢机器上可能超过判定窗口，那是测试自身的时序假象
  await harness.runs.start(
    spec('const a = agent("一"); const b = agent("二"); await a; await b; return 1;'),
    undefined
  );
  assert.match(await notice, /已完成。worker 2 个：成功 2，失败 0/);
});

test("卡住的判定时长可在编排配置里改（script.stallMinutes，缺省 10 分钟）", () => {
  assert.equal(orchestrationSettings(undefined).scriptStallMs, 600_000);
  assert.equal(orchestrationSettings({ script: { stallMinutes: 2 } }).scriptStallMs, 120_000);
});
