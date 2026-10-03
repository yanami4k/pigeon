// 测试耗时量具：每个测试文件单独起一个 node --test 进程，按并发数排队，记每个文件的墙钟、测试项数与每个测试的耗时。
// 用法：node scripts/test-timing.mjs [--concurrency N] [--out 结果.json] [--top K] [文件或 glob ...]
// 不给文件时量 src/**/*.test.ts 全部；结果 JSON 供前后对比，终端打印最慢的 K 个文件（默认 30）。
import { spawn } from "node:child_process";
import { globSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";

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
if (patterns.length === 0) patterns.push("src/**/*.test.ts");
const files = [...new Set(patterns.flatMap((p) => globSync(p)))]
  .map((f) => f.replaceAll("\\", "/"))
  .sort();

// 解析 TAP：叶子测试（type: 'test'）的名称、层级与耗时，以及文件末尾的计数
function parseTap(text) {
  const lines = text.split(/\r?\n/);
  const tests = [];
  const counts = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/.exec(lines[i]);
    if (m !== null) {
      let durationMs = null;
      let type = null;
      for (let j = i + 1; j < lines.length && j < i + 40; j++) {
        const d = /^\s*duration_ms: ([\d.]+)/.exec(lines[j]);
        if (d !== null) durationMs = Number(d[1]);
        const t = /^\s*type: '(\w+)'/.exec(lines[j]);
        if (t !== null) type = t[1];
        if (/^\s*\.\.\.$/.test(lines[j])) break;
      }
      if (type === "test") {
        tests.push({
          name: m[3],
          depth: m[1].length / 4,
          ok: m[2] === "ok",
          skipped: m[4] === "SKIP",
          durationMs,
        });
      }
      continue;
    }
    const c = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/.exec(
      lines[i]
    );
    if (c !== null) counts[c[1]] = Number(c[2]);
  }
  return { tests, counts };
}

function runFile(file) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      const wallMs = Math.round(performance.now() - started);
      const { tests, counts } = parseTap(Buffer.concat(chunks).toString("utf8"));
      resolve({ file, wallMs, exitCode: code, counts, tests });
    });
  });
}

const started = performance.now();
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (next < files.length) {
      const file = files[next++];
      results.push(await runFile(file));
    }
  })
);
const totalWallMs = Math.round(performance.now() - started);
results.sort((a, b) => b.wallMs - a.wallMs);

const sum = (k) => results.reduce((n, r) => n + (r.counts[k] ?? 0), 0);
const summary = {
  files: results.length,
  concurrency,
  totalWallMs,
  tests: sum("tests"),
  pass: sum("pass"),
  fail: sum("fail"),
  skipped: sum("skipped"),
  cancelled: sum("cancelled"),
  failedFiles: results.filter((r) => r.exitCode !== 0).map((r) => r.file),
};
if (out !== undefined) writeFileSync(out, `${JSON.stringify({ summary, results }, null, 2)}\n`);

console.log(JSON.stringify(summary));
console.log(`\n最慢的 ${top} 个文件（墙钟秒 / 测试项数）：`);
for (const r of results.slice(0, top)) {
  console.log(
    `${(r.wallMs / 1000).toFixed(1).padStart(7)}  ${String(r.counts.tests ?? "?").padStart(4)}  ${r.file}`
  );
}
process.exitCode = summary.failedFiles.length > 0 ? 1 : 0;
