// MCP prompts 与 roots 端到端（M5.7 S4，决策 043 / 054）：真实装配根 + 内存传输夹具 server + fake streamFn。
// 会话开始时 server 的 prompts 经 getPrompt 取正文进 Skill Catalog（需要参数的不登记并记问题）；load_skill 读取后
// 留 skill.loaded；run.started 的 Skill 清单含该 prompt；client 广告的 roots 是本会话工作区根。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createFixtureServer, type FixtureServer } from "../mcp/fixtures.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { sha256Hex } from "../state/message-content.ts";
import { startMcpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

test("MCP prompts 进 Skill Catalog 并可由 load_skill 读取留痕；需要参数的 prompt 不登记；roots 广告为工作区根", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-mcp-prompts-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(
      join(root, ".pigeon", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: { fx: { launch: { command: "node", args: ["x.js"] } } },
      })
    );
    const fixtures: FixtureServer[] = [];
    const mcp = await startMcpSession({
      governanceRoot: root,
      workspaceRoot: root,
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
    const session = materializeSession(join(root, ".pigeon", "sessions"), sessionId);
    assert.deepEqual(
      session.skillLoadeds.map((record) => record.payload),
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
    assert.deepEqual(session.runStarteds[0]?.payload.skills, [
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
