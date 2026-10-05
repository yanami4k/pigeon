import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  DEFAULT_REPETITION_GUARD,
  DEFAULT_TRUNCATION_CONTINUATION,
  repetitionGuardSettings,
  WIDE_REPETITION_PARAMS,
} from "../state/runaway-config.ts";
import { DEFAULT_BACKGROUND_CLOSEOUT_SECONDS } from "../state/tools-config.ts";
import {
  effectivePigeonSettings,
  imageIdentityOf,
  installTerminationHandler,
  layersIdentity,
  resolveTaskSelection,
  runStreamExperiment,
  streamPigeonOptions,
} from "./stream-experiment.ts";
import type { StreamManifest, StreamStep } from "./stream-manifest.ts";
import {
  DEFAULT_STEP_BUDGET,
  EQUIVALENT_CASE_IMAGES,
  RUN_LOCK,
  STRANDS_V6_LAYERS,
  type StepClasses,
  selectSteps,
} from "./stream-runner.ts";
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

test("身份头与结果行记 Pigeon 实际生效的参数：没给的推理档位、单轮输出上限、压缩配置与项目级记忆上限记运行时缺省（off、16,384、产品缺省的压缩配置、4,000 字符），不记 null；记忆文字版本记 v2；主 agent 派 worker 记关（265）；给了的原样记", () => {
  assert.deepEqual(effectivePigeonSettings({}, "deepseek-flash"), {
    provider: "deepseek",
    modelId: "deepseek-flash",
    temperature: null,
    thinking: "off",
    maxOutputTokens: 16_384,
    compaction: {
      contextWindow: 1_000_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      thresholdTokens: 983_616,
    },
    memoryLimitChars: 4_000,
    memoryTextVersion: "v3",
    statusBlockVersion: "v1",
    spawnWorkers: false,
    webTools: false,
    takeWorker: false,
    workerTools: false,
    taskList: false,
    loopGuard: false,
    scriptOrchestration: false,
    truncationContinuation: DEFAULT_TRUNCATION_CONTINUATION,
    repetitionGuard: DEFAULT_REPETITION_GUARD,
    backgroundCloseoutSeconds: DEFAULT_BACKGROUND_CLOSEOUT_SECONDS,
  });
  assert.deepEqual(
    effectivePigeonSettings(
      {
        temperature: 0,
        thinking: "high",
        maxOutputTokens: 8_000,
        modelId: "m2",
        compaction: { thresholdTokens: 30_000, keepRecentTokens: 4000 },
        memoryLimitChars: 2000,
      },
      "deepseek-flash"
    ),
    {
      provider: "deepseek",
      modelId: "m2",
      temperature: 0,
      thinking: "high",
      maxOutputTokens: 8_000,
      compaction: {
        contextWindow: 1_000_000,
        reserveTokens: 16_384,
        keepRecentTokens: 4000,
        thresholdTokens: 30_000,
      },
      memoryLimitChars: 2000,
      memoryTextVersion: "v3",
      statusBlockVersion: "v1",
      spawnWorkers: false,
      webTools: false,
      takeWorker: false,
      workerTools: false,
      taskList: false,
      loopGuard: false,
      scriptOrchestration: false,
      truncationContinuation: DEFAULT_TRUNCATION_CONTINUATION,
      repetitionGuard: DEFAULT_REPETITION_GUARD,
      backgroundCloseoutSeconds: DEFAULT_BACKGROUND_CLOSEOUT_SECONDS,
    }
  );
});

test("身份头记撞上限续跑与流式重复检测的实际生效值（367）：给了非缺省的（续跑关、wide 档只记录）即原样记下", () => {
  const wideLog = repetitionGuardSettings({ mode: "log", preset: "wide" });
  assert.ok("settings" in wideLog);
  const continuationOff = { ...DEFAULT_TRUNCATION_CONTINUATION, enabled: false };
  const recorded = effectivePigeonSettings(
    {
      truncationContinuation: continuationOff,
      repetitionGuard: wideLog.settings,
      backgroundCloseoutSeconds: 60,
    },
    "deepseek-flash"
  );
  assert.deepEqual(recorded.truncationContinuation, continuationOff);
  // 决策 365：收尾等后台作业的总时限同样记实际生效值
  assert.equal(recorded.backgroundCloseoutSeconds, 60);
  assert.deepEqual(recorded.repetitionGuard, {
    enabled: true,
    mode: "log",
    preset: "wide",
    params: WIDE_REPETITION_PARAMS,
  });
});

