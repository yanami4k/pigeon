// 打转判定（决策 305、306）：指纹口径、两种计数、清零与豁免、三个阈值的触发
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, LoopDetector, type LoopRound, type LoopVerdict } from "./loop-guard.ts";
import { DEFAULT_LOOP_GUARD_SETTINGS, loopGuardSettings } from "./loop-guard-config.ts";

let seq = 0;
// 一轮：[工具名, 参数, 结果正文, 是否报错?]
function round(...calls: Array<[string, unknown, string, boolean?]>): LoopRound {
  const ids = calls.map(() => {
    seq += 1;
    return `call-${seq}`;
  });
  return {
    calls: calls.map(([toolName, args], index) => ({
      toolCallId: ids[index] ?? "",
      toolName,
      args,
    })),
    // 结果按到达先后给出，顺序与调用不同也按 toolCallId 对上
    results: calls
      .map(([, , text, isError], index) => ({
        toolCallId: ids[index] ?? "",
        text,
        isError: isError === true,
      }))
      .reverse(),
  };
}

const RUN = (command: string, out: string) => round(["run_command", { command }, out]);

function feed(detector: LoopDetector, rounds: readonly LoopRound[]): LoopVerdict[] {
  return rounds.map((each) => detector.observe(each));
}

function repeat<T>(times: number, make: (index: number) => T): T[] {
  return Array.from({ length: times }, (_, index) => make(index));
}

function detector(overrides: Partial<typeof DEFAULT_LOOP_GUARD_SETTINGS> = {}): LoopDetector {
  return new LoopDetector({ ...DEFAULT_LOOP_GUARD_SETTINGS, ...overrides });
}

test("完全相同的轮：与上一轮相同计一次、连续累计", () => {
  const verdicts = feed(
    detector(),
    repeat(4, () => RUN("ls", "a\nb"))
  );
  assert.deepEqual(
    verdicts.map((v) => v.count),
    [0, 1, 2, 3]
  );
});

test("结果不同（轮询、等服务起来后结果变了）不计", () => {
  const verdicts = feed(detector(), [
    RUN("curl localhost:3000", "connection refused"),
    RUN("curl localhost:3000", "connection refused"),
    RUN("curl localhost:3000", "ok"),
    RUN("curl localhost:3000", "ok"),
  ]);
  assert.deepEqual(
    verdicts.map((v) => v.count),
    [0, 1, 0, 1]
  );
  // 是否报错也在指纹里
  const flipped = feed(detector(), [
    round(["read_file", { path: "a" }, "x", false]),
    round(["read_file", { path: "a" }, "x", true]),
  ]);
  assert.equal(flipped[1]?.count, 0);
});

test("参数不同不计；参数键序不同仍算相同", () => {
  const differ = feed(detector(), [
    round(["read_file", { path: "a.ts", offset: 1 }, "x"]),
    round(["read_file", { path: "a.ts", offset: 2 }, "x"]),
  ]);
  assert.equal(differ[1]?.count, 0);
  const reordered = feed(detector(), [
    round(["read_file", { path: "a.ts", range: { to: 9, from: 1 } }, "x"]),
    round(["read_file", { range: { from: 1, to: 9 }, path: "a.ts" }, "x"]),
  ]);
  assert.equal(reordered[1]?.count, 1);
  assert.equal(canonicalJson({ b: [2, { d: 1, c: 0 }], a: 1 }), '{"a":1,"b":[2,{"c":0,"d":1}]}');
});

test("一轮内调用保序：同一组调用换了先后算不同", () => {
  const verdicts = feed(detector(), [
    round(["read_file", { path: "a" }, "x"], ["read_file", { path: "b" }, "y"]),
    round(["read_file", { path: "b" }, "y"], ["read_file", { path: "a" }, "x"]),
  ]);
  assert.equal(verdicts[1]?.count, 0);
});

test("两轮一循环的交替同样计数，取两种计数的大者", () => {
  const a = () => RUN("git status", "clean");
  const b = () => RUN("git diff", "");
  const verdicts = feed(detector(), [a(), b(), a(), b(), a(), b()]);
  assert.deepEqual(
    verdicts.map((v) => v.count),
    [0, 0, 1, 2, 3, 4]
  );
  const last = verdicts.at(-1);
  assert.equal(last?.alternating, true);
  // 交替时提醒里给出循环的两轮，按发生先后
  assert.deepEqual(
    (last?.pattern ?? []).map(
      (r) => (r.calls[0]?.args as { command?: string } | undefined)?.command
    ),
    ["git status", "git diff"]
  );
});

test("没有工具调用的轮清零（连前两轮的记录一并清掉）", () => {
  const d = detector();
  feed(
    d,
    repeat(3, () => RUN("ls", "a"))
  );
  assert.equal(d.observe({ calls: [], results: [] }).count, 0);
  // 清零后重新开始：这一轮不与清零前的比较
  assert.equal(d.observe(RUN("ls", "a")).count, 0);
  assert.equal(d.observe(RUN("ls", "a")).count, 1);
});

