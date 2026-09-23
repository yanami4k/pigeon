// 边界规则的元测试：防"规则还在但已经不执行任务了"（TS7 静默巡航 0 模块事故的教训）。
// 断言一：真实违规会被规则抓住（cli/tui→execution、src/tools 下绕过桥接文件的 rogue 直连、
// pi-runtime→application、cli→tui、Actor 直连 persistence/event-log.ts）；
// 断言二：tools 单一桥接文件（wrap.ts）豁免真的生效；断言三：巡航没有空转（模块数 > 15 且 0 违规）。
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

test("违规会被抓住：cli/tui→execution、memory→@earendil-works、tools 下 rogue 直连、pi-runtime→application、cli→tui、Actor 直连 event-log.ts；wrap.ts 桥豁免生效", async () => {
  const ruleSet = await loadRuleSet();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "pigeon-boundary-"));
  const originalCwd = process.cwd();
  try {
    // 夹具：镜像 src/ 目录结构，让 ^src/... 等规则路径能匹配
    mkdirSync(join(fixtureRoot, "src/tui"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/cli"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/execution"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/memory"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/tools"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/eval"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/application"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/pi-runtime"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/persistence"), { recursive: true });
    writeFileSync(join(fixtureRoot, "src/execution/index.ts"), "export {};\n");
    writeFileSync(join(fixtureRoot, "src/application/index.ts"), "export {};\n");
    writeFileSync(join(fixtureRoot, "src/persistence/event-log.ts"), "export {};\n");
    // pi-runtime 允许清单（022 修订）：只许 state 与 tools，引用 application 必须被抓
    writeFileSync(
      join(fixtureRoot, "src/pi-runtime/probe.ts"),
      'import "../application/index.ts";\nexport {};\n'
    );
    // 两个 Actor 互不引用（022 修订）：cli→tui 必须被抓
    writeFileSync(
      join(fixtureRoot, "src/cli/tui-probe.ts"),
      'import "../tui/ui.ts";\nexport {};\n'
    );
    // Actor 只经只读面读会话（022 修订）：直连 persistence/event-log.ts 必须被抓
    writeFileSync(
      join(fixtureRoot, "src/cli/event-log-probe.ts"),
      'import "../persistence/event-log.ts";\nexport {};\n'
    );
    writeFileSync(
      join(fixtureRoot, "src/tui/probe.ts"),
      'import "../execution/index.ts";\nexport {};\n'
    );
    // cli 同样不得直连 execution（M2 S1 决策 025：过渡豁免已消除）
    writeFileSync(
      join(fixtureRoot, "src/cli/probe.ts"),
      'import "../execution/index.ts";\nexport {};\n'
    );
    // eval 不得触达 Actor 层（M6.5，eval-below-actors，022 修订）
    writeFileSync(
      join(fixtureRoot, "src/eval/probe.ts"),
      'import "../cli/probe.ts";\nexport {};\n'
    );
    writeFileSync(
      join(fixtureRoot, "src/memory/probe.ts"),
      'import { Agent } from "@earendil-works/pi-agent-core";\nexport const x = Agent;\n'
    );
    // tui 直连 pi-agent-core：tui-pi-tui-only 必须抓住（豁免只精确到 pi-tui 一个包）
    writeFileSync(
      join(fixtureRoot, "src/tui/agent-probe.ts"),
      'import { Agent } from "@earendil-works/pi-agent-core";\nexport const x = Agent;\n'
    );
    // tui 直连 pi-tui：豁免应生效（M2 S1——pi-tui 是纯 UI 库，S0 spike 实证）
    writeFileSync(
      join(fixtureRoot, "src/tui/ui.ts"),
      'import { TuiMainScreen } from "@earendil-works/pi-tui";\nexport const x = TuiMainScreen;\n'
    );
    // rogue 夹具：src/tools 下绕过桥接文件直接 new Agent——收口后必须被抓
    writeFileSync(
      join(fixtureRoot, "src/tools/probe.ts"),
      'import { Agent } from "@earendil-works/pi-agent-core";\nexport const x = new Agent();\n'
    );
    // 桥接文件：src/tools/wrap.ts 是收口后唯一允许 import 上游的位置
    writeFileSync(
      join(fixtureRoot, "src/tools/wrap.ts"),
      'import type { AgentTool } from "@earendil-works/pi-agent-core";\nexport type T = AgentTool;\n'
    );
    // junction 指回仓库 node_modules，让裸说明符 @earendil-works/* 可解析
    symlinkSync(join(originalCwd, "node_modules"), join(fixtureRoot, "node_modules"), "junction");

    // 规则路径（^src/...）以 cwd 为基准相对化，切到夹具根目录再巡航
    process.chdir(fixtureRoot);
    const output = await cruiseJson(["src"], ruleSet);

    const ruleViolations = output.summary.violations.filter(
      (v) => v.rule.name === "pi-agent-only-via-pi-runtime"
    );
    assert.ok(
      ruleViolations.some((v) => v.from.includes("src/memory/probe.ts")),
      `应抓到 src/memory/probe.ts 的违规，实际违规：${JSON.stringify(ruleViolations)}`
    );
    assert.ok(
      ruleViolations.some((v) => v.from.includes("src/tools/probe.ts")),
      `收口后 src/tools/probe.ts（rogue 直连）应被抓，实际违规：${JSON.stringify(ruleViolations)}`
    );
    assert.ok(
      !ruleViolations.some((v) => v.from.includes("src/tools/wrap.ts")),
      `桥接文件 src/tools/wrap.ts 应豁免，实际违规：${JSON.stringify(ruleViolations)}`
    );
    const actorViolations = output.summary.violations.filter(
      (v) => v.rule.name === "actors-no-execution"
    );
    assert.ok(
      actorViolations.some((v) => v.from.includes("src/tui/probe.ts")),
      `应抓到 tui→execution，实际违规：${JSON.stringify(output.summary.violations.map((v) => v.rule.name))}`
    );
    assert.ok(
      actorViolations.some((v) => v.from.includes("src/cli/probe.ts")),
      `应抓到 cli→execution，实际违规：${JSON.stringify(output.summary.violations.map((v) => v.rule.name))}`
    );
    assert.ok(
      output.summary.violations.some(
        (v) => v.rule.name === "eval-below-actors" && v.from.includes("src/eval/probe.ts")
      ),
      `应抓到 eval→cli，实际违规：${JSON.stringify(output.summary.violations.map((v) => `${v.rule.name}: ${v.from}`))}`
    );
    // pi-runtime 允许清单：引用 application 被抓
    assert.ok(
      output.summary.violations.some(
        (v) =>
          v.rule.name === "pi-runtime-only-state-tools" &&
          v.from.includes("src/pi-runtime/probe.ts")
      ),
      `应抓到 pi-runtime→application，实际违规：${JSON.stringify(output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`))}`
    );
    // 两个 Actor 互不引用
    assert.ok(
      output.summary.violations.some(
        (v) => v.rule.name === "actors-not-each-other" && v.from.includes("src/cli/tui-probe.ts")
      ),
      `应抓到 cli→tui，实际违规：${JSON.stringify(output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`))}`
    );
    // Actor 直连事件日志读写器
    assert.ok(
      output.summary.violations.some(
        (v) =>
          v.rule.name === "actors-no-event-log-direct" &&
          v.from.includes("src/cli/event-log-probe.ts")
      ),
      `应抓到 Actor 直连 persistence/event-log.ts，实际违规：${JSON.stringify(output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`))}`
    );
    // tui-pi-tui-only：tui 直连 pi-agent-core 被抓；直连 pi-tui 豁免生效
    const tuiViolations = output.summary.violations.filter(
      (v) => v.rule.name === "tui-pi-tui-only"
    );
    assert.ok(
      tuiViolations.some((v) => v.from.includes("src/tui/agent-probe.ts")),
      `应抓到 tui 直连 pi-agent-core，实际违规：${JSON.stringify(tuiViolations)}`
    );
    assert.ok(
      !output.summary.violations.some((v) => v.from.includes("src/tui/ui.ts")),
      `tui 直连 pi-tui 应豁免，实际违规：${JSON.stringify(output.summary.violations.map((v) => `${v.rule.name}: ${v.from}`))}`
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
