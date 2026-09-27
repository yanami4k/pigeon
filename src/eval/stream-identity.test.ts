import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentHarnessRef } from "./stream-harness.ts";
import { checkOrWriteIdentity, type StreamRunIdentity } from "./stream-identity.ts";
import { TASK_CHAIN_SCOPE, TASK_PROMPT_LAYOUT } from "./stream-manifest.ts";
import { DEFAULT_STEP_BUDGET } from "./stream-runner.ts";

test("harness 版本：取本源码所在仓库的 HEAD 短号与是否有未提交改动", () => {
  const ref = currentHarnessRef();
  assert.match(ref.commit, /^[0-9a-f]{7,40}$|^unknown$/);
  assert.equal(typeof ref.dirty, "boolean");
});

const identity = (over: Partial<StreamRunIdentity["core"]> = {}): StreamRunIdentity => ({
  core: {
    repo: "strands-py",
    manifestDigest: "abc",
    image: "sha256:img",
    budget: { maxTurns: 150, wallClockMs: 30 * 60_000 },
    conditions: ["search-only", "minimal"],
    stepScope: TASK_CHAIN_SCOPE,
    promptFormat: "test-files",
    promptLayout: TASK_PROMPT_LAYOUT,
    taskSelection: { method: "all" },
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

test("正式跑批的预算缺省为每步 150 轮、30 分钟（147 校准）", () => {
  assert.deepEqual(DEFAULT_STEP_BUDGET, { maxTurns: 150, wallClockMs: 30 * 60_000 });
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
    // 清单相同而题面格式或步的范围不同（198、213、215、216）：结果不能混
    assert.throws(
      () => checkOrWriteIdentity(dir, identity({ promptFormat: "test-cases" })),
      /promptFormat/
    );
    assert.throws(
      () => checkOrWriteIdentity(dir, identity({ stepScope: "continuation" })),
      /stepScope/
    );
    // 题面版式不同（两段名单之前的单段版式）：结果不能混
    assert.throws(
      () => checkOrWriteIdentity(dir, identity({ promptLayout: "single should-pass list" })),
      /promptLayout/
    );
    // 193 之前写下的身份头没有这两项：同样拒绝续跑
    const { stepScope: _s, promptFormat: _p, ...legacyCore } = identity().core;
    const legacyDir = mkdtempSync(join(tmpdir(), "pigeon-stream-identity-"));
    try {
      writeFileSync(
        join(legacyDir, "identity.json"),
        JSON.stringify({ ...identity(), core: legacyCore })
      );
      assert.throws(() => checkOrWriteIdentity(legacyDir, identity()), /stepScope.*promptFormat/);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("身份头按条件子集续跑（202、219）：只跑一部分条件、只接一种 agent 的都放行，条件取并集、agent 参数补上，摘要不变；同一 agent 参数不同、选题不同即拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-identity-"));
  try {
    const sample = {
      method: "sample" as const,
      seed: 20260927,
      k: 15,
      population: "p",
      tasks: [3, 7],
    };
    const { minimal: _m, ...pigeonOnly } = identity().core.agents;
    const { pigeon, ...minimalOnly } = identity().core.agents;
    const first = checkOrWriteIdentity(
      dir,
      identity({ conditions: ["search-only"], agents: pigeonOnly, taskSelection: sample })
    );
    const read = () => JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    assert.equal(
      checkOrWriteIdentity(
        dir,
        identity({ conditions: ["minimal"], agents: minimalOnly, taskSelection: sample })
      ),
      first
    );
    assert.deepEqual(read().core.conditions, ["search-only", "minimal"]);
    assert.deepEqual(Object.keys(read().core.agents).sort(), ["minimal", "pigeon"]);
    assert.equal(read().digest, first);
    // 同一格整份重跑第二遍（遍次不在身份里）、条件已在并集里：照常
    assert.equal(
      checkOrWriteIdentity(
        dir,
        identity({ conditions: ["search-only"], agents: pigeonOnly, taskSelection: sample })
      ),
      first
    );
    assert.throws(
      () =>
        checkOrWriteIdentity(
          dir,
          identity({
            conditions: ["search-push"],
            agents: { pigeon: { ...(pigeon as NonNullable<typeof pigeon>), temperature: 1 } },
            taskSelection: sample,
          })
        ),
      /agents\.pigeon/
    );
    assert.throws(
      () => checkOrWriteIdentity(dir, identity({ taskSelection: { ...sample, tasks: [3, 8] } })),
      /taskSelection/
    );
    assert.throws(
      () => checkOrWriteIdentity(dir, identity({ taskSelection: { method: "all" } })),
      /taskSelection/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("身份头：续跑时账号数、各账号并发或路数变了即在 infoLog 追加一条带起始时刻的记录（不参与比对、摘要不变）；只换跑批器代码不追加", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-identity-"));
  try {
    const withAccounts = (accountConcurrency: number[], commit = "h1"): StreamRunIdentity => ({
      ...identity(),
      info: {
        concurrency: 4,
        accounts: accountConcurrency.length,
        accountConcurrency,
        harness: { commit, dirty: false },
      },
    });
    const read = () => JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    const first = checkOrWriteIdentity(dir, withAccounts([2]));
    assert.equal(read().infoLog, undefined);
    assert.equal(checkOrWriteIdentity(dir, withAccounts([2], "h2")), first);
    assert.equal(read().infoLog, undefined, "只换跑批器代码：不追加");
    const at = new Date("2026-09-25T00:00:00Z");
    assert.equal(
      checkOrWriteIdentity(dir, withAccounts([2, 3]), () => at),
      first,
      "加账号不改身份摘要"
    );
    assert.deepEqual(read().infoLog, [
      { since: at.toISOString(), info: withAccounts([2, 3]).info },
    ]);
    assert.deepEqual(read().info.accountConcurrency, [2], "最初的 info 保留");
    checkOrWriteIdentity(dir, withAccounts([2, 3]));
    assert.equal(read().infoLog.length, 1, "与最近一条相同：不重复追加");
    checkOrWriteIdentity(dir, withAccounts([2, 1]));
    assert.deepEqual(
      read().infoLog.map(
        (c: { info: { accountConcurrency: number[] } }) => c.info.accountConcurrency
      ),
      [
        [2, 3],
        [2, 1],
      ]
    );
    assert.equal(read().digest, first);
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

test("身份头：首次写入与追加 infoLog 都是先写临时文件再改名（换目录项，不原地改写）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-identity-"));
  try {
    const file = join(dir, "identity.json");
    const withAccounts = (accountConcurrency: number[]): StreamRunIdentity => ({
      ...identity(),
      info: {
        concurrency: 4,
        accounts: accountConcurrency.length,
        accountConcurrency,
        harness: { commit: "h1", dirty: false },
      },
    });
    checkOrWriteIdentity(dir, withAccounts([2]));
    const before = readFileSync(file, "utf8");
    // 旁证：同一个文件的硬链接。原地改写会连它一起改，改名只换 identity.json 这个目录项
    linkSync(file, join(dir, "witness.json"));
    checkOrWriteIdentity(dir, withAccounts([2, 3]));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).infoLog.length, 1, "追加了 infoLog");
    assert.equal(readFileSync(join(dir, "witness.json"), "utf8"), before, "不是原地改写");
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
