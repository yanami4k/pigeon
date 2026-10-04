// 计时量具用的 Vitest 报告器：运行结束时把每个测试文件的耗时、测试项计数与每个测试的耗时写成 JSON，
// 路径取环境变量 PIGEON_TIMING_OUT。只供 scripts/test-timing.mjs 使用。
import { writeFileSync } from "node:fs";
import { relative } from "node:path";

export default class TimingReporter {
  onTestRunEnd(testModules) {
    const files = testModules.map((m) => {
      const tests = [...m.children.allTests()].map((t) => ({
        name: t.fullName,
        state: t.result().state,
        durationMs: t.diagnostic()?.duration ?? null,
      }));
      const diag = m.diagnostic();
      return {
        file: relative(process.cwd(), m.moduleId).replaceAll("\\", "/"),
        state: m.state(),
        // 文件从开始准备到跑完的时间：准备、收集、建环境与跑测试
        wallMs: Math.round(
          diag.prepareDuration +
            diag.collectDuration +
            diag.environmentSetupDuration +
            diag.duration
        ),
        tests,
      };
    });
    writeFileSync(process.env.PIGEON_TIMING_OUT, `${JSON.stringify(files)}\n`);
  }
}
