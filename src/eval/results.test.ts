// 结果行的续跑键与读侧口径：错误行（status 为 error）不占（任务、条件、编辑模式、次序）这个键，重跑时补跑；
// 错误行保留在文件里；读侧按同一个键取最后一条非错误行，只有错误行的键取最后一条错误行（仍计为未完成）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyProcessMetrics } from "./process.ts";
import {
  completedResultKeys,
  EVAL_RESULT_FIELDS,
  type EvalResultLine,
  effectiveResultLines,
  isErrorResultLine,
  readResultLines,
  resultLineKey,
} from "./results.ts";

function line(overrides: Partial<EvalResultLine>): EvalResultLine {
  return {
    taskId: "t1",
    condition: "none",
    editMode: "replace",
    attempt: 1,
    holdout: false,
    sessionId: "sess_x",
    runId: "run_x",
    status: "completed",
    verdict: "pass",
    falsePositive: false,
    turns: 1,
    toolCalls: 0,
    approvalsNeeded: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    durationMs: 1,
    failureClass: null,
    harnessRef: { commit: "abc", dirty: false },
    process: emptyProcessMetrics("replace"),
    ...overrides,
  };
}

test("续跑键：只有非错误行占键；同键先错后成算已完成，只有错误行不算", () => {
  const errorOnly = line({ taskId: "a", status: "error", verdict: "undetermined", error: "抽风" });
  const errorThenOk = [
    line({ taskId: "b", status: "error", verdict: "undetermined", error: "抽风" }),
    line({ taskId: "b", status: "completed", verdict: "fail" }),
  ];
  const keys = completedResultKeys([errorOnly, ...errorThenOk]);
  assert.equal(keys.has(resultLineKey(errorOnly)), false);
  assert.equal(keys.has(resultLineKey(errorThenOk[1] as EvalResultLine)), true);
  assert.equal(keys.size, 1);
  assert.equal(isErrorResultLine(errorOnly), true);
  // 撞上限、模型失败等终态不是错误行：它们是这次运行的真实结果
  assert.equal(isErrorResultLine(line({ status: "wall-clock-limit", verdict: "fail" })), false);
  assert.equal(isErrorResultLine(line({ status: "failed", verdict: "undetermined" })), false);
});

test("续跑键区分任务、条件、编辑模式与次序；旧行缺编辑模式按 hashline", () => {
  const base = line({});
  const variants = [
    line({ taskId: "t2" }),
    line({ condition: "candidate" }),
    line({ editMode: "hashline" }),
    line({ attempt: 2 }),
  ];
  for (const variant of variants) {
    assert.notEqual(resultLineKey(variant), resultLineKey(base));
  }
  const legacy = { ...line({}) };
  delete legacy.editMode;
  assert.equal(resultLineKey(legacy), resultLineKey(line({ editMode: "hashline" })));
});

test("必有字段清单：新写的行必带整次墙钟 wallMs；难度随任务源可选，不在清单里；读侧容忍旧文件缺这些字段", () => {
  assert.ok((EVAL_RESULT_FIELDS as readonly string[]).includes("wallMs"));
  assert.equal((EVAL_RESULT_FIELDS as readonly string[]).includes("difficulty"), false);
  const dir = mkdtempSync(join(tmpdir(), "pigeon-results-"));
  try {
    const current = line({ taskId: "new", wallMs: 1234, difficulty: "<15 min fix" });
    const legacy = { ...line({ taskId: "old", wallMs: 1, difficulty: "x" }) } as Record<
      string,
      unknown
    >;
    // 删之前两者确实在场：否则"缺字段"只是因为从来没设过
    assert.equal(legacy.wallMs, 1);
    assert.equal(legacy.difficulty, "x");
    delete legacy.wallMs;
    delete legacy.difficulty;
    const file = join(dir, "results.jsonl");
    writeFileSync(file, `${JSON.stringify(current)}\n${JSON.stringify(legacy)}\n`);
    const read = readResultLines(file);
    assert.equal(read.length, 2);
    const [readCurrent, readLegacy] = read as [EvalResultLine, EvalResultLine];
    // 新行原样读回；旧行缺这两个字段也照常读回、照常占续跑键
    assert.equal(readCurrent.wallMs, 1234);
    assert.equal(readCurrent.difficulty, "<15 min fix");
    assert.equal(readLegacy.taskId, "old");
    assert.equal("wallMs" in readLegacy, false);
    assert.equal("difficulty" in readLegacy, false);
    assert.equal(completedResultKeys(read).size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("按旧口径写下的行不追溯改写：终态 failed 而带判决的旧行读回来仍是非错误行、照旧占键；口径变化只体现在新写的行上", () => {
  // 旧口径下，模型流以错误收尾的运行被照常判分，写成了"终态 failed、判决 fail"；现行 runner 对同样的运行写 error
  const legacyRow = line({
    taskId: "legacy",
    status: "failed",
    verdict: "fail",
    failureClass: "unknown",
  });
  assert.equal(isErrorResultLine(legacyRow), false);
  assert.equal(completedResultKeys([legacyRow]).has(resultLineKey(legacyRow)), true);
  assert.deepEqual(effectiveResultLines([legacyRow]), [legacyRow]);
});

test("读侧：同键取最后一条非错误行；其后的错误行不盖掉它；只有错误行的键取最后一条错误行；顺序按键首次出现", () => {
  const lines = [
    line({ taskId: "a", status: "error", verdict: "undetermined", error: "第一次抽风" }),
    line({ taskId: "b", verdict: "fail", sessionId: "sess_b1" }),
    line({ taskId: "a", verdict: "pass", sessionId: "sess_a2" }),
    line({ taskId: "b", status: "error", verdict: "undetermined", error: "之后的抽风" }),
    line({ taskId: "c", status: "error", verdict: "undetermined", error: "c 一" }),
    line({ taskId: "c", status: "error", verdict: "undetermined", error: "c 二" }),
  ];
  const effective = effectiveResultLines(lines);
  assert.deepEqual(
    effective.map((entry) => [entry.taskId, entry.status, entry.sessionId, entry.error]),
    [
      ["a", "completed", "sess_a2", undefined],
      ["b", "completed", "sess_b1", undefined],
      ["c", "error", "sess_x", "c 二"],
    ]
  );
});
