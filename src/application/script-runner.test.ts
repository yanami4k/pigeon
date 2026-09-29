// 脚本编排的运行器（决策 310、311、313、314）：真编排器、真 git 工作树、本机进程版执行器，worker 为按任务文字驱动的替身。
// 积木（agent 与结构化输出的合格、改正后合格、两次仍不合；parallel 屏障；pipeline 各项不等齐；phase 与 log；args）、
// 接力与收回（接力起点看得到上游的改动；按清单三方叠加、整批请示一次、冲突列出；运行期间主目录不变）、
// 单个失败（不中断；pipeline 跳过该项后续；汇总写明原因；等审批超时单独标出）、花费上限（到限停派、在跑做完、汇总写明、
// 无价格按 token）。续跑的用例在 script-resume.test.ts。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, type PlanInput, scriptHarness, type WorkerPlan } from "./script-fixtures.ts";

const objectSchema = {
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"],
};

async function runToEnd(
  harness: ReturnType<typeof scriptHarness>,
  script: string,
  options: {
    phases?: string[];
    args?: unknown;
    budget?: Parameters<typeof harness.runs.start>[1];
  } = {}
): Promise<{ runId: string; notice: string }> {
  const notice = harness.nextNotice();
  const runId = await harness.runs.start(
    {
      name: "t",
      phases: options.phases ?? [],
      script,
      ...(options.args !== undefined ? { args: options.args } : {}),
    },
    options.budget
  );
  return { runId, notice: await notice };
}

function returned(notice: string): unknown {
  const line = notice.split("\n").find((entry) => entry.startsWith("脚本返回："));
  return line === undefined ? undefined : JSON.parse(line.slice("脚本返回：".length));
}

test("agent 与结构化输出：合格、改正后合格、两次仍不合（改正在原会话里，至多两次）", async () => {
  const runsBySession = new Map<string, number>();
  const harness = scriptHarness({
    planner: (input: PlanInput): WorkerPlan => {
      const n = (runsBySession.get(input.name) ?? 0) + 1;
      runsBySession.set(input.name, n);
      if (input.task.startsWith("好")) return { reply: '{"count": 3}' };
      if (input.task.startsWith("改一次")) {
        return n === 1 ? { reply: "三个" } : { reply: '```json\n{"count": 4}\n```' };
      }
      return { reply: '{"count": "很多"}' };
    },
  });
  const schema = JSON.stringify(objectSchema);
  const { notice } = await runToEnd(
    harness,
    [
      `const a = await agent("好", { schema: ${schema} });`,
      `const b = await agent("改一次", { schema: ${schema} });`,
      `const c = await agent("总是不合", { schema: ${schema} });`,
      "return { r: [a, b, c].map((x) => ({ ok: x.ok, output: x.output ?? null, kind: x.errorKind ?? null })) };",
    ].join("\n")
  );
  assert.deepEqual(returned(notice), {
    r: [
      { ok: true, output: { count: 3 }, kind: null },
      { ok: true, output: { count: 4 }, kind: null },
      { ok: false, output: { count: "很多" }, kind: "output-invalid" },
    ],
  });
  // 改正在原会话里：同一个 worker 各跑了 1、2、3 次
  assert.deepEqual([...runsBySession.values()], [1, 2, 3]);
  // 给了格式时任务后面附上格式要求
  const spawnedTask = harness.sink.spawned[0]?.task ?? "";
  assert.match(spawnedTask, /最后一条回复只给一个符合下面 JSON Schema 的 JSON 对象/);
  assert.match(notice, /成功 2，失败 1/);
  assert.match(notice, /输出不合格式（已让它改正 2 次）/);
});

