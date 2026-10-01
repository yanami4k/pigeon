// 决策 333：settings 的 sandbox 一节里的资源上限字段——memory（带单位的大小，k/m/g/t 按 1024 进位；0 为不限）、
// pids（非负整数，0 为不限）、cpus（非负数，0 为不限）；不写取缺省（由开沙箱时定）。写法不对、节内未知键一律报错并指出
// 文件与层；内存低于 Docker 的下限 6 MiB 报错；三层逐键合并（个人层只改其中一项时其余沿用下层）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMemorySize, sandboxLimitSettingsOf } from "./sandbox-config.ts";
import {
  mergedSettingsProblems,
  mergeSettingsLayers,
  type SettingsFile,
  validateSettingsLayer,
} from "./settings.ts";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

function check(raw: unknown) {
  return validateSettingsLayer(raw, { layer: "project", file: ".pigeon/settings.json" });
}

test("资源上限字段：合法写法通过校验，换算成字节、进程数与核数；不写的项不出现（取缺省）", () => {
  const ok = check({ sandbox: { memory: "8g", pids: 2048, cpus: 1.5 } });
  assert.ok("file" in ok, JSON.stringify(ok));
  assert.deepEqual(sandboxLimitSettingsOf(ok.file.sandbox ?? {}), {
    memoryBytes: 8 * GiB,
    pids: 2048,
    cpus: 1.5,
  });
  assert.deepEqual(sandboxLimitSettingsOf({ memory: 0, pids: 0, cpus: 0 }), {
    memoryBytes: 0,
    pids: 0,
    cpus: 0,
  });
  assert.deepEqual(sandboxLimitSettingsOf({ image: "python:3.12" }), {});
  assert.equal(parseMemorySize("512m"), 512 * MiB);
  assert.equal(parseMemorySize("1.5G"), 1.5 * GiB);
  assert.equal(parseMemorySize("64k"), 64 * 1024);
  assert.equal(parseMemorySize("1t"), 1024 * GiB);
  assert.equal(parseMemorySize("0"), 0);
  assert.equal(parseMemorySize(0), 0);
});

test("资源上限字段：写法不对与未知键报错，指出文件与键；内存低于 6 MiB 报错", () => {
  for (const sandbox of [
    { memory: "8" },
    { memory: "8gb" },
    { memory: 8 },
    { memory: "-1g" },
    { pids: -1 },
    { pids: 1.5 },
    { cpus: -0.5 },
    { cpus: "2" },
    { memoryLimit: "8g" },
  ]) {
    const checked = check({ sandbox });
    assert.ok("problems" in checked, `应当报错：${JSON.stringify(sandbox)}`);
    assert.match(checked.problems.join("\n"), /\.pigeon\/settings\.json/);
  }
  const tiny = mergeSettingsLayers([
    { layer: "project", file: { sandbox: { memory: "4m" } } as SettingsFile },
  ]);
  assert.match(mergedSettingsProblems(tiny.merged).join("\n"), /sandbox：memory 至少 6m/);
  const fine = mergeSettingsLayers([
    { layer: "project", file: { sandbox: { memory: "6m" } } as SettingsFile },
  ]);
  assert.deepEqual(mergedSettingsProblems(fine.merged), []);
});

test("资源上限字段按键逐层合并：个人层只改一项时其余沿用下层", () => {
  const { merged } = mergeSettingsLayers([
    { layer: "user", file: { sandbox: { memory: "16g", pids: 1024 } } as SettingsFile },
    { layer: "project", file: { sandbox: { image: "python:3.12", cpus: 4 } } as SettingsFile },
    { layer: "local", file: { sandbox: { pids: 0 } } as SettingsFile },
  ]);
  assert.deepEqual(sandboxLimitSettingsOf(merged.sandbox ?? {}), {
    memoryBytes: 16 * GiB,
    pids: 0,
    cpus: 4,
  });
});
