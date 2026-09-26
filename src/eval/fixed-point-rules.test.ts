// 定点对照的纯规则（决策 131、139、156、157）：无关记忆的取法、首轮"题面以外变红"的口径、重跑的一致性核对、流历史的切片
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderEntry } from "../memory/structured-select.ts";
import { buildMemoryEntries, type MemoryEntry } from "../memory/structured-store.ts";
import { sessionContentFilePath } from "../persistence/session-read.ts";
import { AttemptFidelityError } from "../replay/fidelity.ts";
import type { AttemptPlan } from "../replay/plan.ts";
import { newEntryId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { buildMessageContent } from "../state/message-content.ts";
import { type FrictionFact, frictionAnchors } from "../state/structured-memory.ts";
import { type Fingerprint, fingerprintKey } from "../state/verify-fingerprint.ts";
import { chooseIrrelevant, StepStartMissingError, sliceHistory } from "./fixed-point-events.ts";
import {
  assertRerunFidelity,
  assertSameRepairRounds,
  assertSessionTask,
  FidelityRejectedError,
  givenMatches,
  offTaskRedOf,
  rerunBudget,
  scheduleJobs,
  taskBlocksMatch,
  taskTestFilesAt,
} from "./fixed-point-rerun.ts";
import {
  appendFixedPointRow,
  type FixedPointRow,
  readFixedPointRows,
} from "./fixed-point-results.ts";

const AT = Date.UTC(2026, 8, 20, 8, 0, 0);

function fact(
  stepName: string,
  fingerprint: Fingerprint,
  changed: string[],
  repair: string[]
): FrictionFact {
  return {
    kind: "regression",
    sessionId: newSessionId(),
    stepName,
    stepKind: fingerprint.tool === "tsc" ? "type" : "test",
    fingerprint,
    fingerprintKey: fingerprintKey(stepName, fingerprint),
    at: AT,
    workspace: "/testbed",
    redAt: AT - 1000,
    changedAtRed: changed,
    repairFiles: repair,
  };
}

const testFp = (file: string, name: string): Fingerprint => ({
  tool: "node-test",
  test: name,
  file,
  names: [name],
});

function entries(): { byAnchor: Map<string, MemoryEntry>; all: MemoryEntry[] } {
  const all = buildMemoryEntries([
    // 被换的那条（挂在 src/a.ts 上）与它同一件事挂在 src/a.test.ts 上的另一条
    fact("测试", testFp("src/a.test.ts", "a works"), ["src/a.ts"], ["src/a.ts"]),
    // 成文长度与被换那条完全相同：两个锚点
    fact("测试", testFp("src/c.test.ts", "c works"), ["src/c.ts"], ["src/c.ts"]),
    // 成文长得多
    fact(
      "类型",
      { tool: "tsc", code: "TS2304", file: "src/bee/deeply/nested/module.ts", names: ["Bee"] },
      ["src/bee/deeply/nested/module.ts"],
      ["src/bee/deeply/nested/module.ts"]
    ),
    // 挂在本步题面指到的文件上
    fact("测试", testFp("src/t.test.ts", "t works"), ["src/t.ts"], ["src/t.ts"]),
  ]);
  const byAnchor = new Map(all.map((e) => [e.anchor, e]));
  return { byAnchor, all };
}

test("无关记忆：取成文长度最接近的、取自其他文件的真实记忆，平手按编号取最小；与候选顺序无关", () => {
  const { byAnchor, all } = entries();
  const relevant = byAnchor.get("src/a.ts") as MemoryEntry;
  const excluded = new Set(["src/t.ts", "src/t.test.ts"]);
  const chosen = chooseIrrelevant([relevant], all, excluded)?.get(relevant.id);
  const tied = ["src/c.test.ts", "src/c.ts"].map((a) => byAnchor.get(a) as MemoryEntry);
  assert.equal(renderEntry(tied[0] as MemoryEntry).length, renderEntry(relevant).length);
  assert.equal(chosen?.id, tied.map((e) => e.id).sort()[0]);
  const reversed = chooseIrrelevant([relevant], [...all].reverse(), excluded)?.get(relevant.id);
  assert.equal(reversed?.id, chosen?.id, "候选顺序不影响结果");
});

test("无关记忆：不取本步相关文件（题面指到的、本步改动的）、不取与被换条目同锚点或同指纹的；找不到即该组缺失", () => {
  const { byAnchor } = entries();
  const relevant = byAnchor.get("src/a.ts") as MemoryEntry;
  const sibling = byAnchor.get("src/a.test.ts") as MemoryEntry;
  const onTask = byAnchor.get("src/t.ts") as MemoryEntry;
  // 只剩挂在本步相关文件上的与同一件事的另一条：一条都不能取
  assert.equal(
    chooseIrrelevant([relevant], [relevant, sibling, onTask], new Set(["src/t.ts"])),
    null
  );
  // 相关文件一旦不在排除集里，同一条就成了候选（本条用例的反面）
  assert.equal(
    chooseIrrelevant([relevant], [relevant, sibling, onTask], new Set())?.get(relevant.id)?.id,
    onTask.id
  );
});

test("无关记忆按整条事实排除：一条事实展开成几条条目，只要有一条的锚点落在本步相关文件上，同一指纹的条目全不取（它们的成文都写着那个文件）", () => {
  const { byAnchor } = entries();
  const relevant = byAnchor.get("src/a.ts") as MemoryEntry;
  // F3：util 的测试回归，变红时已改的文件里有本步题面指到的 src/core.ts
  const f3 = buildMemoryEntries([
    fact("测试", testFp("src/u.test.ts", "u works"), ["src/core.ts", "src/u.ts"], ["src/u.ts"]),
  ]);
  const onUtil = f3.find((e) => e.anchor === "src/u.ts") as MemoryEntry;
  assert.match(renderEntry(onUtil), /src\/core\.ts/, "它的成文里写着 core.ts");
  assert.equal(chooseIrrelevant([relevant], [onUtil], new Set(["src/core.ts"]), f3), null);
  // 被换条目涉及的文件同样按整条事实排除：F4 变红时改过被换那条的补改文件 src/a.ts
  const f4 = buildMemoryEntries([
    fact("测试", testFp("src/v.test.ts", "v works"), ["src/a.ts", "src/v.ts"], ["src/v.ts"]),
  ]);
  const onV = f4.find((e) => e.anchor === "src/v.ts") as MemoryEntry;
  assert.equal(chooseIrrelevant([relevant], [onV], new Set(), f4), null);
});

test("无关记忆按整条事实排除看同指纹的全部事实与全部条目：较旧的一条事实碰过题面文件，候选条目最近一次事实的锚点里没有它，也不取；核验没过的同指纹条目同样算数", () => {
  const { byAnchor } = entries();
  const relevant = byAnchor.get("src/a.ts") as MemoryEntry;
  const fp = testFp("src/x.test.ts", "x works");
  const older = { ...fact("测试", fp, ["src/core.ts", "src/x.ts"], ["src/x.ts"]), at: AT - 60_000 };
  const newer = fact("测试", fp, ["src/x.ts"], ["src/x.ts"]);
  const all = buildMemoryEntries([older, newer]);
  const onX = all.find((e) => e.anchor === "src/x.ts") as MemoryEntry;
  const onCore = all.find((e) => e.anchor === "src/core.ts") as MemoryEntry;
  assert.ok(onCore !== undefined, "较旧的事实展开出挂在 core.ts 上的条目");
  assert.ok(
    !frictionAnchors(onX.latest).includes("src/core.ts"),
    "候选最近一次事实的锚点里没有 core.ts"
  );
  // 候选池里只有核验通过的 onX；挂在 core.ts 上的那条核验没过、只在全部条目里
  assert.equal(chooseIrrelevant([relevant], [onX], new Set(["src/core.ts"]), all), null);
});

test("无关记忆先同种类：被换的是撤回类就只取撤回类，没有同种类的候选即该组缺失", () => {
  const { byAnchor } = entries();
  const regression = byAnchor.get("src/c.ts") as MemoryEntry;
  const reverted: MemoryEntry = { ...(byAnchor.get("src/a.ts") as MemoryEntry), kind: "reverted" };
  assert.equal(chooseIrrelevant([reverted], [regression], new Set()), null);
  const otherReverted: MemoryEntry = { ...regression, kind: "reverted" };
  assert.equal(
    chooseIrrelevant([reverted], [regression, otherReverted], new Set())?.get(reverted.id),
    otherReverted
  );
});

test("无关记忆：同一事件里两条被换的条目换上的不重复、也不取同指纹的两条", () => {
  const { byAnchor, all } = entries();
  const a = byAnchor.get("src/a.ts") as MemoryEntry;
  const t = byAnchor.get("src/t.ts") as MemoryEntry;
  const chosen = chooseIrrelevant([a, t], all, new Set());
  assert.ok(chosen !== null);
  const picks = [...chosen.values()];
  assert.equal(new Set(picks.map((e) => e.fingerprintKey)).size, 2);
  for (const e of picks)
    assert.ok(![a.fingerprintKey, t.fingerprintKey].includes(e.fingerprintKey));
});

const NODE_FAIL = (file: string, name: string) =>
  [
    "ℹ tests 1",
    "ℹ fail 1",
    "",
    "✖ failing tests:",
    "",
    `test at ${file}:1:1`,
    `✖ ${name} (1.5ms)`,
    "  AssertionError",
  ].join("\n");

test("首轮变红口径（131）：类型等非测试步失败一律算；测试只算题面测试文件以外的用例", () => {
  const commands = new Map<string, string>();
  const tasks = new Set(["src/feature.test.ts", "src/feature.ts"]);
  const pass = {
    name: "类型",
    exitCode: 0,
    verdict: "pass" as const,
    output: "",
    truncated: false,
  };
  // 只有题面测试失败：不算变红
  assert.deepEqual(
    offTaskRedOf({
      steps: [
        pass,
        {
          name: "测试",
          exitCode: 1,
          verdict: "fail",
          output: NODE_FAIL("src/feature.test.ts", "feature works"),
          truncated: false,
        },
      ],
      commands,
      workspace: "/testbed",
      taskTestFiles: tasks,
    }),
    { offTaskRed: false, offTaskFailures: [], undetermined: [] }
  );
  // 题面以外的用例失败：算
  const off = offTaskRedOf({
    steps: [
      {
        name: "测试",
        exitCode: 1,
        verdict: "fail",
        output: NODE_FAIL("src/core.test.ts", "core works"),
        truncated: false,
      },
    ],
    commands,
    workspace: "/testbed",
    taskTestFiles: tasks,
  });
  assert.equal(off.offTaskRed, true);
  assert.match(off.offTaskFailures.join(), /core works @ src\/core\.test\.ts/);
  // 类型失败：一律算
  assert.equal(
    offTaskRedOf({
      steps: [
        {
          name: "类型",
          exitCode: 2,
          verdict: "fail",
          output: "src/feature.ts(1,1): error TS2304: Cannot find name 'X'.",
          truncated: false,
        },
      ],
      commands,
      workspace: "/testbed",
      taskTestFiles: tasks,
    }).offTaskRed,
    true
  );
});

test("首轮变红口径：判不清的不算变红——测试输出无法解析、题面测试文件认定不全、清单不全而列出的都属题面", () => {
  const tasks = new Set(["src/feature.test.ts"]);
  const failing = { name: "测试", exitCode: 1, verdict: "fail" as const, truncated: false };
  const r1 = offTaskRedOf({
    steps: [{ ...failing, output: "Segmentation fault" }],
    commands: new Map(),
    workspace: "/testbed",
    taskTestFiles: tasks,
  });
  assert.deepEqual([r1.offTaskRed, r1.undetermined], [null, ["测试"]]);
  const r2 = offTaskRedOf({
    steps: [{ ...failing, output: NODE_FAIL("src/core.test.ts", "core works") }],
    commands: new Map(),
    workspace: "/testbed",
    taskTestFiles: undefined,
  });
  assert.equal(r2.offTaskRed, null);
  const r3 = offTaskRedOf({
    steps: [
      { ...failing, output: NODE_FAIL("src/feature.test.ts", "feature works"), truncated: true },
    ],
    commands: new Map(),
    workspace: "/testbed",
    taskTestFiles: tasks,
  });
  assert.equal(r3.offTaskRed, null);
});

test("某次验证的题面测试文件只用这次验证之前的事实：之后才改的文件不算，验证前被还原的人写受保护测试不因 agent 改过而算", () => {
  const files = taskTestFilesAt({
    changes: [
      { at: 1, files: ["src/mine.test.ts", "src/core.test.ts"] },
      { at: 5, files: ["src/late.test.ts"] },
    ],
    at: 3,
    protectedFiles: new Set(["src/core.test.ts"]),
    dirtyAtStart: ["src/other.test.ts"],
    mentioned: ["src/other.ts"],
  });
  assert.deepEqual([...files].sort(), ["src/mine.test.ts", "src/other.test.ts", "src/other.ts"]);
});

test("作业顺序：遍次在外、组在内，同一事件同一遍次的各组相邻出队；组的先后按事件与遍次轮换；全部键各出现一次", () => {
  const groups = ["memory", "irrelevant", "none"] as const;
  const jobs = scheduleJobs(2, groups, 3);
  assert.equal(jobs.length, 18);
  assert.equal(new Set(jobs.map((j) => `${j.event}|${j.group}|${j.pass}`)).size, 18);
  for (let i = 0; i < jobs.length; i += 3) {
    const triple = jobs.slice(i, i + 3);
    assert.equal(new Set(triple.map((j) => `${j.event}|${j.pass}`)).size, 1, "三组相邻");
    assert.equal(new Set(triple.map((j) => j.group)).size, 3);
  }
  assert.deepEqual(
    jobs.map((j) => j.pass),
    [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3],
    "遍次在外"
  );
  const firstOf = (event: number, pass: number) =>
    jobs.find((j) => j.event === event && j.pass === pass)?.group;
  assert.deepEqual(
    [1, 2, 3].map((pass) => firstOf(0, pass)),
    ["irrelevant", "none", "memory"],
    "同一事件里先跑的组逐遍轮换"
  );
  assert.notEqual(firstOf(0, 1), firstOf(1, 1), "同一遍次里不同事件先跑的组也错开");
});

// 题面超过 64 KiB（单块存储上限）：账本里只存前缀、标截断并带全文哈希
const LONG_PROMPT = `src/big.test.ts\n\nAdd big\n\n--- src/big.test.ts ---\n${"// 一行测试代码 ".repeat(8000)}\n`;

// 写一个只有首条用户消息的会话内容文件（与账本存储同一转换，超过单块上限即截断）
function sessionWithTask(task: string): { dir: string; sessionId: SessionId; runId: RunId } {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-fp-task-"));
  const sessionId = newSessionId();
  const runId = newRunId();
  const content = buildMessageContent({ role: "user", content: task });
  const record = {
    version: 1,
    sessionId,
    runId,
    runSeq: 1,
    entryId: newEntryId(),
    timestamp: Date.now(),
    ...content,
  };
  writeFileSync(sessionContentFilePath(dir, sessionId), `${JSON.stringify(record)}\n`);
  return { dir, sessionId, runId };
}

test("题面核对：题面超过 64 KiB、账本存储截断时比全文哈希——与清单相同即通过，全文不同（截断前缀相同）即拒绝", () => {
  const blocks = buildMessageContent({ role: "user", content: LONG_PROMPT }).blocks;
  const [block] = blocks;
  assert.ok(block?.type === "text" && block.truncated, "存储截断");
  assert.deepEqual(taskBlocksMatch(blocks, LONG_PROMPT), { ok: true });
  const differentTail = `${LONG_PROMPT}// 清单比原尝试多一行\n`;
  assert.equal(taskBlocksMatch(blocks, differentTail).ok, false);
});

test("题面核对：未截断时逐字比较——相同即通过，不同即拒绝", () => {
  const blocks = buildMessageContent({ role: "user", content: "Add small\n" }).blocks;
  assert.deepEqual(taskBlocksMatch(blocks, "Add small\n"), { ok: true });
  assert.equal(taskBlocksMatch(blocks, "Add other\n").ok, false);
});

test("题面核对（真实内容文件）：开跑前与每遍跑完后的再核同用一个函数，截断题面按全文哈希通过、不同即以给定的错误拒绝", () => {
  const { dir, sessionId, runId } = sessionWithTask(LONG_PROMPT);
  try {
    assert.doesNotThrow(() =>
      assertSessionTask(dir, sessionId, runId, LONG_PROMPT, "这一遍", FidelityRejectedError)
    );
    assert.throws(
      () =>
        assertSessionTask(
          dir,
          sessionId,
          runId,
          `${LONG_PROMPT}x`,
          "这一遍",
          FidelityRejectedError
        ),
      (e: unknown) => e instanceof FidelityRejectedError && /全文的哈希不同/.test(String(e))
    );
    assert.throws(
      () =>
        assertSessionTask(dir, sessionId, newRunId(), LONG_PROMPT, "这一遍", FidelityRejectedError),
      /没有首条用户消息/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function plan(overrides: Partial<AttemptPlan> = {}): AttemptPlan {
  return {
    sessionId: newSessionId(),
    runId: newRunId(),
    task: "do it",
    startCommit: "a".repeat(40),
    startSource: "given",
    budget: { maxTurns: 150, wallClockMs: 600_000 },
    budgetSource: "run-started",
    model: { provider: "p", id: "m", thinkingLevel: "off", maxOutputTokens: 16384 },
    taskDirective: "D",
    approvalMode: "yolo",
    tools: ["edit_file", "read_file", "run_command"],
    ...overrides,
  };
}

test("一致性核对：重跑照搬原尝试即通过；预算收紧同样拒绝（预算与流中相同）", () => {
  assert.doesNotThrow(() => assertRerunFidelity(plan(), plan()));
  assert.throws(
    () => assertRerunFidelity(plan(), plan({ budget: { maxTurns: 100, wallClockMs: 600_000 } })),
    FidelityRejectedError
  );
});

test("一致性核对：预算放宽、多一件工具、换模型、换推理档位、换温度、换输出上限、换工作方式指令，一律拒绝", () => {
  const original = plan();
  const widened: Partial<AttemptPlan>[] = [
    { budget: { maxTurns: 151, wallClockMs: 600_000 } },
    { budget: { maxTurns: 150, wallClockMs: 600_001 } },
    { budget: { maxTurns: 150 } },
    { tools: ["edit_file", "read_file", "run_command", "write_file"] },
    { model: { provider: "p", id: "m2", thinkingLevel: "off", maxOutputTokens: 16384 } },
    { model: { provider: "p", id: "m", thinkingLevel: "high", maxOutputTokens: 16384 } },
    {
      model: {
        provider: "p",
        id: "m",
        thinkingLevel: "off",
        maxOutputTokens: 16384,
        temperature: 0,
      },
    },
    { model: { provider: "p", id: "m", thinkingLevel: "off", maxOutputTokens: 32768 } },
    { taskDirective: "E" },
  ];
  for (const w of widened) {
    assert.throws(
      () => assertRerunFidelity(original, plan(w)),
      FidelityRejectedError,
      JSON.stringify(w)
    );
  }
});

test("一致性核对：重跑的预算照搬原尝试；原尝试的预算不是跑批器的形态（缺轮数或墙钟、带 token 上限）即拒绝", () => {
  assert.deepEqual(rerunBudget(plan()), { maxTurns: 150, wallClockMs: 600_000 });
  assert.throws(() => rerunBudget(plan({ budget: { maxTurns: 150 } })), AttemptFidelityError);
  assert.throws(
    () => rerunBudget(plan({ budget: { maxTurns: 150, wallClockMs: 600_000, maxTokens: 9 } })),
    AttemptFidelityError
  );
});

test("给出与指定核对：开局与每一轮回炉分开记，逐条相同才算一致；被拦下、少给、多给、不是固定挑选都算不一致", () => {
  const fixed = { opening: ["m1"], repair: ["m2"] };
  const given = (opening: string[], repair: string[][], selection: string | null = "fixed") => ({
    selection,
    opening,
    repair,
  });
  assert.deepEqual(givenMatches(given(["m1"], [["m2"], ["m2"]]), fixed), {
    opening: true,
    repair: [true, true],
  });
  assert.deepEqual(givenMatches(given(["m1"], []), fixed), { opening: true, repair: [] });
  assert.deepEqual(givenMatches(given([], [["m2"]]), fixed), { opening: false, repair: [true] });
  assert.deepEqual(givenMatches(given(["m1"], [["m2"], []]), fixed), {
    opening: true,
    repair: [true, false],
  });
  assert.deepEqual(givenMatches(given(["m1", "m3"], []), fixed), { opening: false, repair: [] });
  assert.deepEqual(givenMatches(given(["m1"], [["m2"]], "auto"), fixed), {
    opening: false,
    repair: [false],
  });
});

test("一致性核对：回炉上限（run.started 冻结的值）与原尝试不同即拒绝", () => {
  assert.doesNotThrow(() => assertSameRepairRounds(3, 3));
  assert.throws(() => assertSameRepairRounds(3, 2), FidelityRejectedError);
});

test("撕裂行续跑：末行没有换行且解析不了的先截掉再追加；末行完整只是缺换行的补上换行", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-fp-torn-"));
  try {
    const file = join(dir, "results.jsonl");
    const row = (pass: number) =>
      ({ eventId: "s1-3", group: "none", pass }) as unknown as FixedPointRow;
    writeFileSync(file, `${JSON.stringify(row(1))}\n{"eventId":"s1-3","gro`);
    appendFixedPointRow(file, row(2));
    assert.deepEqual(
      readFixedPointRows(file).map((r) => r.pass),
      [1, 2]
    );
    assert.ok(readFileSync(file, "utf8").endsWith("\n"));
    writeFileSync(file, JSON.stringify(row(1)));
    appendFixedPointRow(file, row(2));
    assert.deepEqual(
      readFixedPointRows(file).map((r) => r.pass),
      [1, 2]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("流历史切片：只留起点可达的提交，带上指定的开工时的树（沿用原引用名）；取不到或不在起点之前即报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-fp-slice-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@example.invalid");
    const commit = (msg: string) => {
      git(repo, "commit", "-q", "--allow-empty", "-m", msg);
      return git(repo, "rev-parse", "HEAD");
    };
    const a = commit("a");
    const b = commit("b");
    // 第 2 步开工时的树：挂在 a 之下；第 3 步的挂在 b 之下
    const tree = git(repo, "rev-parse", "HEAD^{tree}");
    const baseA = git(repo, "commit-tree", tree, "-p", a, "-m", "pigeon step start");
    const baseB = git(repo, "commit-tree", tree, "-p", b, "-m", "pigeon step start");
    git(repo, "update-ref", "refs/pigeon/step-start/s1/2", baseA);
    git(repo, "update-ref", "refs/pigeon/step-start/s1/3", baseB);
    const c = commit("c");
    const full = join(dir, "full.bundle");
    git(repo, "bundle", "create", "-q", full, "--all");
    const bundle = readFileSync(full);
    const sliced = sliceHistory({ bundle, head: b, keep: [baseA], scratch: join(dir, "scratch") });
    const out = join(dir, "sliced.bundle");
    writeFileSync(out, sliced);
    const heads = git(dir, "bundle", "list-heads", out);
    assert.match(heads, new RegExp(`${b} refs/heads/main`));
    assert.match(heads, new RegExp(`${baseA} refs/pigeon/step-start/s1/2`));
    assert.doesNotMatch(heads, new RegExp(c));
    assert.doesNotMatch(heads, new RegExp(baseB));
    const check = join(dir, "check");
    execFileSync("git", ["init", "-q", check]);
    git(check, "fetch", "-q", out, "+refs/*:refs/*");
    assert.throws(() => git(check, "cat-file", "-e", `${c}^{commit}`), "后面各步的提交不在切片里");
    assert.throws(
      () =>
        sliceHistory({ bundle, head: b, keep: ["f".repeat(40)], scratch: join(dir, "scratch") }),
      StepStartMissingError
    );
    assert.throws(
      () => sliceHistory({ bundle, head: a, keep: [baseB], scratch: join(dir, "scratch") }),
      /不在起点/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
