// M8 分层规则的元测试（决策 090 完成证据第四条的机检证据，不是口头保证）：
// 断言一：激活层引用放权写入模块会被 activation-only-state 抓住；
// 断言二：回放层触达 application / orchestration 会被 replay-below-controller 抓住；
// 断言三：真实 src/ 里这两条规则零违规（规则不是写给夹具看的）。
// 决策 094 删掉 Policy 形态后，"两个写入模块互不引用"那条规则随之删除；留下的是本质不变式——
// 激活器在代码层面够不着放权写入模块。
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

test("激活层的分层规则真的会抓人：放权写入、回放触达 Controller", async () => {
  const ruleSet = await loadRuleSet();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "pigeon-activation-boundary-"));
  const originalCwd = process.cwd();
  try {
    for (const dir of [
      "src/activation",
      "src/persistence",
      "src/application",
      "src/replay",
      "src/orchestration",
    ]) {
      mkdirSync(join(fixtureRoot, dir), { recursive: true });
    }
    writeFileSync(join(fixtureRoot, "src/persistence/grants-config.ts"), "export {};\n");
    writeFileSync(join(fixtureRoot, "src/persistence/atomic-write.ts"), "export {};\n");
    writeFileSync(join(fixtureRoot, "src/application/grants.ts"), "export {};\n");
    writeFileSync(join(fixtureRoot, "src/orchestration/index.ts"), "export {};\n");
    // 决策 090：激活器在代码层面不得依赖放权写入模块
    writeFileSync(
      join(fixtureRoot, "src/activation/grants-probe.ts"),
      'import "../persistence/grants-config.ts";\nexport {};\n'
    );
    // 允许的那一项：整文件原子替换
    writeFileSync(
      join(fixtureRoot, "src/activation/atomic-probe.ts"),
      'import "../persistence/atomic-write.ts";\nexport {};\n'
    );
    // 回放层不得触达 orchestration（派发与装配由 application 注入）
    writeFileSync(
      join(fixtureRoot, "src/replay/probe.ts"),
      'import "../orchestration/index.ts";\nexport {};\n'
    );

    process.chdir(fixtureRoot);
    const output = await cruiseJson(["src"], ruleSet);
    const named = (name: string) => output.summary.violations.filter((v) => v.rule.name === name);
    const dump = () =>
      JSON.stringify(output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`));

    assert.ok(
      named("activation-only-state").some((v) => v.from.includes("src/activation/grants-probe.ts")),
      `激活层引用放权写入模块应被抓住，实际违规：${dump()}`
    );
    assert.ok(
      !output.summary.violations.some((v) => v.from.includes("src/activation/atomic-probe.ts")),
      `激活层引用整文件原子替换应放行，实际违规：${dump()}`
    );
    assert.ok(
      named("replay-below-controller").some((v) => v.from.includes("src/replay/probe.ts")),
      `回放层触达 orchestration 应被抓住，实际违规：${dump()}`
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("两条规则在真实 src/ 上零违规——规则不是写给夹具看的", async () => {
  const ruleSet = await loadRuleSet();
  const output = await cruiseJson(["src"], ruleSet);
  const watched = new Set(["activation-only-state", "replay-below-controller"]);
  const violations = output.summary.violations.filter((v) => watched.has(v.rule.name));
  assert.deepEqual(
    violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`),
    []
  );
  assert.ok(output.summary.totalCruised > 15, "巡航没有空转");
});
