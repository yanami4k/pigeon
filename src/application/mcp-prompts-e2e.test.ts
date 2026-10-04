// MCP prompts 与 roots 端到端（M5.7 S4，决策 043 / 054）：真实装配根 + 内存传输夹具 server + fake streamFn。
// 会话开始时 server 的 prompts 经 getPrompt 取正文进 Skill Catalog（需要参数的不登记并记问题）；load_skill 读取后
// 读取摘要随工具结果的 details 记进会话存储；Run 开始条目的 Skill 清单含该 prompt；client 广告的 roots 是本会话工作区根。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { createFixtureServer, type FixtureServer } from "../mcp/fixtures.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { sha256Hex } from "../state/hashing.ts";
import { newSessionId } from "../state/ids.ts";
import { mergeMcpConfig } from "../state/mcp-config.ts";
import { TOOL_RESULT_MARK_KEY } from "../state/session-judge.ts";
import { startMcpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

test("MCP prompts 进 Skill Catalog 并可由 load_skill 读取留痕；需要参数的 prompt 不登记；roots 广告为工作区根", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-mcp-prompts-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    // 决策 325：server 定义在项目共享设置的 mcp 一节
    const mcpSection = { servers: { fx: { launch: { command: "node", args: ["x.js"] } } } };
    writeFileSync(join(root, ".pigeon", "settings.json"), JSON.stringify({ mcp: mcpSection }));
    const fixtures: FixtureServer[] = [];
    const mcp = await startMcpSession({
      governanceRoot: root,
      workspaceRoot: root,
      config: mergeMcpConfig(undefined, mcpSection).config,
      createTransport: () => {
        const { fixture, clientTransport } = createFixtureServer({
          tools: [],
          prompts: [
            { name: "greet", description: "打招呼", text: "你好，Pigeon" },
            {
              name: "needs",
              description: "要参数",
              text: "不会被取",
              arguments: [{ name: "topic", required: true }],
            },
          ],
        });
        fixtures.push(fixture);
        return clientTransport;
      },
    });
    assert.deepEqual(
      mcp.prompts.map((prompt) => [
        prompt.name,
        prompt.description,
        prompt.server,
        prompt.prompt,
        prompt.text,
      ]),
      [["mcp__fx__greet", "打招呼", "fx", "greet", "你好，Pigeon"]]
    );
    assert.ok(
      mcp.problems.some((problem) => problem.includes("needs") && problem.includes("参数")),
      JSON.stringify(mcp.problems)
    );
    assert.deepEqual(await fixtures[0]?.listRoots(), {
      roots: [{ uri: pathToFileURL(root).href, name: basename(root) }],
    });

    const sessionId = newSessionId();
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "读 prompt",
            toolCalls: [{ name: "load_skill", args: { name: "mcp__fx__greet" } }],
          },
          { text: "完成" },
        ],
      }),
      workspaceRoot: root,
      homeDir: root,
      sessionId,
      yolo: false,
      provider: "fake-provider",
      modelId: "fake-model-1",
      mcp,
      createApprovalHandler: () => async () => ({ approved: true }),
    });
    try {
      const result = await bundle.adapter.run("用 prompt");
      assert.ok(result.advertisedTools.includes("load_skill"));
    } finally {
      await disposeRuntime(bundle);
    }
    const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
    assert.ok(loaded !== undefined, "会话存储里应有本会话");
    const run = loaded.view.runs[0];
    // 读取摘要：load_skill 工具结果的 details（去掉运行面挂的审批闸标记）
    const loads = (run?.messages ?? [])
      .map((ref) => ref.message)
      .filter((message) => message.role === "toolResult" && message.toolName === "load_skill");
    assert.deepEqual(
      loads.map((message) => {
        assert.equal(message.isError, false);
        const { [TOOL_RESULT_MARK_KEY]: _mark, ...summary } = (message.details ?? {}) as Record<
          string,
          unknown
        >;
        return summary;
      }),
      [
        {
          name: "mcp__fx__greet",
          resourcePath: "prompt",
          hash: sha256Hex("你好，Pigeon"),
          bytes: Buffer.byteLength("你好，Pigeon"),
          truncated: false,
        },
      ]
    );
    assert.deepEqual(run?.start.skills, [
      {
        name: "mcp__fx__greet",
        path: "mcp:fx/greet",
        files: [
          {
            path: "prompt",
            hash: sha256Hex("你好，Pigeon"),
            bytes: Buffer.byteLength("你好，Pigeon"),
          },
        ],
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
