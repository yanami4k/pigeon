// replay 分层规则的元测试：
// 断言一：回放层触达 orchestration 会被 replay-below-controller 抓住（执行由调用方承担，回放层只做计划与核对）；
// 断言二：真实 src/ 里这条规则零违规（规则不是写给夹具看的）。
// 夹具写在 os.tmpdir()，不进 src/——否则主 npm run deps 会把夹具当真违规报出来。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IConfiguration, ICruiseOptions } from "dependency-cruiser";
import { cruise } from "dependency-cruiser";

async function loadRuleSet(): Promise<NonNullable<ICruiseOptions["ruleSet"]>> {
  const configUrl = new URL("../.dependency-cruiser.js", import.meta.url).href;
  const config: IConfiguration = (await import(configUrl)).default;
  return { forbidden: config.forbidden ?? [] };
}

async function cruiseJson(targets: string[], ruleSet: NonNullable<ICruiseOptions["ruleSet"]>) {
  const result = await cruise(targets, {
    ruleSet,
    validate: true,
    doNotFollow: { path: "node_modules" },
  });
  if (typeof result.output === "string") {
    throw new Error("预期结构化巡航结果，收到字符串");
  }
  return result.output;
}

test("回放层的分层规则真的会抓人：触达 orchestration 被拒", async () => {
  const ruleSet = await loadRuleSet();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "pigeon-replay-boundary-"));
  const originalCwd = process.cwd();
  try {
    for (const dir of ["src/replay", "src/orchestration", "src/persistence"]) {
      mkdirSync(join(fixtureRoot, dir), { recursive: true });
    }
    writeFileSync(join(fixtureRoot, "src/orchestration/index.ts"), "export {};\n");
    writeFileSync(join(fixtureRoot, "src/persistence/session-read.ts"), "export {};\n");
    // 回放层不得触达 orchestration（执行由调用方承担）
    writeFileSync(
      join(fixtureRoot, "src/replay/probe.ts"),
      'import "../orchestration/index.ts";\nexport {};\n'
    );
    // 允许的那一项：persistence 的只读物化
    writeFileSync(
      join(fixtureRoot, "src/replay/read-probe.ts"),
      'import "../persistence/session-read.ts";\nexport {};\n'
    );

    process.chdir(fixtureRoot);
    const output = await cruiseJson(["src"], ruleSet);
    const named = (name: string) => output.summary.violations.filter((v) => v.rule.name === name);
    const dump = () =>
      JSON.stringify(output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`));

    assert.ok(
      named("replay-below-controller").some((v) => v.from.includes("src/replay/probe.ts")),
      `回放层触达 orchestration 应被抓住，实际违规：${dump()}`
    );
    assert.ok(
      !output.summary.violations.some((v) => v.from.includes("src/replay/read-probe.ts")),
      `回放层读 persistence 的只读物化应放行，实际违规：${dump()}`
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("这条规则在真实 src/ 上零违规——规则不是写给夹具看的", async () => {
  const ruleSet = await loadRuleSet();
  const output = await cruiseJson(["src"], ruleSet);
  const watched = new Set(["replay-below-controller"]);
  const violations = output.summary.violations.filter((v) => watched.has(v.rule.name));
  assert.deepEqual(
    violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`),
    []
  );
  assert.ok(output.summary.totalCruised > 15, "巡航没有空转");
});
