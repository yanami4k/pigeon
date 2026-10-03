// 打包产物的冒烟测试与计时（决策 351）。
//   node scripts/bundle-smoke.mjs：CI 在构建后运行。pigeon --version 输出 package.json 的版本、没有告警；以仓库的假模型
//     （createFakeStreamFn）跑一次 pigeon run，确认发出了第一个请求并正常结束。
//   node scripts/bundle-smoke.mjs --measure <N>：源码与打包产物交替各跑 N 次 pigeon run（假模型不加载仓库模块），记到第一个
//     请求的时间（自进程启动起的毫秒）并取中位。
// 每次运行用临时目录作工作区与家目录，不读写使用者的设置与记忆。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ENTRIES = {
  bundle: join(root, "dist", "pigeon.mjs"),
  source: join(root, "src", "cli", "index.ts"),
};
const SMOKE_FAKE = join(root, "scripts", "smoke-stream-fn.ts");
const MEASURE_FAKE = join(root, "scripts", "measure-stream-fn.mjs");

function pigeon(entry, args, env = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
}

// 跑一次 pigeon run，返回第一个请求时自进程启动起的毫秒数
function firstRequestMs(entry, fake) {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-smoke-"));
  try {
    const work = join(dir, "work");
    mkdirSync(work);
    const log = join(dir, "requests.log");
    const result = pigeon(
      entry,
      ["run", "说一句话", "--root", work, "--stream-fn", fake, "--yolo", "--no-spawn-workers"],
      { SMOKE_LOG: log, HOME: dir, USERPROFILE: dir }
    );
    if (result.status !== 0) {
      throw new Error(`pigeon run 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`);
    }
    const times = existsSync(log)
      ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number)
      : [];
    if (times.length === 0) {
      throw new Error(`pigeon run 没有发出请求\n${result.stdout}\n${result.stderr}`);
    }
    return times[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const measureAt = process.argv.indexOf("--measure");
if (measureAt >= 0) {
  const times = Number(process.argv[measureAt + 1] ?? "5");
  const runs = { source: [], bundle: [] };
  for (let i = 0; i < times; i++) {
    for (const kind of ["source", "bundle"]) {
      runs[kind].push(Math.round(firstRequestMs(ENTRIES[kind], MEASURE_FAKE)));
    }
  }
  console.log(
    JSON.stringify({
      runs,
      median: { source: median(runs.source), bundle: median(runs.bundle) },
    })
  );
} else {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = pigeon(ENTRIES.bundle, ["--version"]);
  if (version.status !== 0 || version.stdout.trim() !== `pigeon ${pkg.version}`) {
    throw new Error(
      `pigeon --version 不符：${version.status}\n${version.stdout}\n${version.stderr}`
    );
  }
  if (version.stderr.trim() !== "") {
    throw new Error(`pigeon --version 有告警：\n${version.stderr}`);
  }
  const ms = firstRequestMs(ENTRIES.bundle, SMOKE_FAKE);
  console.log(`冒烟通过：${version.stdout.trim()}；pigeon run 第一个请求在 ${Math.round(ms)} 毫秒`);
}
