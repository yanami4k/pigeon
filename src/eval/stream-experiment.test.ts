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
  runStreamExperiment,
  runStreamTrialExperiment,
  streamPigeonOptions,
} from "./stream-experiment.ts";
import { DEFAULT_STEP_BUDGET, RUN_LOCK } from "./stream-runner.ts";

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

test("输出目录的锁在读清单、写身份头、起网关探测之前取：另一个进程占着即拒绝，身份头不动（正式跑批与试跑）", async () => {
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
      conditions: ["full" as const],
      gateway: { accounts: [{ key: "k", concurrency: 2 }], modelId: "m" },
    };
    await assert.rejects(
      runStreamExperiment({ ...common, budget: DEFAULT_STEP_BUDGET }),
      /正被另一个跑批进程使用/
    );
    await assert.rejects(
      runStreamTrialExperiment({
        ...common,
        steps: [1],
        budget: DEFAULT_STEP_BUDGET,
        concurrency: 1,
      }),
      /正被另一个跑批进程使用/
    );
    assert.equal(existsSync(join(outDir, "identity.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