test("豁免工具去掉后为空的轮：不计也不清零", () => {
  const d = detector();
  feed(
    d,
    repeat(3, () => RUN("ls", "a"))
  );
  const waiting = d.observe(round(["wait_workers", { timeoutSeconds: 60 }, "仍在跑"]));
  assert.equal(waiting.count, 2);
  assert.equal(waiting.action, undefined);
  // 等待之后接着同样的轮，照常接着计
  assert.equal(d.observe(RUN("ls", "a")).count, 3);
  // 豁免工具反复等待本身不计
  const idle = detector();
  const waits = feed(
    idle,
    repeat(30, () => round(["wait_workers", {}, "仍在跑"]))
  );
  assert.ok(waits.every((v) => v.count === 0 && v.action === undefined));
});

test("豁免与非豁免调用混在一轮时只比非豁免的", () => {
  const verdicts = feed(detector(), [
    round(["wait_workers", {}, "仍在跑 3 个"], ["worker_status", {}, "w1 running"]),
    round(
      ["wait_workers", { timeoutSeconds: 5 }, "仍在跑 2 个"],
      ["worker_status", {}, "w1 running"]
    ),
  ]);
  assert.equal(verdicts[1]?.count, 1);
  // 查看 worker 状态不豁免：结果变了即不计
  const changed = feed(detector(), [
    round(["worker_status", {}, "w1 running"]),
    round(["worker_status", {}, "w1 completed"]),
  ]);
  assert.equal(changed[1]?.count, 0);
});

test("第 5 轮提醒、第 10 轮再提醒、第 20 轮叫停；其余轮不触发", () => {
  const verdicts = feed(
    detector(),
    repeat(25, () => RUN("ls", "a"))
  );
  const actions = verdicts.flatMap((v) => (v.action !== undefined ? [[v.count, v.action]] : []));
  assert.deepEqual(actions, [
    [5, "remind"],
    [10, "warn"],
    [20, "stop"],
  ]);
});

test("提醒后模式变了即清零；之后再打转，提醒照常再来", () => {
  const d = detector();
  const first = feed(
    d,
    repeat(6, () => RUN("ls", "a"))
  );
  assert.equal(first.at(-1)?.action, "remind");
  assert.equal(d.observe(RUN("cat a", "…")).count, 0);
  const again = feed(
    d,
    repeat(6, () => RUN("ls", "a"))
  );
  assert.deepEqual(
    again.flatMap((v) => (v.action !== undefined ? [v.action] : [])),
    ["remind"]
  );
});

test("改过的轮数照改后的触发", () => {
  const resolved = loopGuardSettings({ remindAt: 2, warnAt: 3, stopAt: 4 });
  assert.ok("settings" in resolved);
  const verdicts = feed(
    new LoopDetector(resolved.settings),
    repeat(6, () => RUN("ls", "a"))
  );
  assert.deepEqual(
    verdicts.flatMap((v) => (v.action !== undefined ? [[v.count, v.action]] : [])),
    [
      [2, "remind"],
      [3, "warn"],
      [4, "stop"],
    ]
  );
});

test("追加的豁免与缺省豁免合并", () => {
  const resolved = loopGuardSettings({ exemptTools: ["mcp__ci__poll"] });
  assert.ok("settings" in resolved);
  assert.deepEqual(resolved.settings.exemptTools, ["wait_workers", "mcp__ci__poll"]);
  const verdicts = feed(
    new LoopDetector(resolved.settings),
    repeat(8, () => round(["mcp__ci__poll", { id: 1 }, "pending"]))
  );
  assert.ok(verdicts.every((v) => v.count === 0));
});

test("配置缺省：开着、5/10/20、只豁免 wait_workers；轮数不递增报出问题", () => {
  const resolved = loopGuardSettings(undefined);
  assert.ok("settings" in resolved);
  assert.deepEqual(resolved.settings, {
    enabled: true,
    remindAt: 5,
    warnAt: 10,
    stopAt: 20,
    exemptTools: ["wait_workers"],
  });
  const bad = loopGuardSettings({ warnAt: 5 });
  assert.ok("problem" in bad);
  assert.match(bad.problem, /递增/);
  const equal = loopGuardSettings({ remindAt: 3, warnAt: 8, stopAt: 8 });
  assert.ok("problem" in equal);
});

test("真实形状：每轮两条相同的 run_command、结果相同，连续数百轮——计数 20 时叫停，之后不再有判定", () => {
  const d = detector();
  const shaped = () =>
    round(
      [
        "run_command",
        { command: "npm test -- --run src/app.test.ts", timeoutMs: 120000 },
        "FAIL src/app.test.ts\n  ✗ renders (12 ms)\nTests: 1 failed",
      ],
      ["run_command", { command: "cat src/app.ts" }, "export function App() {\n  return null;\n}"]
    );
  let stoppedAt: number | undefined;
  let rounds = 0;
  for (let index = 0; index < 600 && stoppedAt === undefined; index += 1) {
    rounds += 1;
    const verdict = d.observe(shaped());
    if (verdict.action === "stop") {
      stoppedAt = verdict.count;
    }
  }
  assert.equal(stoppedAt, 20);
  // 第 1 轮是原样，其后 20 轮重复：叫停时一共 21 轮，远在数百轮之前
  assert.equal(rounds, 21);
});