test("parallel 为屏障：全部结束才返回；pipeline 每项各自走完、不等齐；phase、log 与 args", async () => {
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const gate = (name: string) => {
    const existing = gates.get(name);
    if (existing !== undefined) return existing;
    const created = Promise.withResolvers<void>();
    gates.set(name, created);
    return created;
  };
  const started: string[] = [];
  const harness = scriptHarness({
    planner: (input) => {
      started.push(input.task);
      return { wait: gate(input.task).promise, reply: input.task };
    },
  });
  const notice = harness.nextNotice();
  await harness.runs.start(
    {
      name: "t",
      phases: ["并行", "流水线"],
      args: ["x", "y"],
      script: [
        'phase("并行");',
        'const both = await parallel([() => agent("p1"), () => agent("p2")]);',
        'log("并行结束", both.length);',
        'phase("流水线");',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是脚本原文（容器里执行的 JavaScript），不是本文件的模板字符串
        "const out = await pipeline(args, (item) => agent(`s1 ${item}`), (prev, item) => agent(`s2 ${item}`));",
        "return { out: out.map((r) => r.summary) };",
      ].join("\n"),
    },
    undefined
  );
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(check());
  };
  await until(() => started.includes("p1") && started.includes("p2"));
  gate("p1").resolve();
  await new Promise((r) => setTimeout(r, 100));
  // 屏障：p2 没结束，log 还没写、流水线还没开始
  assert.ok(!harness.lines.some((line) => line.includes("并行结束")));
  assert.ok(!started.some((task) => task.startsWith("s1")));
  gate("p2").resolve();
  await until(() => started.includes("s1 x") && started.includes("s1 y"));
  assert.ok(harness.lines.some((line) => line === "[脚本 t] 并行结束 2"));
  // 流水线：x 的第一步做完即进第二步，不等 y 的第一步
  gate("s1 x").resolve();
  await until(() => started.includes("s2 x"));
  assert.ok(!started.includes("s2 y"));
  gate("s2 x").resolve();
  gate("s1 y").resolve();
  await until(() => started.includes("s2 y"));
  gate("s2 y").resolve();
  const text = await notice;
  assert.deepEqual(returned(text), { out: ["s2 x", "s2 y"] });
  assert.equal(
    harness.lines[0],
    "[脚本] t（运行号 " +
      text.match(/运行号 (\w+)/)?.[1] +
      "）开跑：阶段 并行 → 流水线；已知 2 项；额度 不限。"
  );
  // 树形视图：脚本与阶段两层，worker 按阶段列出
  const [node] = harness.runs.nodes();
  assert.deepEqual(
    node?.phases.map((phase) => [phase.title, phase.workers.length]),
    [
      ["并行", 2],
      ["流水线", 4],
    ]
  );
});

test("接力与收回：接力起点看得到上游的改动；按清单三方叠加、整批请示一次、冲突列出；运行期间主目录不变", async () => {
  let mainDuringRun: string | undefined;
  const harness = scriptHarness({
    planner: (input) => {
      if (input.task === "上游") return { files: { "x.txt": "x\n" }, reply: "写了 x" };
      if (input.task === "下游") {
        mainDuringRun = readFileSync(join(harness.repo, "a.txt"), "utf8");
        const sees = existsSync(join(input.worktree, "x.txt"));
        return { files: { "y.txt": "y\n" }, reply: JSON.stringify({ sees }) };
      }
      if (input.task === "改 a 一") return { files: { "a.txt": "one\n" } };
      return { files: { "a.txt": "two\n" } };
    },
  });
  const { notice } = await runToEnd(
    harness,
    [
      'const up = await agent("上游");',
      'const down = await agent("下游", { relay: up });',
      'const one = await agent("改 a 一");',
      'const two = await agent("改 a 二");',
      "return { collect: [up, down, one, two], sees: down.output };",
    ].join("\n")
  );
  assert.deepEqual((returned(notice) as { sees: unknown }).sees, { sees: true });
  // 运行期间主目录没动
  assert.equal(mainDuringRun, "a\n");
  // 整批请示一次，与 take_worker 同一工具名
  assert.equal(harness.collectRequests.length, 1);
  assert.equal(harness.collectRequests[0]?.toolName, "take_worker");
  const collectArgs = harness.collectRequests[0]?.args as { workers: string[] } | undefined;
  assert.equal(collectArgs?.workers.length, 4);
  // 各 worker 自己的改动：下游只叠 y.txt（x.txt 属于上游），后取的改 a 冲突
  assert.equal(readFileSync(join(harness.repo, "x.txt"), "utf8"), "x\n");
  assert.equal(readFileSync(join(harness.repo, "y.txt"), "utf8"), "y\n");
  assert.equal(readFileSync(join(harness.repo, "a.txt"), "utf8"), "one\n");
  assert.match(
    notice,
    /收回：叠入 x\.txt、y\.txt、a\.txt；冲突未写入 a\.txt；worker 删除未删 无。/
  );
  // 收回之后快照引用删掉
  assert.equal(git(harness.repo, "for-each-ref", "refs/pigeon/scripts/"), "");
});

test("收回：人没批准即不写主目录；脚本没有给 collect 即不请示", async () => {
  const harness = scriptHarness({
    planner: () => ({ files: { "z.txt": "z\n" } }),
    collectDecision: () => ({ approved: false }),
  });
  const first = await runToEnd(harness, 'const r = await agent("做"); return { collect: [r] };');
  assert.match(first.notice, /未收回：人没有批准。/);
  assert.ok(!existsSync(join(harness.repo, "z.txt")));
  const second = await runToEnd(harness, 'await agent("做"); return 1;');
  assert.match(second.notice, /未收回：没有要收回的。/);
  assert.equal(harness.collectRequests.length, 1);
});

