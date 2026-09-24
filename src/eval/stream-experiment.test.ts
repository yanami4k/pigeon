import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { effectivePigeonSettings, imageIdOf, streamPigeonOptions } from "./stream-experiment.ts";

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
