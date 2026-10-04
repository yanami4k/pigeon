// 测试耗时量具：跑一次 vitest run（报告器 scripts/timing-reporter.mjs），记每个测试文件的墙钟、测试项数与每个测试的耗时，打印最慢的文件。
// 用法：node scripts/test-timing.mjs [--concurrency N] [--out 结果.json] [--top K] [文件或 glob ...]
// 不给文件时量两档全部；--concurrency 即 Vitest 的 --maxWorkers。判断一个文件是否超过 10 秒，用 --concurrency 1 单独量。
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
let concurrency = Math.max(1, availableParallelism() - 1);
let out;
let top = 30;
const patterns = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--concurrency") concurrency = Number(args[++i]);
  else if (a === "--out") out = args[++i];
  else if (a === "--top") top = Number(args[++i]);
  else patterns.push(a);
}
const files = [...new Set(patterns.flatMap((p) => globSync(p)))].map((f) =>
  f.replaceAll("\\", "/")
);
if (patterns.length > 0 && files.length === 0) {
  console.error("给出的文件或 glob 没有匹配到任何文件");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "pigeon-test-timing-"));
const report = join(dir, "report.json");
const started = performance.now();
spawnSync(
  process.execPath,
  ["scripts/run-tests.mjs", "all", "--reporter=./scripts/timing-reporter.mjs", ...files],
  {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, TEST_CONCURRENCY: String(concurrency), PIGEON_TIMING_OUT: report },
  }
);
const totalWallMs = Math.round(performance.now() - started);
const json = JSON.parse(readFileSync(report, "utf8"));
rmSync(dir, { recursive: true, force: true });

const results = json
  .map((m) => {
    const count = (state) => m.tests.filter((t) => t.state === state).length;
    return {
      file: m.file,
      wallMs: m.wallMs,
      status: m.state,
      counts: {
        tests: m.tests.length,
        pass: count("passed"),
        fail: count("failed"),
        skipped: count("skipped") + count("pending"),
      },
      tests: m.tests,
    };
  })
  .sort((a, b) => b.wallMs - a.wallMs);

const sum = (k) => results.reduce((n, r) => n + r.counts[k], 0);
const summary = {
  files: results.length,
  concurrency,
  totalWallMs,
  tests: sum("tests"),
  pass: sum("pass"),
  fail: sum("fail"),
  skipped: sum("skipped"),
  failedFiles: results.filter((r) => r.status === "failed").map((r) => r.file),
};
if (out !== undefined) writeFileSync(out, `${JSON.stringify({ summary, results }, null, 2)}\n`);

console.log(JSON.stringify(summary));
console.log(`\n最慢的 ${top} 个文件（墙钟秒 / 测试项数）：`);
for (const r of results.slice(0, top)) {
  console.log(
    `${(r.wallMs / 1000).toFixed(1).padStart(7)}  ${String(r.counts.tests).padStart(4)}  ${r.file}`
  );
}
process.exitCode = summary.failedFiles.length > 0 ? 1 : 0;
