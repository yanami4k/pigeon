// 定点对照的汇总（决策 139）：按事件配对的变红比例差、帮倒忙的事件数、无关记忆对照、用上比例；判不清与缺失单列
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  FixedPointEvent,
  FixedPointEventList,
  FixedPointGroup,
} from "./fixed-point-events.ts";
import { eventStats, renderFixedPointReport } from "./fixed-point-report.ts";
import type { FixedPointRow } from "./fixed-point-results.ts";
import { ZERO_USAGE } from "./stream-results.ts";

function event(id: string, irrelevantMissing = false): FixedPointEvent {
  const sel = { opening: ["m1"], repair: [] };
  return {
    id,
    stream: "s1",
    seq: Number(id.split("-")[1]),
    commit: "c",
    kind: "task",
    startHead: "h",
    priorSessionFiles: [],
    priorStepStarts: [],
    stepSession: "s",
    firstRunId: "r",
    picked: { opening: ["m1"], repair: [] },
    relevant: [],
    irrelevant: irrelevantMissing ? null : [],
    fixed: {
      memory: sel,
      irrelevant: irrelevantMissing ? null : { opening: ["x1"], repair: [] },
      none: { opening: [], repair: [] },
    },
  };
}

function row(
  eventId: string,
  group: FixedPointGroup,
  pass: number,
  red: boolean | null,
  extra: Partial<FixedPointRow> = {}
): FixedPointRow {
  return {
    eventId,
    stream: "s1",
    seq: Number(eventId.split("-")[1]),
    group,
    pass,
    sessionId: `sess-${eventId}-${group}-${pass}`,
    given: { selection: "fixed", opening: [], repair: [] },
    firstVerify: {
      failed: red,
      offTaskRed: red,
      offTaskFailures: [],
      undetermined: red === null ? ["测试"] : [],
    },
    repairRounds: red === true ? 1 : 0,
    finalVerdict: "pass",
    reverted: false,
    outcome: "passed",
    memoryUsed: null,
    memoryUsedFiles: [],
    status: "completed",
    turns: 3,
    usage: ZERO_USAGE,
    agentWallMs: 1,
    wallMs: 1,
    gateway: null,
    limitPauses: [],
    harnessRef: { commit: "t", dirty: false },
    ...extra,
  };
}

const LIST: FixedPointEventList = {
  version: 1,
  repo: "memtoy",
  noMemory: { attempt: 1, streams: [] },
  events: [event("s1-3"), event("s1-4", true)],
  scanned: [],
};

// 事件 3：带记忆 1/4 变红（另 1 遍判不清），不带 3/5，无关 2/5；事件 4：带记忆 3/5，不带 1/5（帮倒忙），无关组缺失
const ROWS: FixedPointRow[] = [
  ...[true, false, false, false, null].map((r, i) =>
    row("s1-3", "memory", i + 1, r, { memoryUsed: i < 2 })
  ),
  ...[true, true, true, false, false].map((r, i) => row("s1-3", "none", i + 1, r)),
  ...[true, true, false, false, false].map((r, i) => row("s1-3", "irrelevant", i + 1, r)),
  ...[true, true, true, false, false].map((r, i) =>
    row("s1-4", "memory", i + 1, r, { memoryUsed: false })
  ),
  ...[true, false, false, false, false].map((r, i) => row("s1-4", "none", i + 1, r)),
];

test("汇总：变红比例按判得清的遍次算；配对差为带记忆减不带，无关对照差为无关减不带", () => {
  const stats = eventStats(LIST, ROWS, ["memory", "irrelevant", "none"]);
  const [e3, e4] = stats;
  assert.equal(e3?.groups.memory?.redRate, 1 / 4);
  assert.equal(e3?.groups.memory?.undetermined, 1);
  assert.equal(e3?.groups.none?.redRate, 3 / 5);
  assert.ok(Math.abs((e3?.pairedDiff ?? 0) - (1 / 4 - 3 / 5)) < 1e-12);
  assert.ok(Math.abs((e3?.irrelevantDiff ?? 0) - (2 / 5 - 3 / 5)) < 1e-12);
  assert.ok(Math.abs((e4?.pairedDiff ?? 0) - (3 / 5 - 1 / 5)) < 1e-12);
  assert.equal(e4?.irrelevantDiff, null);
  assert.equal(e3?.groups.memory?.meanRepairRounds, 1 / 5);
});

test("汇总：报告列出配对差均值、帮倒忙的事件数、无关组缺失的事件数、用上比例与判不清的遍次", () => {
  const text = renderFixedPointReport(LIST, ROWS, {
    groups: ["memory", "irrelevant", "none"],
    passes: 5,
  });
  const mean = ((1 / 4 - 3 / 5 + (3 / 5 - 1 / 5)) / 2) * 100;
  assert.match(
    text,
    new RegExp(`按事件配对的均值（百分点） \\| ${mean > 0 ? "\\+" : ""}${mean.toFixed(1)} \\|`)
  );
  assert.match(text, /帮倒忙的事件数（带记忆组变红比例高于不带组） \| 1 \|/);
  assert.match(text, /带记忆组变红比例低于不带组的事件数 \| 1 \|/);
  assert.match(text, /带无关记忆组缺失的事件数（找不到候选） \| 1 \|/);
  assert.match(text, /记忆被用上的比例（带记忆组，可判定的遍次） \| 2\/10（20\.0%） \|/);
  assert.match(text, /首轮变红判不清的遍次 \| 1 \|/);
  assert.match(text, /结果行 \| 25 \/ 25 \|/);
  assert.match(
    text,
    /\| s1-3 \| 3 \| 开局 \| 1\/4（25\.0%） \| 3\/5（60\.0%） \| 2\/5（40\.0%） \| -35\.0 \| -20\.0 \|/
  );
  assert.match(text, /每一轮回炉都给/);
});
