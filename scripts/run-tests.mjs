// 按档跑测试：node scripts/run-tests.mjs fast|slow|all [文件或 glob…] [node --test 的其他参数…]
// 快档 = src/**/*.test.ts 去掉慢档清单（scripts/test-tiers.mjs）；慢档 = 清单所列；all = 两档放进同一次 node --test，
// 由测试运行器统一按并发数调度。给了文件或 glob（不以 - 开头、以 .ts 结尾或含通配符的参数）就只跑这些文件、不分档；
// 其余参数原样交给 node --test。环境变量 TEST_CONCURRENCY 给出时作为 --test-concurrency 传下去（服务器上按负载定）。
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { SLOW_TESTS } from "./test-tiers.mjs";

const [tier, ...extra] = process.argv.slice(2);
if (!["fast", "slow", "all"].includes(tier)) {
  console.error(
    "用法：node scripts/run-tests.mjs fast|slow|all [文件或 glob…] [node --test 的其他参数…]"
  );
  process.exit(2);
}

const norm = (f) => f.replaceAll("\\", "/");
const isSelector = (a) => !a.startsWith("-") && (/\.ts$/.test(a) || /[*?[]/.test(a));
const selectors = extra.filter(isSelector);
const passthrough = extra.filter((a) => !isSelector(a));

let files;
if (selectors.length > 0) {
  files = [];
  for (const s of selectors) {
    const matched = globSync(s).map(norm);
    // 给错路径时明确报错，不静默地什么都不跑
    if (matched.length === 0) {
      console.error(`${s} 没有匹配到任何文件`);
      process.exit(1);
    }
    files.push(...matched);
  }
  files = [...new Set(files)].sort();
} else {
  const all = globSync("src/**/*.test.ts").map(norm).sort();
  const slow = new Set();
  for (const entry of SLOW_TESTS) {
    const matched = globSync(entry.pattern).map(norm);
    // 清单里每一项都得匹配到文件：改名或删掉测试文件后清单不会悄悄失效
    if (matched.length === 0) {
      console.error(
        `慢档清单的 ${entry.pattern} 没有匹配到任何测试文件，请更新 scripts/test-tiers.mjs`
      );
      process.exit(1);
    }
    for (const f of matched) slow.add(f);
  }
  files =
    tier === "fast" ? all.filter((f) => !slow.has(f)) : tier === "slow" ? [...slow].sort() : all;
}

const concurrency = process.env.TEST_CONCURRENCY;
const args = [
  "--test",
  ...(concurrency !== undefined && concurrency !== "" ? [`--test-concurrency=${concurrency}`] : []),
  ...passthrough,
  ...files,
];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
