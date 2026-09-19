// 上游版本探测（M7，ROADMAP §M7"启动时探测上游版本，与已验证版本不匹配时明确告警，不静默继续"）：
// 会话树契约测试针对的是 core 0.84.4 的 v4 JSONL 格式；实际安装的上游包版本与已验证版本不一致时给出告警文本。
import assert from "node:assert/strict";
import { test } from "node:test";
import { probeUpstreamVersions, VERIFIED_UPSTREAM_VERSION } from "./upstream-version.ts";

test("已验证版本为 0.84.4；本仓库实际安装的三个上游包与之一致，没有告警", () => {
  assert.equal(VERIFIED_UPSTREAM_VERSION, "0.84.4");
  const probe = probeUpstreamVersions();
  assert.deepEqual(probe.packages.map((entry) => entry.name).sort(), [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ]);
  assert.equal(probe.warnings.length, 0, probe.warnings.join("\n"));
});

test("版本不一致或读不出版本：逐包给出明确告警", () => {
  const probe = probeUpstreamVersions((name) =>
    name === "@earendil-works/pi-ai"
      ? "0.85.0"
      : name === "@earendil-works/pi-tui"
        ? undefined
        : "0.84.4"
  );
  assert.equal(probe.warnings.length, 2);
  assert.ok(probe.warnings.some((line) => line.includes("pi-ai") && line.includes("0.85.0")));
  assert.ok(probe.warnings.some((line) => line.includes("pi-tui") && line.includes("读不出")));
});
