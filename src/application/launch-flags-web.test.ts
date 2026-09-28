// 沙箱断网档与联网工具（决策 291）：--sandbox-network off 时不给联网工具；不开沙箱或沙箱联网时给。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLaunchFlags, webToolsEnabled } from "./launch-flags.ts";

const parse = (argv: string[]) => parseLaunchFlags(argv, { usage: "u", sandbox: true, env: {} });

test("断网档不给联网工具；不开沙箱与沙箱联网都给", () => {
  assert.equal(webToolsEnabled(parse([])), true);
  assert.equal(webToolsEnabled(parse(["--sandbox"])), true);
  assert.equal(webToolsEnabled(parse(["--sandbox", "--sandbox-network", "on"])), true);
  assert.equal(webToolsEnabled(parse(["--sandbox", "--sandbox-network", "off"])), false);
  assert.equal(
    webToolsEnabled(
      parse(["--sandbox", "--sandbox-network", "off", "--sandbox-approval", "prompt"])
    ),
    false
  );
});
