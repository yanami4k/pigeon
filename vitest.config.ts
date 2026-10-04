// Vitest 配置（决策 369）。快慢档的划分沿用 scripts/test-tiers.mjs 的清单，由 scripts/run-tests.mjs 经环境变量选档。
// 测试经 Vite 转译后运行，与产品运行时（Node 原生剥类型）的编译方式不同；类型检查仍由 tsc（npm run check）把关。
import { configDefaults, defineConfig } from "vitest/config";
import { SLOW_TESTS } from "./scripts/test-tiers.mjs";

const tier = process.env.PIGEON_TEST_TIER ?? "all";
const slow = SLOW_TESTS.map((entry) => entry.pattern);

export default defineConfig({
  test: {
    include: tier === "slow" ? slow : ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...(tier === "fast" ? slow : [])],
    // 每个 worker 是独立的子进程；同一 worker 里的测试文件之间不隔离（实测：两档全部约 58 秒，隔离约 85 秒，
    // 多种并发与打乱文件顺序下都没有串扰）。怀疑串扰时用 PIGEON_TEST_ISOLATE=1 切回每个文件隔离复查
    pool: "forks",
    isolate: process.env.PIGEON_TEST_ISOLATE === "1",
    // node:test 不限时；长用例（真容器、跑批）照旧由各自的 timeout 选项或外层把关
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // describe.concurrent 的组内并发上限（node:test 的 concurrency: true 不设上限）
    maxConcurrency: 64,
    // 不做第三方依赖预打包：不隔离之后加载模块只占约 2%，依赖改为内联再预打包反而多出转译开销（实测慢 2–4 秒）
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.bench.ts",
        "src/**/*fixtures.ts",
        "src/**/testing.ts",
      ],
      reportsDirectory: "coverage",
    },
    benchmark: {
      include: ["src/**/*.bench.ts"],
    },
  },
});
