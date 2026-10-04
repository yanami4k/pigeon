// write_file 与编辑同规矩（决策 358）：写档、受保护路径（项目 .pigeon）须人逐次批准——没有审批通道时即使有配置放权也拒写，
// 普通文件照常按放权写入。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import { asGrantId, newSessionId } from "../state/ids.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

const configRule = (tool: string): ConfigGrantRule => ({
  tool,
  promotedFrom: {
    grantId: asGrantId("grant_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
    sessionId: newSessionId(),
    firstCall: { toolCallId: "t0", args: {} },
    promotedAt: 1,
  },
});

async function run(
  root: string,
  replies: Parameters<typeof createFakeStreamFn>[0]["replies"],
  configGrants: ConfigGrantRule[] = []
) {
  const bundle = buildRuntime({
    streamFn: createFakeStreamFn({ replies }),
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: configGrants.length === 0,
    provider: "fake",
    modelId: "fake",
    editMode: "replace",
    configGrants,
  });
  try {
    await bundle.adapter.run("做");
  } finally {
    await disposeRuntime(bundle);
  }
}

test("配置放权在场、没有审批通道：write_file 写 .pigeon 下的文件被拒，写普通文件照常", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-write-protected-"));
  try {
    mkdirSync(join(root, ".pigeon"));
    await run(
      root,
      [
        {
          text: "写",
          toolCalls: [
            { name: "write_file", args: { path: ".pigeon/new.json", content: "{}\n" } },
            { name: "write_file", args: { path: "plain.txt", content: "ok\n" } },
          ],
        },
        { text: "完" },
      ],
      [configRule("write_file")]
    );
    assert.equal(existsSync(join(root, ".pigeon", "new.json")), false);
    assert.equal(readFileSync(join(root, "plain.txt"), "utf8"), "ok\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
