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
import { effectivePigeonSettings } from "./stream-experiment.ts";
import { currentHarnessRef } from "./stream-harness.ts";
import {
  checkOrWriteIdentity,
  readStoredIdentity,
  type StreamRunIdentity,
} from "./stream-identity.ts";
import { TASK_CHAIN_SCOPE, TASK_PROMPT_LAYOUT } from "./stream-manifest.ts";
import { renderStreamReport } from "./stream-report.ts";
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
        compaction: {
          contextWindow: 1_000_000,
          reserveTokens: 16_384,
          keepRecentTokens: 20_000,
          thresholdTokens: 983_616,
        },
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

test("身份头记 Pigeon 的压缩配置：续跑时压缩配置不同即拒绝并列出不同项", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-identity-compaction-"));
  try {
    checkOrWriteIdentity(dir, identity());
    const saved = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    assert.equal(saved.core.agents.pigeon.compaction.thresholdTokens, 983_616);
    const pigeon = identity().core.agents.pigeon as NonNullable<
      StreamRunIdentity["core"]["agents"]["pigeon"]
    >;
    assert.throws(
      () =>
        checkOrWriteIdentity(
          dir,
          identity({
            agents: {
              pigeon: {
                ...pigeon,
                compaction: {
                  contextWindow: 1_000_000,
                  reserveTokens: 16_384,
                  keepRecentTokens: 20_000,
                  thresholdTokens: 30_000,
                },
              },
            },
          })
        ),
      /agents\.pigeon\.compaction/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("身份头记推送记忆的记忆上限、复盘模板版本与复盘上限：续跑时任一项不同即拒绝并列出不同项", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-identity-memory-"));
  try {
    const pigeon = {
      ...(identity().core.agents.pigeon as NonNullable<
        StreamRunIdentity["core"]["agents"]["pigeon"]
      >),
      memoryLimitChars: 12_000,
      reviewTemplate: "v1",
      reviewBudget: { maxTurns: 40, wallClockMs: 15 * 60_000 },
    };
    checkOrWriteIdentity(dir, identity({ agents: { pigeon } }));
    const saved = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    assert.equal(saved.core.agents.pigeon.memoryLimitChars, 12_000);
    assert.equal(saved.core.agents.pigeon.reviewTemplate, "v1");
    assert.deepEqual(saved.core.agents.pigeon.reviewBudget, { maxTurns: 40, wallClockMs: 900_000 });
    // 同样的即通过
    checkOrWriteIdentity(dir, identity({ agents: { pigeon } }));
    for (const [changed, key] of [
      [{ memoryLimitChars: 4000 }, "memoryLimitChars"],
      [{ reviewTemplate: "v2" }, "reviewTemplate"],
      [{ reviewBudget: { maxTurns: 80, wallClockMs: 30 * 60_000 } }, "reviewBudget"],
    ] as const) {
      assert.throws(
        () =>
          checkOrWriteIdentity(dir, identity({ agents: { pigeon: { ...pigeon, ...changed } } })),
        new RegExp(`agents\\.pigeon\\.${key}`)
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("身份头记主 agent 派 worker 的实际生效值（265）：续跑时不同即拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-identity-spawn-"));
  try {
    const pigeon = {
      ...(identity().core.agents.pigeon as NonNullable<
        StreamRunIdentity["core"]["agents"]["pigeon"]
      >),
      spawnWorkers: false,
    };
    checkOrWriteIdentity(dir, identity({ agents: { pigeon } }));
    const saved = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    assert.equal(saved.core.agents.pigeon.spawnWorkers, false);
    checkOrWriteIdentity(dir, identity({ agents: { pigeon } }));
    assert.throws(
      () =>
        checkOrWriteIdentity(
          dir,
          identity({ agents: { pigeon: { ...pigeon, spawnWorkers: true } } })
        ),
      /agents\.pigeon\.spawnWorkers/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    // 降了路数：照常续跑，摘要不变
    const resumed = checkOrWriteIdentity(dir, {
      ...identity(),
      info: { concurrency: 3, harness: { commit: "h1", dirty: false } },
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

test("身份头：续跑时账号数、各账号并发或路数变了即在 infoLog 追加一条带起始时刻的记录（不参与比对、摘要不变）；代码相同不追加", () => {
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
    assert.equal(checkOrWriteIdentity(dir, withAccounts([2], "h1")), first);
    assert.equal(read().infoLog, undefined, "什么都没变：不追加");
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

// 同一份 core，换代码版本
const atHarness = (commit: string, dirty = false): StreamRunIdentity => ({
  ...identity(),
  info: { concurrency: 4, harness: { commit, dirty } },
});

function withDir(prefix: string, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const readIdentityFile = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));

test("代码版本（269）：续跑时提交号不同即拒绝，报出记录的与当前的提交号与是否有未提交改动；身份头不动", () => {
  withDir("pigeon-stream-harness-commit-", (dir) => {
    checkOrWriteIdentity(dir, atHarness("aaa1111"));
    const before = readFileSync(join(dir, "identity.json"), "utf8");
    assert.throws(
      () => checkOrWriteIdentity(dir, atHarness("bbb2222")),
      /记录的代码：提交 aaa1111（无未提交改动）.*当前的代码：提交 bbb2222（无未提交改动）.*--accept-harness-change/
    );
    assert.equal(readFileSync(join(dir, "identity.json"), "utf8"), before);
    // 同一提交、干净：照常续跑
    checkOrWriteIdentity(dir, atHarness("aaa1111"));
  });
});

test("代码版本（269）：续跑时当前有未提交改动、或任一方提交号为 unknown、或记录的有未提交改动，即拒绝", () => {
  withDir("pigeon-stream-harness-dirty-", (dir) => {
    checkOrWriteIdentity(dir, atHarness("aaa1111"));
    assert.throws(
      () => checkOrWriteIdentity(dir, atHarness("aaa1111", true)),
      /当前的代码：提交 aaa1111（有未提交改动）/
    );
    assert.throws(
      () => checkOrWriteIdentity(dir, atHarness("unknown")),
      /当前的代码：提交 unknown/
    );
  });
  withDir("pigeon-stream-harness-unknown-", (dir) => {
    checkOrWriteIdentity(dir, atHarness("unknown"), undefined, { allowDirtyHarness: true });
    assert.throws(
      () => checkOrWriteIdentity(dir, atHarness("unknown")),
      /记录的代码：提交 unknown/
    );
  });
  withDir("pigeon-stream-harness-saved-dirty-", (dir) => {
    checkOrWriteIdentity(dir, atHarness("aaa1111", true), undefined, { allowDirtyHarness: true });
    // 记录的那份有未提交改动：认不出当时是哪份代码，同一提交的干净代码也不能认定相同
    assert.throws(
      () => checkOrWriteIdentity(dir, atHarness("aaa1111")),
      /记录的代码：提交 aaa1111（有未提交改动）/
    );
  });
});

test("代码版本（269）：--accept-harness-change 给了原因才放行，在 infoLog 追加一条（时刻、新的代码版本、原因），之后以新版本为准", () => {
  withDir("pigeon-stream-harness-accept-", (dir) => {
    const first = checkOrWriteIdentity(dir, atHarness("aaa1111"));
    const at = new Date("2026-09-28T01:02:03Z");
    assert.equal(
      checkOrWriteIdentity(dir, atHarness("bbb2222"), () => at, {
        acceptHarnessChange: "修复判题超时",
      }),
      first,
      "放行不改身份摘要"
    );
    assert.deepEqual(readIdentityFile(dir).infoLog, [
      {
        since: at.toISOString(),
        info: atHarness("bbb2222").info,
        acceptHarnessChange: "修复判题超时",
      },
    ]);
    assert.equal(readIdentityFile(dir).info.harness.commit, "aaa1111", "开跑时的记录保留");
    // 放行后以新版本为准：同一新版本照常续跑、不再追加；回到旧版本即拒绝
    checkOrWriteIdentity(dir, atHarness("bbb2222"));
    assert.equal(readIdentityFile(dir).infoLog.length, 1);
    assert.throws(
      () => checkOrWriteIdentity(dir, atHarness("aaa1111")),
      /记录的代码：提交 bbb2222/
    );
    // 有未提交改动的也可以显式放行，同样留痕
    checkOrWriteIdentity(dir, atHarness("bbb2222", true), () => at, {
      acceptHarnessChange: "现场补丁",
    });
    assert.deepEqual(readIdentityFile(dir).infoLog.at(-1), {
      since: at.toISOString(),
      info: atHarness("bbb2222", true).info,
      acceptHarnessChange: "现场补丁",
    });
    // 代码没变时给了放行：没有要放行的不一致，不追加
    withDir("pigeon-stream-harness-accept-same-", (other) => {
      checkOrWriteIdentity(other, atHarness("aaa1111"));
      checkOrWriteIdentity(other, atHarness("aaa1111"), undefined, { acceptHarnessChange: "无事" });
      assert.equal(readIdentityFile(other).infoLog, undefined);
    });
  });
});

test("代码版本（269）：--accept-harness-change 的原因为空或只有空白即报错，身份头不动", () => {
  withDir("pigeon-stream-harness-empty-", (dir) => {
    checkOrWriteIdentity(dir, atHarness("aaa1111"));
    const before = readFileSync(join(dir, "identity.json"), "utf8");
    for (const reason of ["", "  "]) {
      assert.throws(
        () =>
          checkOrWriteIdentity(dir, atHarness("bbb2222"), undefined, {
            acceptHarnessChange: reason,
          }),
        /--accept-harness-change 的原因不能为空/
      );
    }
    assert.equal(readFileSync(join(dir, "identity.json"), "utf8"), before);
  });
});

test("代码版本（269）：首次开跑时有未提交改动或提交号为 unknown 即拒绝、不写身份头；--allow-dirty-harness 放行并记进身份头", () => {
  for (const ref of [
    { commit: "aaa1111", dirty: true },
    { commit: "unknown", dirty: false },
  ]) {
    withDir("pigeon-stream-harness-first-", (dir) => {
      assert.throws(
        () => checkOrWriteIdentity(dir, atHarness(ref.commit, ref.dirty)),
        /拒绝开跑.*--allow-dirty-harness/
      );
      assert.equal(existsSync(join(dir, "identity.json")), false);
      checkOrWriteIdentity(dir, atHarness(ref.commit, ref.dirty), undefined, {
        allowDirtyHarness: true,
      });
      assert.equal(readIdentityFile(dir).allowDirtyHarness, true);
      assert.deepEqual(readIdentityFile(dir).info.harness, ref);
    });
  }
  // 干净的代码：不需要放行，给了也不记
  withDir("pigeon-stream-harness-first-clean-", (dir) => {
    checkOrWriteIdentity(dir, atHarness("aaa1111"), undefined, { allowDirtyHarness: true });
    assert.equal(readIdentityFile(dir).allowDirtyHarness, undefined);
  });
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

test("合并后的身份头：agents.pigeon 记派 worker 关（265）并与代码版本（269）一起核对——同一代码中断后续跑放行、不追加记录；派 worker 的生效值不同即拒绝；换了提交号即拒绝，--accept-harness-change 放行、记进 infoLog 与报告的设置一节", () => {
  withDir("pigeon-stream-identity-merge5-", (dir) => {
    // 跑批器实际写进身份头的 Pigeon 参数：没给参数时的生效值，含派 worker 关
    const pigeon = effectivePigeonSettings({}, "m");
    assert.equal(pigeon.spawnWorkers, false);
    const at = (commit: string): StreamRunIdentity => ({
      ...identity({ agents: { ...identity().core.agents, pigeon } }),
      info: { concurrency: 4, harness: { commit, dirty: false } },
    });
    // 开跑
    const digest = checkOrWriteIdentity(dir, at("aaa1111"));
    assert.equal(readIdentityFile(dir).core.agents.pigeon.spawnWorkers, false);
    // 中断后用同一份代码续跑：放行，摘要不变，不追加 infoLog（新增的字段两次都记了且相同，不因它误拒）
    assert.equal(checkOrWriteIdentity(dir, at("aaa1111")), digest);
    assert.equal(readIdentityFile(dir).infoLog, undefined);
    // 派 worker 的生效值变了：core 不一致，拒绝并点名这一项
    const opened = at("aaa1111");
    assert.throws(
      () =>
        checkOrWriteIdentity(dir, {
          ...opened,
          core: {
            ...opened.core,
            agents: { ...opened.core.agents, pigeon: { ...pigeon, spawnWorkers: true } },
          },
        }),
      /agents\.pigeon\.spawnWorkers/
    );
    // 换了提交号：拒绝，身份头不动
    assert.throws(
      () => checkOrWriteIdentity(dir, at("bbb2222")),
      /记录的代码：提交 aaa1111（无未提交改动）.*当前的代码：提交 bbb2222（无未提交改动）.*--accept-harness-change/
    );
    assert.equal(readIdentityFile(dir).infoLog, undefined);
    // 显式放行：摘要不变，infoLog 追加一条带原因的记录，core 里的派 worker 一项照旧
    const when = new Date("2026-09-28T01:02:03Z");
    assert.equal(
      checkOrWriteIdentity(dir, at("bbb2222"), () => when, { acceptHarnessChange: "修复判题超时" }),
      digest
    );
    const stored = readStoredIdentity(dir);
    assert.ok(stored !== undefined);
    assert.deepEqual(stored.infoLog, [
      { since: when.toISOString(), info: at("bbb2222").info, acceptHarnessChange: "修复判题超时" },
    ]);
    assert.equal(stored.core.agents.pigeon?.spawnWorkers, false);
    // 报告的设置一节列出开跑时的代码与这次放行
    const md = renderStreamReport([], { title: "续跑", segments: [], identity: stored });
    assert.match(md, /^- 开跑时的代码：提交 aaa1111（无未提交改动）$/m);
    assert.match(
      md,
      /^\| 2026-09-28T01:02:03\.000Z \| 提交 bbb2222（无未提交改动） \| 修复判题超时 \|$/m
    );
  });
});