test("镜像身份（⑥）：按内容层（RootFS 各层摘要的有序列表）取摘要，不看本地镜像 ID——经典存储与 containerd 存储下同一镜像判为同一个；层的顺序或内容不同即不同；取不到层即报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-image-layers-"));
  try {
    let n = 0;
    // 假 docker：按 --format 回镜像 ID 或内容层
    const fake = (id: string, layers: string) => {
      const file = join(dir, `docker-${n++}.mjs`);
      writeFileSync(
        file,
        [
          "const args = process.argv.slice(2);",
          `if (args.includes("{{.Id}}")) process.stdout.write(${JSON.stringify(id)} + "\\n");`,
          `else process.stdout.write(${JSON.stringify(layers)} + "\\n");`,
        ].join("\n")
      );
      return [process.execPath, file];
    };
    const layers = JSON.stringify(["sha256:aaa", "sha256:bbb"]);
    const classic = imageIdentityOf("img", fake("sha256:config", layers));
    const containerd = imageIdentityOf("img", fake("sha256:manifest", layers));
    assert.equal(classic, containerd, "本地镜像 ID 不同、内容层相同：同一镜像");
    assert.equal(classic, layersIdentity(["sha256:aaa", "sha256:bbb"]));
    assert.match(classic, /^layers:sha256:[0-9a-f]{64}$/);
    assert.notEqual(
      imageIdentityOf("img", fake("x", JSON.stringify(["sha256:bbb", "sha256:aaa"]))),
      classic,
      "层的顺序不同即不同"
    );
    assert.notEqual(
      imageIdentityOf("img", fake("x", JSON.stringify(["sha256:aaa", "sha256:ccc"]))),
      classic
    );
    assert.throws(() => imageIdentityOf("img", fake("x", "null")), /取不到镜像 img 的内容层/);
    assert.throws(() => imageIdentityOf("img", fake("x", "[]")), /没有内容层/);
    // strands v6 的内容层身份（本机经典存储与验证服务器 containerd 存储下实测相同）
    assert.equal(
      STRANDS_V6_LAYERS,
      "layers:sha256:ebe5a5270ca0fcee26caf49d6695a56b090b81b027fed92ac7eac8c35b60c5fa"
    );
    // 已落盘的人的基准记的是经典存储下的 config 摘要：v6 与 v4 的都按等价读回到 v6 的内容层身份
    const pairs = [...EQUIVALENT_CASE_IMAGES].map(([a, b]) => `${a}>${b}`);
    for (const old of [
      "sha256:d23b0a512ca217bc2c7984bf33dc52c1006cbf0cd2a9642b7638efb0e3f99b42",
      "sha256:281bf24305dd0891440e1ecf3a07f09644688f8b28a4e770a5522a43b4d6d8d6",
    ]) {
      assert.ok(pairs.includes(`${old}>${STRANDS_V6_LAYERS}`), old);
    }
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

test("接口数据的清单摘要与本次清单不符（374）：在写身份头、起容器之前拒绝开跑", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-interfaces-"));
  try {
    const manifestFile = join(dir, "manifest.json");
    writeFileSync(manifestFile, JSON.stringify({ ...taskManifest(1), repo: "strands-py" }));
    const interfacesFile = join(dir, "task-interfaces.json");
    writeFileSync(
      interfacesFile,
      JSON.stringify({ manifestDigest: "0000000000000000", tasks: [] })
    );
    const outDir = join(dir, "out");
    await assert.rejects(
      runStreamExperiment({
        manifestFile,
        taskInterfacesFile: interfacesFile,
        repoDir: dir,
        image: "img",
        outDir,
        conditions: ["search-only"],
        gateway: { accounts: [{ key: "k", concurrency: 2 }], modelId: "m" },
        budget: DEFAULT_STEP_BUDGET,
        // 摘要检查若排在取镜像身份之后，这里会先报 docker 起不来
        docker: [join(dir, "no-docker")],
      }),
      /清单摘要/
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
  unbuildable: null,
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
