// 逐文件覆盖率：每个测试文件单独跑一遍 Vitest 的 v8 覆盖率（lcov），算出每个文件独有覆盖的产品代码行（别的测试文件都没
// 覆盖到），以及全部文件合起来对指定模块的行覆盖率。独有行为 0 的文件只是"删了也不影响覆盖"的候选，删不删要逐个看它断言的行为。
// 用法：node scripts/test-coverage.mjs [--concurrency N] [--dir 输出目录] [--module 路径前缀 ...] [文件或 glob ...]
import { spawn } from "node:child_process";
import { globSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
let concurrency = Math.max(1, availableParallelism() - 1);
let dir = "tmp/coverage";
const modules = [];
const patterns = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--concurrency") concurrency = Number(args[++i]);
  else if (a === "--dir") dir = args[++i];
  else if (a === "--module") modules.push(args[++i]);
  else patterns.push(a);
}
if (patterns.length === 0) patterns.push("src/**/*.test.ts");
const files = [...new Set(patterns.flatMap((p) => globSync(p)))]
  .map((f) => f.replaceAll("\\", "/"))
  .sort();
mkdirSync(join(dir, "lcov"), { recursive: true });

const lcovOf = (file) => join(dir, "lcov", `${file.replaceAll("/", "__")}.lcov`);

// 单个文件跑一次（一个 worker），lcov 写进该文件自己的报告目录，跑完挪到 lcov/ 下
function runFile(file) {
  return new Promise((resolve) => {
    const reports = join(dir, "runs", file.replaceAll("/", "__"));
    const child = spawn(
      process.execPath,
      [
        "scripts/run-tests.mjs",
        "all",
        "--maxWorkers=1",
        "--coverage.enabled",
        "--coverage.reporter=lcovonly",
        `--coverage.reportsDirectory=${reports}`,
        file,
      ],
      { stdio: "ignore", env: { ...process.env, TEST_CONCURRENCY: "" } }
    );
    child.on("close", (code) => {
      try {
        renameSync(join(reports, "lcov.info"), lcovOf(file));
      } catch {}
      rmSync(reports, { recursive: true, force: true });
      resolve({ file, exitCode: code });
    });
  });
}

// 只计产品代码：src 下、不是测试文件也不是只供测试的夹具
const isProduct = (p) =>
  p.startsWith("src/") && !p.endsWith(".test.ts") && !/fixtures?\.ts$/.test(p);

// lcov → Map<源文件, { lines: Set<已覆盖行>, all: Set<可执行行> }>
function parseLcov(text) {
  const out = new Map();
  let current;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const p = relative(process.cwd(), line.slice(3)).replaceAll("\\", "/");
      current = isProduct(p) ? (out.get(p) ?? { lines: new Set(), all: new Set() }) : undefined;
      if (current !== undefined) out.set(p, current);
    } else if (current !== undefined && line.startsWith("DA:")) {
      const [n, hits] = line.slice(3).split(",").map(Number);
      current.all.add(n);
      if (hits > 0) current.lines.add(n);
    }
  }
  return out;
}

const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (next < files.length) results.push(await runFile(files[next++]));
  })
);

// 每行被多少个测试文件覆盖；各源文件的可执行行取各次运行的并集
const perTest = new Map();
const hitCount = new Map();
const executable = new Map();
for (const { file } of results) {
  let text = "";
  try {
    text = readFileSync(lcovOf(file), "utf8");
  } catch {}
  const cov = parseLcov(text);
  const keys = new Set();
  for (const [src, { lines, all }] of cov) {
    const ex = executable.get(src) ?? new Set();
    for (const n of all) ex.add(n);
    executable.set(src, ex);
    for (const n of lines) {
      const k = `${src}:${n}`;
      keys.add(k);
      hitCount.set(k, (hitCount.get(k) ?? 0) + 1);
    }
  }
  perTest.set(file, keys);
}

const report = results
  .map(({ file, exitCode }) => {
    const keys = perTest.get(file) ?? new Set();
    const unique = [...keys].filter((k) => hitCount.get(k) === 1);
    return { file, exitCode, covered: keys.size, unique: unique.length, uniqueLines: unique };
  })
  .sort((a, b) => a.unique - b.unique || a.file.localeCompare(b.file));

const moduleCoverage = modules.map((m) => {
  let total = 0;
  let covered = 0;
  for (const [src, ex] of executable) {
    if (!src.startsWith(m)) continue;
    total += ex.size;
    for (const n of ex) if (hitCount.has(`${src}:${n}`)) covered++;
  }
  return { module: m, total, covered, pct: total === 0 ? null : (covered / total) * 100 };
});

let allTotal = 0;
for (const ex of executable.values()) allTotal += ex.size;
const summary = {
  files: results.length,
  failedFiles: results.filter((r) => r.exitCode !== 0).map((r) => r.file),
  productLines: allTotal,
  coveredLines: hitCount.size,
  zeroUnique: report.filter((r) => r.unique === 0).map((r) => r.file),
  moduleCoverage,
};
writeFileSync(join(dir, "coverage.json"), `${JSON.stringify({ summary, report }, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, zeroUnique: summary.zeroUnique.length }, null, 2));
