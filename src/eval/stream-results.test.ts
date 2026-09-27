import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sampleLine } from "./stream-result-fixtures.ts";
import {
  LEGACY_STREAM_RESULT_FIELDS,
  lastCompletedStep,
  readStreamResults,
  STREAM_CONDITIONS,
  STREAM_RESULT_FIELDS,
  streamJobKey,
} from "./stream-results.ts";

test("结果行字段清单：要求的字段都在（起点、agent 改动的 diff、开容器耗时、回炉两字段、两种通过率、机检、轮数与用量、限额暂停）；新行不写延续式与撤回的字段", () => {
  for (const field of [
    "seq",
    "kind",
    "condition",
    "outcome",
    "start",
    "diff",
    "envOpenMs",
    "repairRounds",
    "finalVerdict",
    "fullPassRate",
    "quality",
    "turns",
    "usage",
    "wallMs",
    "limitPauses",
  ]) {
    assert.ok(STREAM_RESULT_FIELDS.includes(field as (typeof STREAM_RESULT_FIELDS)[number]), field);
  }
  assert.deepEqual(Object.keys(sampleLine()).sort(), [...STREAM_RESULT_FIELDS].sort());
  for (const field of LEGACY_STREAM_RESULT_FIELDS) {
    assert.equal(
      STREAM_RESULT_FIELDS.includes(field as (typeof STREAM_RESULT_FIELDS)[number]),
      false,
      field
    );
  }
  // 固定起点（193）下失去意义的延续式字段只读兼容
  for (const field of ["head", "regressions", "attribution", "reverted", "repairBudgetExhausted"]) {
    assert.ok(
      (LEGACY_STREAM_RESULT_FIELDS as readonly string[]).includes(field),
      `${field} 列为旧字段`
    );
  }
});

test("条件表（193、194）：四格为能否检索 × 有无推送，另加最简 agent；旧的 no-gate 与 memory 条件不再有", () => {
  assert.deepEqual(
    [...STREAM_CONDITIONS],
    ["search-push", "search-only", "push-only", "neither", "minimal"]
  );
});

test("旧结果行带撤回与延续式字段（reverted、head、regressions、attribution 等）：照常读出，字段原样保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-results-"));
  try {
    const file = join(dir, "results.jsonl");
    const legacy = {
      ...sampleLine({ seq: 1, condition: "search-only", outcome: "failed", repairRounds: 3 }),
      reverted: true,
      repairBudgetExhausted: true,
      head: "h1",
      regressions: 2,
      attribution: "not-done",
    };
    writeFileSync(file, `${JSON.stringify(legacy)}\n${JSON.stringify(sampleLine({ seq: 2 }))}\n`);
    const lines = readStreamResults(file);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.reverted, true);
    assert.equal(lines[0]?.repairBudgetExhausted, true);
    assert.equal(lines[0]?.head, "h1");
    assert.equal(lines[0]?.regressions, 2);
    assert.equal(lines[1]?.reverted, undefined);
    assert.equal(
      lastCompletedStep(lines, { stream: "tasks", condition: "search-only", attempt: 1 })?.seq,
      1
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("续跑断点：按（流、条件、第几遍）取已完成的最大步序；撕裂的末行不算", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-results-"));
  try {
    const file = join(dir, "results.jsonl");
    writeFileSync(file, "");
    for (const seq of [1, 2, 4]) appendFileSync(file, `${JSON.stringify(sampleLine({ seq }))}\n`);
    appendFileSync(file, `${JSON.stringify(sampleLine({ seq: 3, condition: "minimal" }))}\n`);
    appendFileSync(file, `{"repo":"pigeon-harness","stream":"tasks","seq":5,`);
    const lines = readStreamResults(file);
    assert.equal(lines.length, 4);
    const job = { stream: "tasks", condition: "neither" as const, attempt: 1 };
    assert.equal(lastCompletedStep(lines, job)?.seq, 4);
    assert.equal(lastCompletedStep(lines, { ...job, condition: "minimal" })?.seq, 3);
    assert.equal(lastCompletedStep(lines, { ...job, attempt: 2 }), undefined);
    assert.equal(streamJobKey(job), "tasks|neither|1");
    assert.deepEqual(readStreamResults(join(dir, "missing.jsonl")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
