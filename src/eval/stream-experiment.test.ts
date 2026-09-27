import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  effectivePigeonSettings,
  imageIdOf,
  installTerminationHandler,
  resolveTaskSelection,
  runStreamExperiment,
  streamPigeonOptions,
} from "./stream-experiment.ts";
import type { StreamManifest, StreamStep } from "./stream-manifest.ts";
import { DEFAULT_STEP_BUDGET, RUN_LOCK, type StepClasses, selectSteps } from "./stream-runner.ts";
import { PythonRandom, SAMPLE_POPULATION } from "./stream-sample.ts";

test("延续式跑批的 Pigeon 各条件一律无人值守放权（yolo），不依赖调用方传；调用方传了 false 也不算数", () => {
  assert.equal(streamPigeonOptions({ provider: "kimi-coding", modelId: "m" }).yolo, true);
  const forced = streamPigeonOptions({
    provider: "kimi-coding",
    modelId: "m",
    ...({ yolo: false } as object),
  });
  assert.equal(forced.yolo, true);
  assert.equal(forced.provider, "kimi-coding");
});

test("身份头与结果行记 Pigeon 实际生效的参数：没给的推理档位与单轮输出上限记运行时缺省（off、16,384），不记 null；给了的原样记", () => {
  assert.deepEqual(effectivePigeonSettings({}, "kimi-for-coding"), {
    provider: "kimi-coding",
    modelId: "kimi-for-coding",
    temperature: null,
    thinking: "off",
    maxOutputTokens: 16_384,
  });
  assert.deepEqual(
    effectivePigeonSettings(
      { temperature: 0, thinking: "high", maxOutputTokens: 8_000, modelId: "m2" },
      "kimi-for-coding"
    ),
    {
      provider: "kimi-coding",
      modelId: "m2",
      temperature: 0,
      thinking: "high",
      maxOutputTokens: 8_000,
    }
  );
});

test("镜像 ID：经典存储下取 config 摘要；containerd 镜像存储下取到的是 manifest 摘要、与已记下的对不上，响亮报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-image-store-"));
  try {
    const fake = (status: string) => {
      const file = join(dir, `docker-${status.length}.mjs`);
      writeFileSync(
        file,
        [
          "const args = process.argv.slice(2);",
          `if (args[0] === "info") process.stdout.write(${JSON.stringify(status)} + "\\n");`,
          'else process.stdout.write("sha256:config\\n");',
        ].join("\n")
      );
      return [process.execPath, file];
    };
    assert.equal(
      imageIdOf("img", fake('overlay2|[["Backing Filesystem","extfs"]]')),
      "sha256:config"
    );
    assert.throws(
      () => imageIdOf("img", fake('overlayfs|[["driver-type","io.containerd.snapshotter.v1"]]')),
      /containerd 镜像存储/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGTERM：第一次交给控制器收尾并设硬时限，到时仍没退出即以 143 退出；再收到一次立即退出；卸下后不再响应", async () => {
  const target = new EventEmitter();
  const stops: string[] = [];
  const exits: number[] = [];
  const dispose = installTerminationHandler(
    target,
    (reason) => stops.push(reason),
    (code) => exits.push(code),
    50
  );
  target.emit("SIGTERM");
  assert.equal(stops.length, 1);
  assert.match(stops[0] ?? "", /SIGTERM.*作废/);
  assert.deepEqual(exits, [], "收尾期间不立即退出");
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(exits, [143], "硬时限到即退出");
  target.emit("SIGTERM");
  assert.deepEqual(exits, [143, 143], "再收到一次立即退出");
  assert.equal(stops.length, 1, "只收尾一次");
  dispose();
  target.emit("SIGTERM");
  assert.deepEqual(exits, [143, 143]);
  // 收尾在时限内完成、卸下处理器：硬时限不再触发
  const late: number[] = [];
  const again = installTerminationHandler(
    target,
    () => {},
    (code) => late.push(code),
    50
  );
  target.emit("SIGTERM");
  again();
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(late, []);
});

