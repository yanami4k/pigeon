// 按档跑测试：node scripts/run-tests.mjs fast|slow|all [文件或 glob…] [vitest 的其他参数…]
// 快档 = src/**/*.test.ts 去掉慢档清单（scripts/test-tiers.mjs）；慢档 = 清单所列；all = 两档放进同一次 vitest run，
// 由 Vitest 统一调度（档位经环境变量 PIGEON_TEST_TIER 交给 vitest.config.ts）。给了文件或 glob（不以 - 开头、以 .ts
// 结尾或含通配符的参数）就只跑这些文件、不分档；其余参数原样交给 vitest run。环境变量 TEST_CONCURRENCY 给出时作为
// --maxWorkers 传下去（服务器上按负载定）。
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SLOW_TESTS } from "./test-tiers.mjs";

const [tier, ...extra] = process.argv.slice(2);
if (!["fast", "slow", "all"].includes(tier)) {
  console.error(
    "用法：node scripts/run-tests.mjs fast|slow|all [文件或 glob…] [vitest 的其他参数…]"
  );
  process.exit(2);
}

const norm = (f) => f.replaceAll("\\", "/");
const isSelector = (a) => !a.startsWith("-") && (/\.ts$/.test(a) || /[*?[]/.test(a));
const selectors = extra.filter(isSelector);
const passthrough = extra.filter((a) => !isSelector(a));

// 清单里每一项都得匹配到文件：改名或删掉测试文件后清单不会悄悄失效
for (const entry of SLOW_TESTS) {
  if (globSync(entry.pattern).length === 0) {
    console.error(
      `慢档清单的 ${entry.pattern} 没有匹配到任何测试文件，请更新 scripts/test-tiers.mjs`
    );
    process.exit(1);
  }
}

const files = [];
for (const s of selectors) {
  const matched = globSync(s).map(norm);
  // 给错路径时明确报错，不静默地什么都不跑
  if (matched.length === 0) {
    console.error(`${s} 没有匹配到任何文件`);
    process.exit(1);
  }
  files.push(...matched);
}

const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const concurrency = process.env.TEST_CONCURRENCY;
const args = [
  vitest,
  "run",
  ...(concurrency !== undefined && concurrency !== "" ? [`--maxWorkers=${concurrency}`] : []),
  ...passthrough,
  ...[...new Set(files)].sort(),
];
const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, PIGEON_TEST_TIER: files.length > 0 ? "all" : tier },
});
process.exit(result.status ?? 1);
