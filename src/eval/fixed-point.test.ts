// 定点对照的事件认定与单步重跑（决策 139、156、157）：真的 Pigeon（假模型、在本机执行命令的假 docker）跑出的一遍
// "去掉记忆"整流为输入，一份夹具各用例共用
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { listSessionIds, materializeSession } from "../persistence/event-log.ts";
import { ExclusiveLockError } from "../persistence/exclusive-lock.ts";
import type { FakeReply } from "../pi-runtime/fixtures.ts";
import type { ReproducedRuntime } from "../replay/fidelity.ts";
import {
  type FixedPointEventList,
  identifyEvents,
  readEventList,
  writeEventList,
} from "./fixed-point-events.ts";
import {
  digestOf,
  type FixedPointToy,
  fixedPointToy,
  memToyRuntime,
  noMemoryReplies,
  perStepPigeon,
  worktreeState,
} from "./fixed-point-fixtures.ts";
import { type FixedPointOptions, runFixedPoint } from "./fixed-point-rerun.ts";
import { fixedPointKey, readFixedPointRows } from "./fixed-point-results.ts";
import type { GatewayMeter } from "./model-gateway.ts";
import { ZERO_USAGE } from "./stream-results.ts";
import { lockOutDir, type StepAgent, type StepAgentInput } from "./stream-runner.ts";

const RIGHT_FIRST_TIME: Record<number, FakeReply[]> = {
  3: [
    {
      text: "改一下",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "src/core.ts",
            old_string: "// CORE_OK",
            new_string: "// CORE_OK CORE2_OK",
          },
        },
      ],
    },
    { text: "好了" },
  ],
};

interface Seen {
  step: StepAgentInput;
  state: { head: string; tree: string };
  sessionFiles: string[];
}

