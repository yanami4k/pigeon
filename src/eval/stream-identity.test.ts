import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkOrWriteIdentity, type StreamRunIdentity } from "./stream-identity.ts";
import { DEFAULT_STEP_BUDGET } from "./stream-runner.ts";

const identity = (over: Partial<StreamRunIdentity["core"]> = {}): StreamRunIdentity => ({
  core: {
    repo: "strands-py",
    manifestDigest: "abc",
    image: "sha256:img",
    budget: { maxTurns: 150, wallClockMs: 46 * 60_000 },
    conditions: ["full", "minimal"],
    maxSteps: null,
    agents: {
      pigeon: {
        provider: "kimi-coding",
        modelId: "m",
        temperature: 0,
        thinking: null,
        maxOutputTokens: null,
      },
      minimal: {
        model: "m",
        miniSweAgent: "1.0.0",
        litellm: "1.2.3",
        modelKwargs: { temperature: 0 },
      },
    },
    ...over,
  },
  info: { concurrency: 4, harness: { commit: "h1", dirty: false } },
});

test("正式跑批的预算缺省为每步 150 轮、46 分钟（147 校准）", () => {
  assert.deepEqual(DEFAULT_STEP_BUDGET, { maxTurns: 150, wallClockMs: 46 * 60_000 });
});

test("身份头：首次写入；续跑时身份一致放行（路数与跑批器代码版本只记不比），不一致即拒绝并列出不同的项", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-identity-"));
  try {
    const first = checkOrWriteIdentity(dir, identity());
    const saved = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    assert.equal(saved.core.budget.maxTurns, 150);
    assert.equal(saved.info.concurrency, 4);
    assert.match(first, /^[0-9a-f]{16}$/);
    // 降了路数、换了跑批器代码：照常续跑，摘要不变
    const resumed = checkOrWriteIdentity(dir, {
      ...identity(),
      info: { concurrency: 3, harness: { commit: "h2", dirty: true } },
    });
    assert.equal(resumed, first);
    // 预算不同、镜像不同、试跑的步数不同：拒绝，并说出是哪几项
    assert.throws(
      () =>
        checkOrWriteIdentity(
          dir,
          identity({ budget: { maxTurns: 400, wallClockMs: 90 * 60_000 }, image: "sha256:other" })
        ),
      /budget.*image|image.*budget/
    );
    assert.throws(() => checkOrWriteIdentity(dir, identity({ maxSteps: 5 })), /maxSteps/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("身份头：输出目录里已有结果、报告、作业目录或隔离目录却没有 identity.json，拒绝续跑、不补写身份头", () => {
  for (const leftover of ["results.jsonl", "report.md", "streams", "voided"]) {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-identity-"));
    try {
      if (leftover.includes(".")) writeFileSync(join(dir, leftover), "");
      else mkdirSync(join(dir, leftover));
      assert.throws(() => checkOrWriteIdentity(dir, identity()), /没有 identity\.json/);
      assert.equal(existsSync(join(dir, "identity.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
