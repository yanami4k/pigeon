// 联网工具的开关（决策 291、346）：--no-web、设置 web.enabled 为 false、沙箱断网档三者任一成立就不给联网工具；
// 缺省照旧给。判定收在 webToolsEnabled 一处，入口与 /reload 都经 webToolsOptionOf。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import {
  emptySettingsSnapshot,
  mergeSettingsLayers,
  type SettingsSnapshot,
} from "../state/settings.ts";
import type { WebSection } from "../state/web-config.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../tools/host-scope.ts";
import {
  parseLaunchFlags,
  VALUELESS_FLAGS,
  webToolsEnabled,
  webToolsOptionOf,
} from "./launch-flags.ts";
import { buildRuntime, WEB_TOOLS_SENTENCE } from "./runtime.ts";

const parse = (argv: string[]) => parseLaunchFlags(argv, { usage: "u", sandbox: true, env: {} });

// 只带 web 一节的快照
function snapshotWithWeb(web: WebSection | undefined): SettingsSnapshot {
  const empty = emptySettingsSnapshot("/r");
  return web === undefined ? empty : { ...empty, merged: { ...empty.merged, web } };
}

test("断网档不给联网工具；不开沙箱与沙箱联网都给", () => {
  assert.equal(webToolsEnabled(parse([]), undefined), true);
  assert.equal(webToolsEnabled(parse(["--sandbox"]), undefined), true);
  assert.equal(webToolsEnabled(parse(["--sandbox", "--sandbox-network", "on"]), undefined), true);
  assert.equal(webToolsEnabled(parse(["--sandbox", "--sandbox-network", "off"]), undefined), false);
  assert.equal(
    webToolsEnabled(
      parse(["--sandbox", "--sandbox-network", "off", "--sandbox-approval", "prompt"]),
      undefined
    ),
    false
  );
});

test("--no-web 只对本次运行关掉联网工具；无取值，各入口都认", () => {
  assert.equal(VALUELESS_FLAGS.has("--no-web"), true);
  assert.equal(parse([]).noWeb, false);
  assert.equal(parse(["--no-web"]).noWeb, true);
  // 不收沙箱与派 worker 参数的入口（命令行续跑）同样接受
  assert.equal(parseLaunchFlags(["--no-web"], { usage: "u", env: {} }).noWeb, true);
  assert.equal(webToolsEnabled(parse(["--no-web"]), undefined), false);
  assert.equal(webToolsEnabled(parse(["--no-web", "--sandbox"]), undefined), false);
});

test("设置 web.enabled 为 false 时不给；为 true 或不写时给", () => {
  assert.equal(webToolsEnabled(parse([]), { enabled: false }), false);
  assert.equal(webToolsEnabled(parse([]), { enabled: true }), true);
  assert.equal(webToolsEnabled(parse([]), {}), true);
  // 设置开着也挡不住另两种关法
  assert.equal(webToolsEnabled(parse(["--no-web"]), { enabled: true }), false);
  assert.equal(
    webToolsEnabled(parse(["--sandbox", "--sandbox-network", "off"]), { enabled: true }),
    false
  );
});

test("web.enabled 三层按标量覆盖：高优先层说了算，没写的层不改上一层的值", () => {
  const merged = (layers: Array<["user" | "project" | "local", boolean | undefined]>) =>
    mergeSettingsLayers(
      layers.map(([layer, enabled]) => ({
        layer,
        file: enabled === undefined ? { web: { search: { maxResults: 3 } } } : { web: { enabled } },
      }))
    ).merged.web?.enabled;
  assert.equal(merged([["user", false]]), false);
  assert.equal(
    merged([
      ["user", false],
      ["project", true],
    ]),
    true
  );
  assert.equal(
    merged([
      ["user", true],
      ["project", undefined],
      ["local", false],
    ]),
    false
  );
  assert.equal(
    merged([
      ["user", false],
      ["project", undefined],
    ]),
    false
  );
});

test("三种关法下两件工具与联网那句提示都不出现；缺省照旧注册", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-no-web-"));
  try {
    const cases: Array<{ label: string; argv: string[]; web?: WebSection; on: boolean }> = [
      { label: "缺省", argv: [], on: true },
      { label: "--no-web", argv: ["--no-web"], on: false },
      { label: "web.enabled=false", argv: [], web: { enabled: false }, on: false },
      { label: "沙箱断网档", argv: ["--sandbox", "--sandbox-network", "off"], on: false },
    ];
    for (const { label, argv, web, on } of cases) {
      const option = webToolsOptionOf(parse(argv), snapshotWithWeb(web), {});
      assert.equal(option.webTools !== undefined, on, label);
      const bundle = buildRuntime({
        streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
        workspaceRoot: root,
        homeDir: root,
        sessionId: newSessionId(),
        yolo: false,
        provider: "fake-provider",
        modelId: "fake-model-1",
        createApprovalHandler: () => async () => ({ approved: false }),
        ...option,
      });
      try {
        const snapshot = bundle.adapter.snapshot();
        assert.equal(snapshot.tools.advertised.includes(WEB_SEARCH_TOOL), on, label);
        assert.equal(snapshot.tools.advertised.includes(WEB_FETCH_TOOL), on, label);
        assert.equal(snapshot.context.systemPrompt.includes(WEB_TOOLS_SENTENCE), on, label);
        assert.equal(bundle.toolTiers.get(WEB_FETCH_TOOL), on ? "network" : undefined);
        assert.equal(bundle.toolTiers.get(WEB_SEARCH_TOOL), on ? "read" : undefined);
      } finally {
        await bundle.adapter.dispose();
        await bundle.sessionStore.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