test("输出目录的锁在读清单、写身份头、起网关探测之前取：另一个进程占着即拒绝，身份头不动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-lock-"));
  try {
    const outDir = join(dir, "out");
    mkdirSync(outDir);
    writeFileSync(
      join(outDir, RUN_LOCK),
      `${JSON.stringify({ pid: process.pid, acquiredAt: 1 })}\n`
    );
    // 清单文件不存在：锁取得晚的话报的是读清单失败
    const common = {
      manifestFile: join(dir, "missing.json"),
      repoDir: dir,
      image: "img",
      outDir,
      conditions: ["search-only" as const],
      gateway: { accounts: [{ key: "k", concurrency: 2 }], modelId: "m" },
    };
    await assert.rejects(
      runStreamExperiment({ ...common, budget: DEFAULT_STEP_BUDGET }),
      /正被另一个跑批进程使用/
    );
    assert.equal(existsSync(join(outDir, "identity.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 一份只有题的清单：第 i 道题的提交为 c<i>、步序为 2i（中间隔着不跑的步）
function taskManifest(n: number): StreamManifest {
  const steps = Array.from(
    { length: n },
    (_, i): StreamStep => ({
      seq: 2 * (i + 1),
      kind: "task",
      commit: `c${i + 1}`,
      parent: `p${i + 1}`,
      subject: `t${i + 1}`,
      message: `t${i + 1}`,
      prompt: null,
      humanFiles: [],
      judgeTests: [],
      reason: "",
    })
  );
  return {
    version: 1,
    repo: "toy",
    rangeStart: "p1",
    rangeEnd: `c${n}`,
    gateCommand: [],
    steps: [...steps, { ...(steps[0] as StreamStep), seq: 999, kind: "skip", commit: "skip" }],
    streams: [],
  };
}

const classesWith = (failToPass: number): StepClasses => ({
  commit: "c",
  parent: "p",
  failToPass: Array.from({ length: failToPass }, (_, i) => `t::${i}`),
  passToPass: [],
  excludedFlaky: [],
  failToPassOutsideJudgeFiles: 0,
});

test("选题（202、219）：抽样只在要做到的不为零的题里、按 Python random.Random(种子).sample 抽再按时间排序，与 Python 逐位一致；给题号即按题号；都不给为全部；两者都给、题没算完两类用例即拒绝", () => {
  const manifest = taskManifest(20);
  // 第 4、9、13 道题要做到的为零，不在总体里
  const zero = new Set(["c4", "c9", "c13"]);
  const reference = {
    cachedClasses: (step: StreamStep) => classesWith(zero.has(step.commit) ? 0 : 2),
  };
  const picked = resolveTaskSelection(manifest, reference, { sample: { k: 5 } });
  const population = Array.from({ length: 20 }, (_, i) => i + 1).filter(
    (n) => ![4, 9, 13].includes(n)
  );
  const expected = new PythonRandom(20260927).sample(population, 5).sort((a, b) => a - b);
  assert.deepEqual(picked, {
    method: "sample",
    seed: 20260927,
    k: 5,
    population: SAMPLE_POPULATION,
    tasks: expected,
  });
  // 由 CPython 3.13 算出的对照：random.Random(20260927).sample([1..20 去掉 4、9、13], 5) 排序后
  assert.deepEqual(expected, [2, 7, 10, 17, 19]);
  assert.ok(picked.method === "sample" && picked.tasks.every((n) => !zero.has(`c${n}`)));
  assert.equal(
    (resolveTaskSelection(manifest, reference, { sample: { k: 5, seed: 7 } }) as { seed: number })
      .seed,
    7
  );
  assert.deepEqual(resolveTaskSelection(manifest, reference, { tasks: [3, 1] }), {
    method: "list",
    tasks: [3, 1],
  });
  assert.deepEqual(resolveTaskSelection(manifest, reference, {}), { method: "all" });
  assert.throws(
    () => resolveTaskSelection(manifest, reference, { tasks: [1], sample: { k: 2 } }),
    /二选一/
  );
  assert.throws(
    () =>
      resolveTaskSelection(
        manifest,
        { cachedClasses: (s) => (s.commit === "c7" ? undefined : classesWith(1)) },
        { sample: { k: 2 } }
      ),
    /还缺 1 道（题号 7）.*--check classes/
  );
  // 选出的题号按时间顺序对到步；越界、重复即拒绝
  assert.deepEqual(
    selectSteps(manifest, { tasks: [3, 1] }).map((s) => s.seq),
    [2, 6]
  );
  assert.deepEqual(
    selectSteps(manifest, { tasks: [3, 1, 5], maxSteps: 2 }).map((s) => s.seq),
    [2, 6]
  );
  assert.throws(() => selectSteps(manifest, { tasks: [21] }), /题号 21 越界/);
  assert.throws(() => selectSteps(manifest, { tasks: [2, 2] }), /题号 2 重复/);
});
