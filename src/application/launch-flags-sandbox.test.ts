// 日常沙箱的启动参数（决策 237、246、248）：--sandbox 缺省联网、审批全部放行；--sandbox-network off 断网；
// --sandbox-approval prompt 改回逐条询问；沙箱参数只配合 --sandbox 用，不接受沙箱的入口当未知参数。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLaunchFlags, VALUELESS_FLAGS } from "./launch-flags.ts";

const parse = (argv: string[]) => parseLaunchFlags(argv, { usage: "u", sandbox: true, env: {} });

test("--sandbox：缺省联网、审批全部放行（复用 yolo）", () => {
  const flags = parse(["--sandbox"]);
  assert.deepEqual(flags.sandbox, { network: "on", approval: "yolo" });
  assert.equal(flags.yolo, true);
  assert.ok(VALUELESS_FLAGS.has("--sandbox"), "续跑与 run 的参数切分不吞下一个参数");
  assert.equal(parse([]).sandbox, undefined);
  assert.equal(parse([]).yolo, false, "不开沙箱时审批照旧");
});

test("--sandbox-approval prompt 改回逐条询问；另给 --yolo 仍放行", () => {
  const prompt = parse(["--sandbox", "--sandbox-approval", "prompt"]);
  assert.equal(prompt.yolo, false);
  assert.equal(prompt.sandbox?.approval, "prompt");
  assert.equal(parse(["--sandbox-approval", "prompt", "--sandbox", "--yolo"]).yolo, true);
});

test("--sandbox-network off 断网；取值形状为档位名，非法取值报错", () => {
  assert.equal(parse(["--sandbox", "--sandbox-network", "off"]).sandbox?.network, "off");
  assert.equal(parse(["--sandbox", "--sandbox-network", "on"]).sandbox?.network, "on");
  assert.throws(() => parse(["--sandbox", "--sandbox-network", "none"]), /on\/off/);
  assert.throws(() => parse(["--sandbox", "--sandbox-approval", "ask"]), /yolo\/prompt/);
});

test("沙箱参数只配合 --sandbox 用；不接受沙箱的入口当未知参数", () => {
  assert.throws(() => parse(["--sandbox-network", "off"]), /只配合 --sandbox/);
  assert.throws(() => parse(["--sandbox-approval", "prompt"]), /只配合 --sandbox/);
  assert.throws(
    () => parseLaunchFlags(["--sandbox"], { usage: "u", env: {} }),
    /未知参数：--sandbox/
  );
});
