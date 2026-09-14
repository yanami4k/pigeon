// MCP 配置读取（M5.7 S1，决策 051）：.mcp.json 给 server 启动定义，.pigeon/mcp.json 给风险档覆盖
// （无 .mcp.json 时也可直接定义 server）；两份合并冲突以 .pigeon/mcp.json 为准；未列出的工具落
// defaultTier（缺省 write）；畸形一律响亮失败。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveMcpToolTier } from "../state/mcp-config.ts";
import {
  dotMcpJsonPath,
  loadMcpConfig,
  McpConfigError,
  pigeonMcpConfigPath,
} from "./mcp-config.ts";

interface Files {
  dotMcp?: string;
  pigeon?: string;
}

function withFiles(files: Files, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pigeon-mcp-config-"));
  try {
    if (files.dotMcp !== undefined) {
      writeFileSync(dotMcpJsonPath(root), files.dotMcp);
    }
    if (files.pigeon !== undefined) {
      mkdirSync(join(root, ".pigeon"), { recursive: true });
      writeFileSync(pigeonMcpConfigPath(root), files.pigeon);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function serverNamed(root: string, name: string) {
  const server = loadMcpConfig(root).servers.find((candidate) => candidate.name === name);
  assert.ok(server, `缺少 server ${name}`);
  return server;
}

test("MCP 配置：两份都缺失 = 没有 server（合法）", () => {
  withFiles({}, (root) => {
    assert.deepEqual(loadMcpConfig(root), { servers: [] });
  });
});

test("MCP 配置：只有 .mcp.json——stdio 与 http 两种启动定义按名载入，来源记 .mcp.json", () => {
  withFiles(
    {
      dotMcp: JSON.stringify({
        mcpServers: {
          everything: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-everything"],
            env: { LOG: "1" },
          },
          remote: { type: "http", url: "http://127.0.0.1:9000/mcp" },
        },
      }),
    },
    (root) => {
      const config = loadMcpConfig(root);
      assert.deepEqual(
        config.servers.map((server) => server.name),
        ["everything", "remote"]
      );
      const everything = serverNamed(root, "everything");
      assert.deepEqual(everything.launch, {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        env: { LOG: "1" },
      });
      assert.equal(everything.launchSource, ".mcp.json");
      assert.deepEqual(everything.tools, {});
      const remote = serverNamed(root, "remote");
      assert.deepEqual(remote.launch, { type: "http", url: "http://127.0.0.1:9000/mcp" });
    }
  );
});

test("MCP 配置：只有 .pigeon/mcp.json——直接定义 server 与逐工具风险档、read 工具带路径约束", () => {
  withFiles(
    {
      pigeon: JSON.stringify({
        version: 1,
        servers: {
          fs: {
            launch: { command: "node", args: ["server.js", "."] },
            defaultTier: "exec",
            tools: {
              read_text_file: { tier: "read", pathConfinement: { kind: "workspace" } },
              write_file: { tier: "write" },
            },
          },
        },
      }),
    },
    (root) => {
      const fs = serverNamed(root, "fs");
      assert.deepEqual(fs.launch, { command: "node", args: ["server.js", "."] });
      assert.equal(fs.launchSource, ".pigeon/mcp.json");
      assert.equal(fs.defaultTier, "exec");
      assert.deepEqual(resolveMcpToolTier(fs, "read_text_file"), {
        tier: "read",
        pathConfinement: { kind: "workspace" },
        configured: true,
      });
      assert.deepEqual(resolveMcpToolTier(fs, "write_file"), { tier: "write", configured: true });
    }
  );
});

test("MCP 配置：两份合并——同名启动定义冲突以 .pigeon/mcp.json 为准；只给风险档覆盖时沿用 .mcp.json 的启动定义", () => {
  withFiles(
    {
      dotMcp: JSON.stringify({
        mcpServers: {
          everything: { command: "npx", args: ["server-everything"] },
          fs: { command: "npx", args: ["server-filesystem", "."] },
        },
      }),
      pigeon: JSON.stringify({
        version: 1,
        servers: {
          everything: { launch: { command: "node", args: ["local-everything.js"] } },
          fs: { tools: { write_file: { tier: "write" }, read_text_file: { tier: "read" } } },
        },
      }),
    },
    (root) => {
      const everything = serverNamed(root, "everything");
      assert.deepEqual(everything.launch, { command: "node", args: ["local-everything.js"] });
      assert.equal(everything.launchSource, ".pigeon/mcp.json");
      const fs = serverNamed(root, "fs");
      assert.deepEqual(fs.launch, { command: "npx", args: ["server-filesystem", "."] });
      assert.equal(fs.launchSource, ".mcp.json");
      assert.deepEqual(resolveMcpToolTier(fs, "read_text_file"), {
        tier: "read",
        configured: true,
      });
    }
  );
});

test("MCP 配置：未列出的工具落 defaultTier——缺省 write，显式 defaultTier 生效", () => {
  withFiles(
    {
      dotMcp: JSON.stringify({ mcpServers: { plain: { command: "node", args: ["a.js"] } } }),
      pigeon: JSON.stringify({
        version: 1,
        servers: {
          lax: { launch: { command: "node", args: ["b.js"] }, defaultTier: "read" },
          listed: {
            launch: { command: "node", args: ["c.js"] },
            tools: { echo: { tier: "read" } },
          },
        },
      }),
    },
    (root) => {
      assert.deepEqual(resolveMcpToolTier(serverNamed(root, "plain"), "anything"), {
        tier: "write",
        configured: false,
      });
      assert.deepEqual(resolveMcpToolTier(serverNamed(root, "listed"), "unlisted"), {
        tier: "write",
        configured: false,
      });
      assert.deepEqual(resolveMcpToolTier(serverNamed(root, "lax"), "anything"), {
        tier: "read",
        configured: false,
      });
    }
  );
});

test("MCP 配置：畸形与语义不明一律响亮失败", () => {
  const launch = { command: "node", args: ["x.js"] };
  const cases: Files[] = [
    { dotMcp: "{ not json" },
    { pigeon: "{ not json" },
    { dotMcp: JSON.stringify({ servers: {} }) },
    { dotMcp: JSON.stringify({ mcpServers: { a: { type: "sse", url: "http://x" } } }) },
    { dotMcp: JSON.stringify({ mcpServers: { a: { args: ["no-command"] } } }) },
    { pigeon: JSON.stringify({ version: 2, servers: {} }) },
    { pigeon: JSON.stringify({ version: 1, servers: { a: { defaultTier: "admin", launch } } }) },
    // .pigeon 里的 server 没有启动定义、.mcp.json 也没有同名 server
    { pigeon: JSON.stringify({ version: 1, servers: { ghost: { defaultTier: "read" } } }) },
    // 路径约束只属于 read 工具
    {
      pigeon: JSON.stringify({
        version: 1,
        servers: {
          a: { launch, tools: { w: { tier: "write", pathConfinement: { kind: "workspace" } } } },
        },
      }),
    },
    // server 名要能嵌进工具名前缀
    { dotMcp: JSON.stringify({ mcpServers: { "bad name!": launch } }) },
  ];
  for (const files of cases) {
    withFiles(files, (root) => {
      assert.throws(() => loadMcpConfig(root), McpConfigError, JSON.stringify(files));
    });
  }
});
