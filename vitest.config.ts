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
    // 每个 worker 是独立的子进程（与 node:test 每个文件一个进程最接近）；测试文件之间是否隔离见 isolate
    pool: "forks",
    isolate: process.env.PIGEON_TEST_ISOLATE !== "0",
    // node:test 不限时；长用例（真容器、跑批）照旧由各自的 timeout 选项或外层把关
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // describe.concurrent 的组内并发上限（node:test 的 concurrency: true 不设上限）
    maxConcurrency: 64,
    // 第三方依赖预打包：每个 worker 不再逐个加载第三方模块的大量小文件
    deps: {
      optimizer: {
        ssr: {
          enabled: process.env.PIGEON_TEST_OPTIMIZE !== "0",
          include: [
            "@earendil-works/pi-agent-core",
            "@earendil-works/pi-ai",
            "@earendil-works/pi-tui",
            "@modelcontextprotocol/sdk",
            "typebox",
            "turndown",
          ],
        },
      },
    },
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
