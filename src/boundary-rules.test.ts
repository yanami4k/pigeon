// 边界规则的元测试：防"规则还在但已经不干活了"（TS7 静默巡航 0 模块事故的教训）。
// 断言一：真实违规会被规则抓住；断言二：巡航没有空转（模块数 > 15 且 0 违规）。
// 夹具写在 os.tmpdir()，不进 src/——否则主 npm run deps 会把夹具当真违规报出来。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IConfiguration, ICruiseOptions } from "dependency-cruiser";
import { cruise } from "dependency-cruiser";

// 动态 import 的合理例外：.dependency-cruiser.js 在 rootDir(src) 之外且是纯 JS，
// tsc 无法静态 import；此处必须运行期读取同一份规则本体。
// 只带 forbidden 规则即可；不要把仓库根的 tsConfig/options 带进 os.tmpdir() 夹具，
// 否则 dependency-cruiser 会去临时目录找不存在的 tsconfig.json。
async function loadRuleSet(): Promise<NonNullable<ICruiseOptions["ruleSet"]>> {
  const configUrl = new URL("../.dependency-cruiser.js", import.meta.url).href;
  const config: IConfiguration = (await import(configUrl)).default;
  return { forbidden: config.forbidden ?? [] };
}

// 巡航并返回结构化结果（无 outputType 时 output 为对象而非字符串报告）
async function cruiseJson(targets: string[], ruleSet: NonNullable<ICruiseOptions["ruleSet"]>) {
  const options: ICruiseOptions = {
    ruleSet,
    validate: true,
    doNotFollow: { path: "node_modules" },
  };
  const result = await cruise(targets, options);
  if (typeof result.output === "string") {
    throw new Error("预期结构化巡航结果，收到字符串");
  }
  return result.output;
}

test("违规会被抓住：tui→execution 与 业务层→@earendil-works", async () => {
  const ruleSet = await loadRuleSet();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "pigeon-boundary-"));
  const originalCwd = process.cwd();
  try {
    // 夹具：镜像 src/ 目录结构，让 ^src/tui 等规则路径能匹配
    mkdirSync(join(fixtureRoot, "src/tui"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/execution"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/tools"), { recursive: true });
    writeFileSync(join(fixtureRoot, "src/execution/index.ts"), "export {};\n");
    writeFileSync(
      join(fixtureRoot, "src/tui/probe.ts"),
      'import "../execution/index.ts";\nexport {};\n'
    );
    writeFileSync(
      join(fixtureRoot, "src/tools/probe.ts"),
      'import { Agent } from "@earendil-works/pi-agent-core";\nexport const x = Agent;\n'
    );
    // junction 指回仓库 node_modules，让裸说明符 @earendil-works/* 可解析
    symlinkSync(join(originalCwd, "node_modules"), join(fixtureRoot, "node_modules"), "junction");

    // 规则路径（^src/...）以 cwd 为基准相对化，切到夹具根目录再巡航
    process.chdir(fixtureRoot);
    const output = await cruiseJson(["src"], ruleSet);

    const ruleNames = new Set(output.summary.violations.map((v) => v.rule.name));
    assert.ok(
      ruleNames.has("tui-cannot-reach-execution"),
      `应抓到 tui-cannot-reach-execution，实际违规：${JSON.stringify([...ruleNames])}`
    );
    assert.ok(
      ruleNames.has("pi-agent-only-via-pi-runtime"),
      `应抓到 pi-agent-only-via-pi-runtime，实际违规：${JSON.stringify([...ruleNames])}`
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("巡航没有空转：src/ 模块数 > 15 且 0 违规", async () => {
  const ruleSet = await loadRuleSet();
  const output = await cruiseJson(["src"], ruleSet);
  assert.ok(
    output.summary.totalCruised > 15,
    `巡航模块数应 > 15（16 个目录 + state 实现文件），实际 ${output.summary.totalCruised}——疑似空转`
  );
  assert.deepEqual(
    output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`),
    [],
    "src/ 应无边界违规"
  );
});