test("单个失败不中断：agent 照常返回原因；pipeline 跳过该项后续；汇总写明失败与原因", async () => {
  const seen: string[] = [];
  const harness = scriptHarness({
    planner: (input) => {
      seen.push(input.task);
      return input.task.includes("坏") ? { fail: "编译不过" } : { reply: "好" };
    },
  });
  const { notice } = await runToEnd(
    harness,
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是脚本原文（容器里执行的 JavaScript），不是本文件的模板字符串
      'const out = await pipeline(["坏", "好"], (item) => agent(`一 ${item}`), (prev, item) => agent(`二 ${item}`));',
      'const other = await agent("最后");',
      "return { first: out.map((r) => [r.ok, r.errorKind ?? null]), other: other.ok };",
    ].join("\n")
  );
  assert.deepEqual(returned(notice), {
    first: [
      [false, "run-failed"],
      [true, null],
    ],
    other: true,
  });
  // 坏的那项第二步跳过，其余照常
  assert.ok(!seen.includes("二 坏"));
  assert.ok(seen.includes("二 好") && seen.includes("最后"));
  assert.match(notice, /已完成。worker 4 个：成功 3，失败 1/);
  assert.match(notice, /失败：\S+：失败，编译不过/);
});

test("等审批超时单独标出（补批后可续跑）", async () => {
  const harness = scriptHarness({
    planner: (input) => (input.task === "要跑命令" ? { ask: "npm test" } : { reply: "好" }),
    approvals: () => new Promise(() => {}),
    approvalTimeoutMs: 50,
  });
  const { notice, runId } = await runToEnd(
    harness,
    'await agent("要跑命令"); await agent("别的");'
  );
  assert.match(
    notice,
    new RegExp(`等审批超时（补批后用 resume_run=${runId} 续跑）：${runId}-1：要跑命令 npm test`)
  );
  assert.ok(!/失败：/.test(notice));
});

test("花费上限：到限即不再派、在跑的做完、汇总写明做完与未做；无价格的模型按 token", async () => {
  const harness = scriptHarness({ planner: () => ({ cost: 0.1, tokens: 1000 }) });
  const { notice } = await runToEnd(
    harness,
    [
      'const both = await parallel([() => agent("一"), () => agent("二")]);',
      'const three = await agent("三");',
      'const four = await agent("四");',
      "return { r: [...both, three, four].map((x) => x.ok) };",
    ].join("\n"),
    { budget: { unit: "usd", amount: 0.15 } }
  );
  // 两个并行的都做完（到限时它们已在跑），之后的不再派
  assert.deepEqual(returned(notice), { r: [true, true, false, false] });
  assert.match(notice, /额度用完。worker 2 个：成功 2，失败 0/);
  assert.match(notice, /额度用完未做：2 个调用没有派出；调高额度后用 resume_run=/);
  assert.match(notice, /花费 \$0\.20/);
  assert.match(notice, /未收回：脚本没有正常结束。/);
  assert.equal(harness.sink.spawned.length, 2);
  // 无价格：按 token 计
  const tokens = scriptHarness({ planner: () => ({ tokens: 600 }) });
  const byTokens = await runToEnd(
    tokens,
    'await agent("一"); await agent("二"); await agent("三"); return 1;',
    { budget: { unit: "tokens", amount: 1000 } }
  );
  assert.equal(tokens.sink.spawned.length, 2);
  assert.match(byTokens.notice, /额度用完未做：1 个调用没有派出/);
  assert.match(byTokens.notice, /花费 1200 token（无价格）/);
});

test("脚本出错与 worker 名：脚本抛错即以出错结束；角色写错的调用照常返回失败", async () => {
  const harness = scriptHarness({ planner: () => ({}) });
  const bad = await runToEnd(
    harness,
    'const r = await agent("做", { role: "boss" }); return { ok: r.ok, e: r.error };'
  );
  assert.deepEqual(returned(bad.notice), {
    ok: false,
    e: "没有角色 boss；可选：explorer、implementer、tester",
  });
  const thrown = await runToEnd(harness, 'await agent("做"); throw new Error("不对");');
  assert.match(thrown.notice, /出错：Error: 不对。/);
  assert.match(thrown.notice, /未收回：脚本没有正常结束。/);
});
