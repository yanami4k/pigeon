// 被拒收的图片（决策 417）经真实的会话存储：read_file 交出的图在请求被 400 拒收后换成占位、重试成功；会话续跑从记录恢复后，
// 第一次请求里这张图仍是占位，不会回来。
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { test } from "vitest";
import { createFakeStreamFn, type FakeReply, type FakeStreamFn } from "../pi-runtime/fixtures.ts";
import { registerModelAccess } from "../pi-runtime/model-access.ts";
import { newSessionId } from "../state/ids.ts";
import { emptySettingsSnapshot } from "../state/settings.ts";
import { noMcpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

// 合法的 3×2 PNG
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(2 * (1 + 3 * 4)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 能看图的假模型
function vision(replies: FakeReply[]): FakeStreamFn {
  const fake = createFakeStreamFn({ replies });
  registerModelAccess(fake, { declared: { input: ["text", "image"] } });
  return fake;
}

// 这次请求里 read_file 结果的形状
function readResult(fake: FakeStreamFn, call: number) {
  const message = fake.calls[call]?.context.messages.find(
    (entry) => entry.role === "toolResult" && entry.toolName === "read_file"
  );
  assert.ok(message?.role === "toolResult");
  return {
    image: message.content.some((block) => block.type === "image"),
    text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
  };
}

test("拒收的图换成占位写进会话记录：重试成功，续跑恢复后图不会回来", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-image-reject-")));
  writeFileSync(join(root, "a.png"), png());
  const sessionId = newSessionId();
  const open = (streamFn: FakeStreamFn, resume: boolean) =>
    openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn,
      flags: { yolo: true, provider: "fake", modelId: "fake", persistThinking: true },
      homeDir: root,
      startMcp: async () => noMcpSession(),
      settings: emptySettingsSnapshot(root),
      ...(resume ? { resume: true } : {}),
    });
  try {
    const first = vision([
      { text: "读图", toolCalls: [{ name: "read_file", args: { path: "a.png" } }] },
      { text: "", streamError: '400 {"type":"error","error":{"type":"invalid_request_error"}}' },
      { text: "看到了" },
    ]);
    const opened = await open(first, false);
    const result = await opened.bundle.adapter.run("看图");
    await disposeRuntime(opened.bundle);
    assert.equal(result.status, "completed");
    assert.equal(readResult(first, 1).image, true);
    assert.equal(readResult(first, 2).image, false);
    const second = vision([{ text: "好" }]);
    const resumed = await open(second, true);
    await resumed.bundle.adapter.run("继续");
    await disposeRuntime(resumed.bundle);
    const replayed = readResult(second, 0);
    assert.equal(replayed.image, false);
    assert.match(replayed.text, /a\.png[\s\S]*did not accept this image/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
