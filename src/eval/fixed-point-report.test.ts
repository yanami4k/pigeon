// 定点对照的汇总（决策 139、164）：主判据按记忆给出时机拆开分开报；按键去重、遍次上限、组别取自结果文件；
// 实际给出与指定不一致的遍次不进配对；"用上"三组并列
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  FixedPointEvent,
  FixedPointEventList,
  FixedPointGroup,
} from "./fixed-point-events.ts";
import { criterionStats, renderFixedPointReport } from "./fixed-point-report.ts";
import type { FixedPointRow } from "./fixed-point-results.ts";
import { ZERO_USAGE } from "./stream-results.ts";

function event(
  id: string,
  timing: { opening: boolean; repair: boolean },
  irrelevantMissing = false
): FixedPointEvent {
  const opening = timing.opening ? ["m1"] : [];
  const repair = timing.repair ? ["m2"] : [];
  return {
    id,
    stream: "s1",
    seq: Number(id.split("-")[1]),
    commit: "c",
    kind: "task",
    startHead: "h",
    startSeq: 2,
    priorSessionFiles: [],
    priorStepStarts: [],
    stepSession: "s",
    firstRunId: "r",
    picked: { opening, repair: timing.repair ? [{ round: 1, ids: repair }] : [] },
    relevant: [],
    irrelevant: irrelevantMissing ? null : [],
    fixed: {
      memory: { opening, repair },
      irrelevant: irrelevantMissing
        ? null
        : { opening: opening.map(() => "x1"), repair: repair.map(() => "x2") },
      none: { opening: [], repair: [] },
    },
  };
}

// first：首轮是否题面以外变红；repair：undefined 为没进回炉，否则为回炉后下一次验证是否题面以外变红
function row(
  eventId: string,
  group: FixedPointGroup,
  pass: number,
  first: boolean | null,
  repair?: boolean | null,
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
    givenMatch: { opening: true, repair: repair === undefined ? [] : [true] },
    firstVerify: {
      failed: repair !== undefined ? true : first,
      offTaskRed: first,
      offTaskFailures: [],
      undetermined: first === null ? ["测试"] : [],
    },
    repairVerify:
      repair === undefined
        ? { entered: false, offTaskRed: null, offTaskFailures: [], undetermined: [] }
        : {
            entered: true,
            offTaskRed: repair,
            offTaskFailures: [],
            undetermined: repair === null ? ["测试"] : [],
          },
    repairRounds: repair === undefined ? 0 : 1,
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
    admissionWaitMs: 0,
    limitPauses: [],
    harnessRef: { commit: "t", dirty: false },
    ...extra,
  };
}

// s1-3：只在开局挑到；s1-4：只在回炉挑到；s1-5：两个时机都挑到（无关组缺失）
const LIST: FixedPointEventList = {
  version: 1,
  repo: "memtoy",
  noMemory: { attempt: 1, streams: [] },
  events: [
    event("s1-3", { opening: true, repair: false }),
    event("s1-4", { opening: false, repair: true }),
    event("s1-5", { opening: true, repair: true }, true),
  ],
  scanned: [],
};

const ROWS: FixedPointRow[] = [
  // s1-3 开局：带记忆 1/4 变红（另 1 遍判不清），不带 3/5，无关 2/5
  ...[true, false, false, false, null].map((r, i) =>
    row("s1-3", "memory", i + 1, r, undefined, { memoryUsed: i < 2 })
  ),
  ...[true, true, true, false, false].map((r, i) =>
    row("s1-3", "none", i + 1, r, undefined, { memoryUsed: i < 1 })
  ),
  ...[true, true, false, false, false].map((r, i) => row("s1-3", "irrelevant", i + 1, r)),
  // s1-4 回炉：带记忆 4 遍进回炉、回炉后 1 遍仍红；首轮都红（不进开局判据）。不带 2 遍进回炉、都仍红
  ...[false, false, true, false].map((r, i) => row("s1-4", "memory", i + 1, true, r)),
  row("s1-4", "memory", 5, false),
  ...[true, true].map((r, i) => row("s1-4", "none", i + 1, true, r)),
  ...[3, 4, 5].map((p) => row("s1-4", "none", p, false)),
  // s1-5 两个时机：开局带记忆 0/5、不带 2/5；回炉只有带记忆组有进回炉的遍次（不带组没有）→ 回炉判据缺失
  ...[0, 1, 2, 3, 4].map((i) => row("s1-5", "memory", i + 1, false, i === 0 ? false : undefined)),
  ...[true, true, false, false, false].map((r, i) => row("s1-5", "none", i + 1, r)),
];

const approx = (a: number | null | undefined, b: number) =>
  assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

test("主判据按时机拆开：只在回炉给记忆的事件不进开局判据；两个时机都有的事件两边都计入", () => {
  const opening = criterionStats(LIST, ROWS, "opening", 5);
  const repair = criterionStats(LIST, ROWS, "repair", 5);
  assert.deepEqual(
    opening.map((s) => s.eventId),
    ["s1-3", "s1-5"]
  );
  assert.deepEqual(
    repair.map((s) => s.eventId),
    ["s1-4", "s1-5"]
  );
  approx(opening[0]?.pairedDiff, 1 / 4 - 3 / 5);
  approx(opening[0]?.irrelevantDiff, 2 / 5 - 3 / 5);
  approx(opening[1]?.pairedDiff, 0 - 2 / 5);
});