describe("定点对照：事件认定与单步重跑（真 Pigeon、假模型、本机假 docker）", () => {
  let toy: FixedPointToy;
  let events: FixedPointEventList;

  before(async () => {
    toy = await fixedPointToy();
    events = await identifyEvents({
      manifest: toy.manifest,
      runtime: memToyRuntime,
      human: toy.human,
      noMemoryDir: toy.noMemoryDir,
      envs: toy.envs,
      hostFor: toy.hostFor,
      scratch: join(toy.base, "scratch-1"),
    });
  });

  after(() => toy?.cleanup());

  // 重跑用的 agent：按原尝试照搬的运行面造 Pigeon；开工前记下工作区状态与治理根里的会话文件
  function rerunAgent(
    seen: Seen[],
    streams: NonNullable<Parameters<typeof perStepPigeon>[0]["streams"]>,
    replies: (step: StepAgentInput) => FakeReply[],
    tweak: (rt: ReproducedRuntime) => ReproducedRuntime = (rt) => rt
  ): (rt: ReproducedRuntime) => StepAgent {
    return (reproduced) => {
      const rt = tweak(reproduced);
      return perStepPigeon({
        docker: toy.docker,
        home: toy.home,
        repliesFor: replies,
        streams,
        onStart: (step) =>
          seen.push({
            step,
            state: worktreeState(toy.root),
            sessionFiles: readdirSync(join(step.workDir, ".pigeon", "sessions")).sort(),
          }),
        settings: {
          provider: rt.provider,
          modelId: rt.modelId,
          thinking: rt.thinkingLevel,
          ...(rt.maxOutputTokens !== undefined ? { maxOutputTokens: rt.maxOutputTokens } : {}),
          ...(rt.temperature !== undefined ? { temperature: rt.temperature } : {}),
        },
      });
    };
  }

  function only(ids: string[]): FixedPointEventList {
    return { ...events, events: events.events.filter((e) => ids.includes(e.id)) };
  }

  function options(overrides: Partial<FixedPointOptions>): FixedPointOptions {
    return {
      events,
      manifest: toy.manifest,
      runtime: memToyRuntime,
      human: toy.human,
      noMemoryDir: toy.noMemoryDir,
      envs: toy.envs,
      hostFor: toy.hostFor,
      agentFor: () => {
        throw new Error("用例须给 agentFor");
      },
      outDir: join(toy.base, "out"),
      concurrency: 1,
      harnessRef: { commit: "test", dirty: false },
      ...overrides,
    };
  }

  test("事件认定：只取本能挑到记忆的步，记下挑到的条目与时机（开局、第几轮回炉）；同一输入得到逐字相同的清单", async () => {
    assert.deepEqual(
      events.scanned.map((s) => [s.seq, s.event, s.reason]),
      [
        [1, false, "流的第一步，此前没有会话"],
        [2, false, "没有挑到记忆"],
        [3, true, "挑到记忆"],
        [4, true, "挑到记忆"],
      ]
    );
    const [e3, e4] = events.events;
    // 第 3 步：题面指到 src/core.ts，开局挑到挂在它上面的 F1（core 的测试回归）；没有回炉
    assert.equal(e3?.id, "s1-3");
    assert.equal(e3?.picked.opening.length, 1);
    assert.deepEqual(e3?.picked.repair, []);
    assert.deepEqual(
      e3?.relevant.map((r) => [r.anchor, r.kind, r.fingerprint, r.repairFiles]),
      [["src/core.ts", "regression", "node-test core works @ src/core.test.ts", ["src/core.ts"]]]
    );
    // 第 4 步：开局没有；第 1 轮回炉报与 F1 同一指纹，挑到 F1
    assert.equal(e4?.id, "s1-4");
    assert.deepEqual(e4?.picked.opening, []);
    assert.deepEqual(
      e4?.picked.repair.map((r) => r.round),
      [1]
    );
    assert.equal(e4?.relevant[0]?.fingerprint, "node-test core works @ src/core.test.ts");
    // 三组的固定挑选：带记忆给挑到的、时机不变；无关换成别的文件上的；不带一条不给
    assert.deepEqual(e3?.fixed.memory, { opening: e3?.picked.opening, repair: [] });
    assert.deepEqual(e4?.fixed.memory, { opening: [], repair: e4?.picked.repair[0]?.ids });
    assert.deepEqual(e3?.fixed.none, { opening: [], repair: [] });
    // 开工时的树随事件记下（第 1、2 步的会话都开过回炉）
    assert.equal(e3?.priorStepStarts.length, 2);
    // 同一输入再认定一遍：逐字相同
    const again = await identifyEvents({
      manifest: toy.manifest,
      runtime: memToyRuntime,
      human: toy.human,
      noMemoryDir: toy.noMemoryDir,
      envs: toy.envs,
      hostFor: toy.hostFor,
      scratch: join(toy.base, "scratch-2"),
    });
    assert.equal(digestOf(JSON.stringify(again)), digestOf(JSON.stringify(events)));
    const file = join(toy.base, "events.json");
    writeEventList(file, events);
    assert.deepEqual(readEventList(file), events);
  });

  test("无关记忆：取自其他文件的真实记忆，锚点不在本步题面指到的与本步改动的文件里，不与被换条目同指纹；时机与被换条目相同", () => {
    assert.equal(events.events.length, 2, "有事件可查，不空转");
    for (const event of events.events) {
      const step = toy.manifest.steps.find((s) => s.seq === event.seq);
      const changed = new Set([
        ...toy.human.changes(step?.parent ?? "", step?.commit ?? "").map((c) => c.path),
        "src/core.ts",
        "src/other.ts",
      ]);
      assert.ok(event.irrelevant !== null, `${event.id} 有无关记忆`);
      for (const { replaces, item } of event.irrelevant ?? []) {
        const original = event.relevant.find((r) => r.id === replaces);
        assert.ok(original !== undefined);
        assert.ok(!changed.has(item.anchor), `${item.anchor} 不是本步相关文件`);
        assert.notEqual(item.fingerprintKey, original?.fingerprintKey);
        // 夹具里唯一可取的是 F2（util 的类型错误），挂在 util 与 extra 上、成文相同：取编号小的
        assert.equal(item.fingerprint, "tsc TS2304 @ src/util.ts");
      }
      const swap = new Map((event.irrelevant ?? []).map((x) => [x.replaces, x.item.id]));
      assert.deepEqual(event.fixed.irrelevant, {
        opening: event.fixed.memory?.opening.map((id) => swap.get(id)),
        repair: event.fixed.memory?.repair.map((id) => swap.get(id)),
      });
    }
  });

  test("三组走结构化记忆的正常推送路径（fixed 选择）：开局拼进系统提示、回炉附在报错之后，题面原样；每遍起点与流中该步开工时一致，各遍的治理根互不可见", async () => {
    const seen: Seen[] = [];
    const streams: NonNullable<Parameters<typeof perStepPigeon>[0]["streams"]> = [];
    const outDir = join(toy.base, "out-groups");
    const replies = (step: StepAgentInput) =>
      RIGHT_FIRST_TIME[step.step.seq] ?? noMemoryReplies(step.step.seq);
    const summary = await runFixedPoint(
      options({
        outDir,
        passes: 1,
        agentFor: rerunAgent(seen, streams, replies),
      })
    );
    assert.deepEqual(summary.stopped, []);
    const rows = readFixedPointRows(summary.resultsFile);
    assert.equal(rows.length, 6);
    const [e3, e4] = events.events;
    const byKey = new Map(rows.map((r) => [fixedPointKey(r), r]));
    const r3 = (g: string) => byKey.get(`s1-3|${g}|1`);
    const r4 = (g: string) => byKey.get(`s1-4|${g}|1`);
    // 开局：run.started 记 fixed 选择与给出的条目，系统提示里有这一段，题面原样
    assert.deepEqual(r3("memory")?.given, {
      selection: "fixed",
      opening: e3?.fixed.memory?.opening,
      repair: [],
    });
    assert.deepEqual(r3("irrelevant")?.given.opening, e3?.fixed.irrelevant?.opening);
    assert.deepEqual(r3("none")?.given, { selection: "fixed", opening: [], repair: [] });
    for (const { step, fn } of streams) {
      const call = fn.calls[0];
      const system = call?.context.systemPrompt ?? "";
      const user = JSON.stringify(call?.context.messages[0]);
      const want = (step.structuredMemoryFixed?.opening ?? [])[0];
      if (want !== undefined) {
        assert.match(system, /## 结构化记忆/);
        assert.ok(system.includes(want));
      } else {
        assert.doesNotMatch(system, /结构化记忆/);
      }
      assert.ok(user.includes(JSON.stringify(step.prompt).slice(1, -1)), "题面原样交给模型");
      assert.doesNotMatch(user, /mem_/, "记忆不进题面");
    }
    // 回炉：第 1 轮回炉的 run.started 记给出的条目，回炉反馈末尾附上这一段
    assert.deepEqual(r4("memory")?.given.repair, [e4?.fixed.memory?.repair]);
    assert.deepEqual(r4("none")?.given.repair, [[]]);
    const fed = streams.find(
      (s) => s.step.step.seq === 4 && s.step.structuredMemoryFixed?.repair.length === 1
    );
    const feedback = JSON.stringify(fed?.fn.calls[2]?.context.messages.at(-1));
    assert.match(feedback, /相关的结构化记忆/);
    assert.ok(feedback.includes(e4?.fixed.memory?.repair[0] ?? "?"));
    // 首轮变红（131 口径）：第 3 步一次做对；第 4 步 core 的测试在题面以外变红
    assert.equal(r3("memory")?.firstVerify.offTaskRed, false);
    assert.equal(r4("memory")?.firstVerify.offTaskRed, true);
    assert.equal(r4("memory")?.firstVerify.failed, true);
    assert.equal(r4("memory")?.repairRounds, 1);
    assert.equal(r4("memory")?.outcome, "passed");
    // 记忆被用上：三组都按带记忆组指定的条目（补改文件 src/core.ts）与时间窗口算——三组都在窗口里改了 core.ts
    assert.equal(r3("memory")?.memoryUsed, true);
    assert.deepEqual(r3("memory")?.memoryUsedFiles, ["src/core.ts"]);
    assert.equal(r3("irrelevant")?.memoryUsed, true);
    assert.equal(r3("none")?.memoryUsed, true);
    assert.equal(r4("memory")?.memoryUsed, true);
    // 实际给出的与该组指定的一致
    assert.ok(rows.every((r) => r.givenMatch.opening && r.givenMatch.repair.every((ok) => ok)));
    // 回炉判据：第 3 步没进回炉；第 4 步进了回炉，给出记忆那一轮之后的第 2 次验证不再变红
    assert.equal(r3("memory")?.repairVerify.entered, false);
    assert.deepEqual(
      [r4("memory")?.repairVerify.entered, r4("memory")?.repairVerify.offTaskRed],
      [true, false]
    );
    // 每遍起点与流中该步开工时一致；治理根里恰是第 1 到 k−1 步的会话、各遍各一个
    assert.equal(seen.length, 6);
    for (const s of seen) {
      assert.deepEqual(
        s.state,
        toy.startStates.get(s.step.step.seq),
        `第 ${s.step.step.seq} 步起点`
      );
      const event = events.events.find((e) => e.seq === s.step.step.seq);
      assert.deepEqual(s.sessionFiles, event?.priorSessionFiles);
    }
    assert.equal(new Set(seen.map((s) => s.step.workDir)).size, 6);
    assert.ok(existsSync(summary.reportFile));
  });

  test("续跑按事件 × 组 × 遍次不重不漏：进程死在某遍中途的重跑时只补那一遍；被打断的一遍整遍作废、治理根移出后从起点重来", async () => {
    const outDir = join(toy.base, "out-resume");
    const seen: Seen[] = [];
    const streams: NonNullable<Parameters<typeof perStepPigeon>[0]["streams"]> = [];
    const replies = (step: StepAgentInput) => RIGHT_FIRST_TIME[step.step.seq] ?? [];
    let crash = true;
    let interrupt = true;
    const flaky = (rt: ReproducedRuntime): StepAgent => {
      const inner = rerunAgent(seen, streams, replies)(rt);
      return {
        async run(input) {
          // 第 1 遍：第一次被打断（不跑、报被打断）；第 2 遍：第一次跑到一半进程死掉
          if (input.job.attempt === 1 && interrupt) {
            interrupt = false;
            await inner.run(input);
            return {
              status: "aborted",
              turns: 0,
              usage: ZERO_USAGE,
              wallMs: 0,
              repair: null,
              interrupted: "模拟被打断",
            };
          }
          if (input.job.attempt === 2 && crash) {
            crash = false;
            await inner.run(input);
            throw new Error("模拟进程死在中途");
          }
          return inner.run(input);
        },
      };
    };
    const run = () =>
      runFixedPoint(
        options({ events: only(["s1-3"]), outDir, groups: ["none"], passes: 2, agentFor: flaky })
      );
    const first = await run();
    assert.equal(first.written, 1);
    assert.equal(first.stopped.length, 1);
    assert.match(first.stopped[0]?.error ?? "", /模拟进程死在中途/);
    const second = await run();
    assert.deepEqual([second.existing, second.written, second.stopped.length], [1, 1, 0]);
    const third = await run();
    assert.deepEqual([third.existing, third.written], [2, 0]);
    const rows = readFixedPointRows(join(outDir, "results.jsonl"));
    assert.deepEqual(rows.map(fixedPointKey).sort(), ["s1-3|none|1", "s1-3|none|2"]);
    // 作废与死在中途的两次尝试：治理根整体移到隔离目录，重来时治理根里只有第 1、2 步的会话与这一遍的新会话
    const voided = join(outDir, "voided", "s1-3");
    assert.deepEqual(readdirSync(voided).sort(), ["none-1", "none-2"]);
    for (const r of rows) {
      const sessions = join(outDir, "passes", "s1-3", `none-${r.pass}`, ".pigeon", "sessions");
      const ids = listSessionIds(sessions).map(String);
      assert.equal(
        ids.length,
        (events.events[0]?.priorSessionFiles.filter((f) => !f.includes(".messages.")).length ?? 0) +
          1
      );
      assert.ok(ids.includes(r.sessionId));
      assert.equal(
        materializeSession(sessions, r.sessionId as never, { content: false }).runStarteds.length,
        1
      );
    }
  });

  test("首轮判定只用首轮之前的事实：agent 回炉时改了题面以外的人写测试，这一遍仍记为首轮变红；回炉判据看第 2 次验证；记忆被用上的时间窗口不错位", async () => {
    const cheat = {
      text: "改测试",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "src/core.test.ts",
            old_string: "CORE_OK core works",
            new_string: "CORE2_OK core works",
          },
        },
      ],
    };
    // 不带组第 4 步：首轮前删了 core 的标记（core 的测试在题面以外变红）并改了 core 的测试（验证前被还原）；
    // 回炉时再改 core 的测试、补回 core
    const cheating = (): FakeReply[] => [
      {
        text: "改一下",
        toolCalls: [...(noMemoryReplies(4)[0]?.toolCalls ?? []), ...(cheat.toolCalls ?? [])],
      },
      { text: "好了" },
      {
        text: "再改",
        toolCalls: [
          ...(cheat.toolCalls ?? []),
          {
            name: "edit_file",
            args: {
              path: "src/core.ts",
              old_string: "core = 1; //",
              new_string: "core = 1; // CORE_OK",
            },
          },
        ],
      },
      { text: "好了" },
    ];
    const a = await runFixedPoint(
      options({
        events: only(["s1-4"]),
        outDir: join(toy.base, "out-cheat"),
        groups: ["none"],
        passes: 1,
        agentFor: rerunAgent([], [], cheating),
      })
    );
    assert.deepEqual(a.stopped, []);
    const [cheated] = readFixedPointRows(a.resultsFile);
    assert.equal(
      cheated?.firstVerify.offTaskRed,
      true,
      "core 的测试不因 agent 改过它而算作题面测试"
    );
    assert.deepEqual(
      [cheated?.repairVerify.entered, cheated?.repairVerify.offTaskRed],
      [true, false]
    );
    assert.equal(cheated?.memoryUsed, true, "不带组的基线：回炉那一轮里改了补改文件 core.ts");
    // 带记忆组第 3 步：首轮前什么都没改（题面测试失败、进回炉），回炉时才改 core.ts——开局给的记忆不算用上
    const late = (): FakeReply[] => [{ text: "先看看" }, ...(RIGHT_FIRST_TIME[3] ?? [])];
    const b = await runFixedPoint(
      options({
        events: only(["s1-3"]),
        outDir: join(toy.base, "out-late"),
        groups: ["memory"],
        passes: 1,
        agentFor: rerunAgent([], [], late),
      })
    );
    assert.deepEqual(b.stopped, []);
    const [lateRow] = readFixedPointRows(b.resultsFile);
    assert.equal(lateRow?.firstVerify.failed, true);
    assert.equal(lateRow?.firstVerify.offTaskRed, false, "只是题面测试没过");
    assert.equal(lateRow?.memoryUsed, false);
  });

  test("放行与作废同跑批器：这一遍在网关排队超过阈值即中止并整遍作废、不写行，治理根移出后从起点重来", async () => {
    // 假网关：第一遍开始排队看守后不久报排队超时（这个作业累计等空闲账号超过阈值），之后一切正常
    const meters = new Map<string, GatewayMeter>();
    const zero: GatewayMeter = {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      upstreamFailures: 0,
      queueMs: 0,
      peakInFlight: 0,
      accountRequests: [],
    };
    let watches = 0;
    const gateway = {
      jobBaseUrl: (job: string) => `http://127.0.0.1:9/j/${job}`,
      meter: (job: string) => ({ ...(meters.get(job) ?? zero) }),
      resetPeak: () => {},
      watchQueue(job: string, thresholdMs: number, listener: () => void) {
        watches += 1;
        if (watches > 1) return () => {};
        const timer = setTimeout(() => {
          meters.set(job, { ...(meters.get(job) ?? zero), queueMs: thresholdMs + 1 });
          listener();
        }, 200);
        return () => clearTimeout(timer);
      },
    };
    const outDir = join(toy.base, "out-queue");
    const summary = await runFixedPoint(
      options({
        events: only(["s1-3"]),
        outDir,
        groups: ["none"],
        passes: 1,
        gateway,
        agentFor: rerunAgent([], [], (s) => RIGHT_FIRST_TIME[s.step.seq] ?? []),
      })
    );
    assert.deepEqual(summary.stopped, []);
    assert.equal(watches, 2, "排队超时的一遍作废后从起点重来一次");
    const rows = readFixedPointRows(summary.resultsFile);
    assert.equal(rows.length, 1, "作废的一遍不写行");
    assert.equal(rows[0]?.gateway?.queueMs, 0);
    assert.deepEqual(readdirSync(join(outDir, "voided", "s1-3")), ["none-1"]);
  });

  test("一致性核对：运行面与原尝试不同（换推理档位）即拒绝、不写结果行；事件清单须出自同一份整流输出；同一输出目录被另一进程占用即拒绝", async () => {
    const opened = toy.envs.opened.length;
    const locked = join(toy.base, "out-locked");
    mkdirSync(locked, { recursive: true });
    const release = lockOutDir(locked);
    try {
      await assert.rejects(
        runFixedPoint(options({ outDir: locked, agentFor: rerunAgent([], [], () => []) })),
        (error: unknown) =>
          error instanceof ExclusiveLockError && /正被另一个跑批进程使用/.test(String(error))
      );
    } finally {
      release();
    }
    assert.equal(toy.envs.opened.length, opened, "一个环境都没开");
    const tampered: FixedPointEventList = {
      ...events,
      noMemory: { ...events.noMemory, streams: [{ id: "s1", resultsDigest: "0".repeat(16) }] },
    };
    await assert.rejects(
      runFixedPoint(
        options({
          events: tampered,
          outDir: join(toy.base, "out-tampered"),
          agentFor: rerunAgent([], [], () => []),
        })
      ),
      /不是出自这份无记忆整流输出/
    );
    const outDir = join(toy.base, "out-thinking");
    const summary = await runFixedPoint(
      options({
        events: only(["s1-3"]),
        outDir,
        groups: ["none"],
        passes: 1,
        agentFor: rerunAgent(
          [],
          [],
          (s) => RIGHT_FIRST_TIME[s.step.seq] ?? [],
          (rt) => ({ ...rt, thinkingLevel: "high" })
        ),
      })
    );
    assert.equal(summary.written, 0);
    assert.match(summary.stopped[0]?.error ?? "", /推理档位不同/);
    assert.ok(summary.stopped.every((s) => s.error.includes("拒绝")));
    assert.equal(readFixedPointRows(summary.resultsFile).length, 0);
  });
});
