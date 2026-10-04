// 基准：打包产物从进程启动到发出第一个模型请求（决策 351，提交 d930471、a85e6dd：用 esbuild 把命令行打成 dist/ 下单文件，
// 启动时不再逐个加载源码与第三方模块的大量小文件）。做法同 scripts/bundle-smoke.mjs 的 --measure：起
// `node dist/pigeon.mjs run … --stream-fn <假模型>`，假模型不加载仓库与上游的任何模块（免得它自己的加载时间算进去），收到
// 第一个请求时往标准错误输出写一个标记；从 spawn 到父进程读到标记即一次的耗时，读到后立即杀掉子进程并等它退出（杀进程的
// 开销固定，算在内）。同组另量源码入口（node src/cli/index.ts，Node 原生剥类型）作参照，两者之比即打包的收益。
// 本基准不负责打包：dist/pigeon.mjs 不存在时整组跳过，先在仓库根跑 npm run bundle。
// 不发真实请求、不经手任何 key：假模型是写到临时目录里的一个本地模块；每次运行用新的临时目录作工作区与家目录，不读写
// 使用者的设置与记忆。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const BUNDLE = join(repoRoot, "dist", "pigeon.mjs");
const SOURCE = join(repoRoot, "src", "cli", "index.ts");
const MARKER = "PIGEON_BENCH_FIRST_REQUEST";
const BUNDLE_MISSING = !existsSync(BUNDLE);
const SUITE = BUNDLE_MISSING
  ? "打包产物启动到第一个请求（决策 351）——dist/pigeon.mjs 不存在，跳过；先 npm run bundle"
  : "打包产物启动到第一个请求（决策 351）";
const OPTIONS = { time: 10_000, iterations: 10, warmupIterations: 1 };

// 子进程环境：沿用当前环境（PATH 等），另指定家目录；去掉会拖慢或改变启动的 Node 旗标与覆盖率收集
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of ["NODE_OPTIONS", "NODE_V8_COVERAGE"]) {
    Reflect.deleteProperty(env, name);
  }
  return env;
}

// 计时用的极简假模型（照 scripts/measure-stream-fn.mjs）：第一个请求时同步往标准错误输出写标记，回一句文字收尾
const FAKE_STREAM_FN = `
import { writeSync } from "node:fs";
let first = true;
export default function benchStreamFn(model) {
  if (first) {
    first = false;
    writeSync(2, "\\n${MARKER} " + performance.now().toFixed(1) + "\\n");
  }
  const usage = {
    input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message = {
    role: "assistant", content: [{ type: "text", text: "完成。" }], api: model.api,
    provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now(),
  };
  const events = [
    { type: "start", partial: { ...message, content: [] } },
    { type: "done", reason: "stop", message },
  ];
  return {
    async *[Symbol.asyncIterator]() { for (const event of events) yield event; },
    result: async () => message,
  };
}
`;

describe.skipIf(BUNDLE_MISSING)(SUITE, () => {
  let base = "";
  let fake = "";
  let runs = 0;
  // 子进程自己报的"自进程启动起到第一个请求"的毫秒数，afterAll 打出中位数
  const reported: Record<string, number[]> = { bundle: [], source: [] };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "pigeon-bench-startup-"));
    fake = join(base, "bench-stream-fn.mjs");
    writeFileSync(fake, FAKE_STREAM_FN);
  });

  afterAll(() => {
    for (const [kind, values] of Object.entries(reported)) {
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
      console.log(
        `${kind}：子进程自报到第一个请求的中位 ${median.toFixed(1)} ms（${values.length} 次）`
      );
    }
    if (base !== "") rmSync(base, { recursive: true, force: true });
  });

  // 起一次 pigeon run，等到第一个请求的标记即杀掉子进程并等它退出
  const firstRequest = async (kind: "bundle" | "source", entry: string): Promise<void> => {
    runs += 1;
    const dir = join(base, `run-${runs}`);
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    const args = [entry, "run", "说一句话", "--root", work, "--stream-fn", fake, "--yolo"];
    const child = spawn(process.execPath, [...args, "--no-spawn-workers"], {
      env: childEnv(dir),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let stderr = "";
    try {
      await new Promise<void>((resolve, reject) => {
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
          const match = new RegExp(`${MARKER} ([0-9.]+)`).exec(stderr);
          if (match !== null) {
            reported[kind]?.push(Number(match[1]));
            resolve();
          }
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`pigeon run 在第一个请求之前退出（退出码 ${code}）：\n${stderr}`))
        );
      });
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  };

  test("打包产物 dist/pigeon.mjs：启动到第一个请求", async ({ bench }) => {
    await bench("打包产物 dist/pigeon.mjs：启动到第一个请求", () =>
      firstRequest("bundle", BUNDLE)
    ).run(OPTIONS);
  });

  test("参照：源码入口 src/cli/index.ts：启动到第一个请求", async ({ bench }) => {
    await bench("参照：源码入口 src/cli/index.ts：启动到第一个请求", () =>
      firstRequest("source", SOURCE)
    ).run(OPTIONS);
  });
});
