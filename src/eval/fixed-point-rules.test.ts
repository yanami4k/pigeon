// 定点对照的纯规则（决策 131、139、156、157）：无关记忆的取法、首轮"题面以外变红"的口径、重跑的一致性核对、流历史的切片
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderEntry } from "../memory/structured-select.ts";
import { buildMemoryEntries, type MemoryEntry } from "../memory/structured-store.ts";
import { BudgetWidenedError } from "../replay/fidelity.ts";
import type { AttemptPlan } from "../replay/plan.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import type { FrictionFact } from "../state/structured-memory.ts";
import { type Fingerprint, fingerprintKey } from "../state/verify-fingerprint.ts";
import { chooseIrrelevant, StepStartMissingError, sliceHistory } from "./fixed-point-events.ts";
import {
  assertRerunFidelity,
  FidelityRejectedError,
  offTaskRedOf,
  rerunBudget,
} from "./fixed-point-rerun.ts";

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

test("一致性核对：重跑照搬原尝试即通过；预算收紧也通过", () => {
  assert.doesNotThrow(() => assertRerunFidelity(plan(), plan()));
  assert.doesNotThrow(() =>
    assertRerunFidelity(plan(), plan({ budget: { maxTurns: 100, wallClockMs: 600_000 } }))
  );
});

test("一致性核对：预算放宽、多一件工具、换模型、换推理档位、换温度、换输出上限、换工作方式指令或题面，一律拒绝", () => {
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
    { task: "do something else" },
  ];
  for (const w of widened) {
    assert.throws(
      () => assertRerunFidelity(original, plan(w)),
      FidelityRejectedError,
      JSON.stringify(w)
    );
  }
});

test("一致性核对：调用方要的预算比原尝试宽即拒绝；不给即照搬", () => {
  assert.deepEqual(rerunBudget(plan()), { maxTurns: 150, wallClockMs: 600_000 });
  assert.throws(
    () => rerunBudget(plan(), { maxTurns: 151, wallClockMs: 600_000 }),
    BudgetWidenedError
  );
  assert.deepEqual(rerunBudget(plan(), { maxTurns: 100, wallClockMs: 60_000 }), {
    maxTurns: 100,
    wallClockMs: 60_000,
  });
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
