// load_skill 读 MCP prompt（M5.7 S4，决策 043 口径）：只认会话开始时登记的 prompt；读取时经 getPrompt 重取正文，
// 与会话开始时的哈希不符即拒绝（下个会话生效）；单次大小上限可见截断；没有资源文件；每次成功读取的摘要作工具结果 details。
// server 不可用时的环境错误原样上抛，不改写成域错误。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { SkillLoadedPayload } from "../state/runtime-events.ts";
import { loadSkillCatalog } from "./catalog.ts";
import { createLoadSkillTool, LoadSkillError } from "./load-skill-tool.ts";

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

// 收集每次成功读取的摘要：读取摘要随工具结果的 details 返回（读取失败即抛错，不产生摘要）
function recording(tool: ReturnType<typeof createLoadSkillTool>): {
  tool: ReturnType<typeof createLoadSkillTool>;
  loaded: SkillLoadedPayload[];
} {
  const loaded: SkillLoadedPayload[] = [];
  return {
    loaded,
    tool: {
      ...tool,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        const result = await tool.execute(...args);
        loaded.push(result.details);
        return result;
      },
    },
  };
}

function withCatalog(
  text: string,
  load: () => Promise<string>,
  run: (catalog: ReturnType<typeof loadSkillCatalog>) => Promise<void>
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "pigeon-load-skill-mcp-"));
  const catalog = loadSkillCatalog({
    workspaceRoot: join(base, "workspace"),
    homeDir: join(base, "home"),
    prompts: [
      { name: "mcp__fx__greet", description: "打招呼", server: "fx", prompt: "greet", text, load },
    ],
  });
  return run(catalog).finally(() => rmSync(base, { recursive: true, force: true }));
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

test("load_skill 读 MCP prompt：重取正文、details 带读取摘要；正文与会话开始时不符拒绝；不接受资源参数", async () => {
  const text = "你好，Pigeon";
  let calls = 0;
  await withCatalog(
    text,
    async () => {
      calls += 1;
      return text;
    },
    async (catalog) => {
      const { tool, loaded } = recording(createLoadSkillTool({ catalog }));
      const result = await tool.execute("call-1", { name: "mcp__fx__greet" });
      assert.equal(calls, 1);
      const output = textOf(result);
      assert.ok(output.includes(text), output);
      assert.ok(output.includes("MCP server fx 的 prompt greet"), output);
      assert.deepEqual(loaded, [
        {
          name: "mcp__fx__greet",
          resourcePath: "prompt",
          hash: sha256(text),
          bytes: Buffer.byteLength(text),
          truncated: false,
        },
      ]);
      await assert.rejects(
        tool.execute("call-2", { name: "mcp__fx__greet", resource: "references/x.md" }),
        LoadSkillError
      );
      assert.equal(loaded.length, 1);
    }
  );
  await withCatalog(
    text,
    async () => "server 改过的正文",
    async (catalog) => {
      const tool = createLoadSkillTool({ catalog });
      await assert.rejects(
        tool.execute("call-3", { name: "mcp__fx__greet" }),
        (error: unknown) => error instanceof LoadSkillError && /下个会话生效/.test(error.message)
      );
    }
  );
});

test("load_skill 读 MCP prompt：超上限可见截断，哈希按全文；server 不可用的错误原样上抛", async () => {
  const text = "字".repeat(40);
  await withCatalog(
    text,
    async () => text,
    async (catalog) => {
      const { tool, loaded } = recording(createLoadSkillTool({ catalog, maxBytes: 30 }));
      const output = textOf(await tool.execute("call-1", { name: "mcp__fx__greet" }));
      assert.ok(output.includes("已截断"), output);
      assert.equal(loaded[0]?.truncated, true);
      assert.equal(loaded[0]?.hash, sha256(text));
    }
  );
  const unavailable = Object.assign(new Error("MCP server fx 不可用：掉线"), {
    pigeonToolErrorKind: "environment",
  });
  await withCatalog(
    "正文",
    async () => {
      throw unavailable;
    },
    async (catalog) => {
      const tool = createLoadSkillTool({ catalog });
      await assert.rejects(tool.execute("call-2", { name: "mcp__fx__greet" }), (error: unknown) => {
        return error === unavailable;
      });
    }
  );
});
