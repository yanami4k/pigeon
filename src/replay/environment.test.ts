// 验证环境摘要与批准失效（M8 S8，决策 091）：摘要记全；失效判据只看封闭四项清单，
// 清单外的项只记录不判定。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VerificationEnvironment } from "../state/event-log.ts";
import { APPROVAL_STALENESS_KEYS, experienceSetHash, stalenessReasons } from "./environment.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function environment(): VerificationEnvironment {
  return {
    model: { provider: "anthropic", id: "claude-x", thinkingLevel: "off", maxOutputTokens: 16_384 },
    harness: { commit: "abc1234", dirty: false },
    runtime: { node: "v22.19.0", platform: "win32" },
    budget: { maxTurns: 40, wallClockMs: 1_800_000 },
    verify: { command: "npm test", timeoutMs: 300_000, source: "project" },
    experienceSetHash: experienceSetHash([
      { kind: "skill", name: "read-before-edit", contentHash: HASH_A, bytes: 10, candidate: true },
    ]),
    experiences: [
      { kind: "skill", name: "read-before-edit", contentHash: HASH_A, bytes: 10, candidate: true },
    ],
  };
}

test("经验集合内容哈希：与登记顺序无关，内容变一个字节即变", () => {
  const one = {
    kind: "skill" as const,
    name: "a",
    contentHash: HASH_A,
    bytes: 1,
    candidate: true,
  };
  const two = {
    kind: "memory" as const,
    name: "b",
    contentHash: HASH_B,
    bytes: 2,
    candidate: false,
  };
  assert.equal(experienceSetHash([one, two]), experienceSetHash([two, one]));
  assert.notEqual(
    experienceSetHash([one, two]),
    experienceSetHash([one, { ...two, contentHash: HASH_A }])
  );
  assert.notEqual(experienceSetHash([one]), experienceSetHash([one, two]));
});

test("失效判据：封闭四项清单，一项不同即失效并指名是哪一项", () => {
  assert.deepEqual(APPROVAL_STALENESS_KEYS, ["model", "experienceSet", "budget", "verifyCommand"]);
  const approved = environment();
  assert.deepEqual(stalenessReasons(approved, approved), []);
  const cases: Array<[string, VerificationEnvironment]> = [
    ["model", { ...approved, model: { ...approved.model, id: "claude-y" } }],
    ["experienceSet", { ...approved, experienceSetHash: HASH_B }],
    ["budget", { ...approved, budget: { ...approved.budget, maxTurns: 80 } }],
    ["verifyCommand", { ...approved, verify: { ...approved.verify, command: "npm run verify" } }],
  ];
  for (const [key, current] of cases) {
    const reasons = stalenessReasons(approved, current);
    assert.equal(reasons.length, 1, key);
    assert.equal(reasons[0]?.key, key);
  }
});

test("失效判据：单轮输出上限算预算参数——收紧与放宽都算变化", () => {
  const approved = environment();
  const reasons = stalenessReasons(approved, {
    ...approved,
    model: { ...approved.model, maxOutputTokens: 8192 },
  });
  assert.deepEqual(
    reasons.map((reason) => reason.key),
    ["budget"]
  );
});

// M8 收口修复：当下这一侧取不到某一项时，既不判相同也不判不同，直接跳过——
// 交互会话没有预算可言，拿"不设限"去和回执里的真实数字比会每次开会话都报一次假失效
test("失效判据：列进 unknown 的项不参与判定，其余项照判", () => {
  const approved = environment();
  const changed: VerificationEnvironment = {
    ...approved,
    budget: { maxTurns: 40 },
    model: { ...approved.model, id: "claude-y" },
  };
  assert.deepEqual(
    stalenessReasons(approved, changed).map((reason) => reason.key),
    ["model", "budget"]
  );
  assert.deepEqual(
    stalenessReasons(approved, changed, new Set(["budget"])).map((reason) => reason.key),
    ["model"],
    "跳过预算不等于跳过别的"
  );
  assert.deepEqual(
    stalenessReasons(approved, changed, new Set(["budget", "model"])).map((reason) => reason.key),
    []
  );
});

test("失效判据：清单外的项只记录不判定", () => {
  const approved = environment();
  const outside: VerificationEnvironment[] = [
    { ...approved, harness: { commit: "def5678", dirty: true } },
    { ...approved, runtime: { node: "v24.0.0", platform: "linux" } },
    { ...approved, verify: { ...approved.verify, timeoutMs: 60_000 } },
    { ...approved, verify: { ...approved.verify, source: "flag" } },
    { ...approved, model: { ...approved.model, thinkingLevel: "high" } },
    { ...approved, experiences: [] },
  ];
  for (const current of outside) {
    assert.deepEqual(stalenessReasons(approved, current), []);
  }
});

test("失效判据：预算项从不设限变成设限、或反过来，都算变化", () => {
  const approved = environment();
  assert.equal(stalenessReasons(approved, { ...approved, budget: {} }).length, 1);
  assert.equal(
    stalenessReasons({ ...approved, budget: {} }, { ...approved, budget: { maxTokens: 1000 } })
      .length,
    1
  );
});