test("回炉判据只取进入回炉的遍次，按事件、按组算比例后配对；某组没有进入回炉的遍次即该事件缺失、不补值", () => {
  const [e4, e5] = criterionStats(LIST, ROWS, "repair", 5);
  assert.equal(e4?.groups.memory?.eligible, 4);
  assert.equal(e4?.groups.none?.eligible, 2);
  approx(e4?.pairedDiff, 1 / 4 - 1);
  assert.equal(e5?.groups.none?.eligible, 0);
  assert.equal(e5?.pairedDiff, null);
});

test("结果行按事件 × 组 × 遍次去重、只计遍次号不超过遍数的", () => {
  const extra = [
    row("s1-3", "memory", 1, false), // 重复键：留先写的（变红）
    row("s1-3", "memory", 6, true), // 超出遍数
    row("s1-3", "none", 6, true),
  ];
  const [e3] = criterionStats(LIST, [...ROWS, ...extra], "opening", 5);
  approx(e3?.groups.memory?.redRate, 1 / 4);
  approx(e3?.groups.none?.redRate, 3 / 5);
});

test("意向处理：实际给出与指定不一致的遍次照样进各自判据的分母（记忆组第 2 轮回炉时条目被拦下的一遍仍计入），只按时机、按组单列计数；开局不一致醒目提示", () => {
  const mismatched = ROWS.map((r) => {
    if (r.eventId === "s1-4" && r.group === "memory" && r.pass === 3) {
      return { ...r, repairRounds: 2, givenMatch: { opening: true, repair: [true, false] } };
    }
    if (r.eventId === "s1-3" && r.group === "memory" && r.pass === 1) {
      return { ...r, givenMatch: { opening: false, repair: [] } };
    }
    return r;
  });
  const [e4] = criterionStats(LIST, mismatched, "repair", 5, "repair-only");
  assert.deepEqual([e4?.groups.memory?.eligible, e4?.groups.memory?.red], [4, 1]);
  const [e3] = criterionStats(LIST, mismatched, "opening", 5);
  approx(e3?.groups.memory?.redRate, 1 / 4);
  const text = renderFixedPointReport(LIST, mismatched, { passes: 5 });
  assert.match(text, /\| 开局 \| 1 \| 0 \| 0 \|/);
  assert.match(text, /\| 回炉（任一轮） \| 1 \| 0 \| 0 \|/);
  assert.match(text, /注意：开局时机出现 1 遍实际给出与指定不一致/);
  assert.doesNotMatch(renderFixedPointReport(LIST, ROWS, { passes: 5 }), /注意：开局时机/);
});

test("回炉判据分三行：只在回炉时机挑到记忆的事件、两个时机都有的事件、两者合计；两种事件各落在对应的行", () => {
  assert.deepEqual(
    criterionStats(LIST, ROWS, "repair", 5, "repair-only").map((s) => s.eventId),
    ["s1-4"]
  );
  assert.deepEqual(
    criterionStats(LIST, ROWS, "repair", 5, "both").map((s) => s.eventId),
    ["s1-5"]
  );
  const text = renderFixedPointReport(LIST, ROWS, { passes: 5 });
  const repair = text.slice(text.indexOf("## 回炉事件"), text.indexOf("## 辅助指标"));
  assert.match(
    repair,
    /\| 只在回炉时机挑到记忆的事件（主看） \| 1 \| 1 \| 0 \| -75\.0 \| 0 \| 1 \| 0 \| —（0 个事件） \| 0 \|/
  );
  assert.match(
    repair,
    /\| 两个时机都有的事件（筛选发生在开局记忆之后，仅供参考） \| 1 \| 0 \| 1 \| — \| 0 \| 0 \| 0 \| —（0 个事件） \| 0 \|/
  );
  assert.match(
    repair,
    /\| 两者合计 \| 2 \| 1 \| 1 \| -75\.0 \| 0 \| 1 \| 0 \| —（0 个事件） \| 0 \|/
  );
});

test("报告：开局判据的配对差均值、帮倒忙事件数与无关对照；组别取自结果文件；用上三组并列", () => {
  const text = renderFixedPointReport(LIST, ROWS, { passes: 5 });
  const opening = text.slice(text.indexOf("## 开局事件"), text.indexOf("## 回炉事件"));
  assert.match(
    opening,
    /\| 开局挑到记忆的事件 \| 2 \| 2 \| 0 \| -37\.5 \| 0 \| 2 \| 0 \| -20\.0（1 个事件） \| 1 \|/
  );
  assert.match(text, /带无关记忆组缺失的事件数（找不到候选） \| 1 \|/);
  assert.match(text, /\| 记忆被用上 \| 2\/5（40\.0%） \| — \| 1\/5（20\.0%） \|/);
  assert.match(text, /带记忆减不带的"用上"比例差（百分点）：\+20\.0/);
  // 组别取自结果文件：只有两组的结果也照样出这两列
  const twoGroups = renderFixedPointReport(
    LIST,
    ROWS.filter((r) => r.group !== "irrelevant"),
    { passes: 5 }
  );
  assert.match(twoGroups, /\| 事件 \| 步 \| 两个时机都有 \| 带记忆变红 \| 不带变红 \|/);
});
