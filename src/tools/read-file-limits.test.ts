// read_file 的安全上限（决策 357）：单次正文到字节上限即停，给出续读的 offset，接着读能读完；超长行截断并注明原长，
// 其余行照常；没碰到上限的读取与原来一样（全部行、无续读提示）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReadFileTool } from "./read-file.ts";

function withFile(content: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-read-limits-"));
  writeFileSync(join(root, "f.txt"), content);
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const textOf = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? "").join("");

test("到字节上限即停并给出续读的 offset；按提示接着读，全部行恰好各读到一次", () =>
  withFile(
    Array.from({ length: 300 }, (_, i) => `${i + 1}:${"x".repeat(95)}`).join("\n"),
    async (root) => {
      const read = createReadFileTool(root, {
        editMode: "replace",
        limits: { maxBytes: 10_000, maxLineChars: 2000 },
      });
      const seen: number[] = [];
      let offset: number | undefined = 1;
      while (offset !== undefined) {
        const text = textOf(await read.execute("r", { path: "f.txt", offset }));
        assert.ok(Buffer.byteLength(text) < 10_000 + 500, "单次正文不超过上限（加头尾一行）");
        seen.push(...[...text.matchAll(/^(\d+)\| /gm)].map((m) => Number(m[1])));
        const next = /offset=(\d+)/.exec(text)?.[1];
        offset = next !== undefined ? Number(next) : undefined;
      }
      assert.deepEqual(
        seen,
        Array.from({ length: 300 }, (_, i) => i + 1)
      );
    }
  ));

test("超长行截断显示并注明原长，其余行照常；没碰到上限的读取给出全部行、没有续读提示", () =>
  withFile(`short\n${"y".repeat(5000)}\nend\n`, async (root) => {
    const read = createReadFileTool(root, { editMode: "replace" });
    const text = textOf(await read.execute("r", { path: "f.txt" }));
    assert.match(text, /^1\| short$/m);
    assert.match(text, new RegExp(`^2\\| ${"y".repeat(2000)}…（本行共 5000 字符`, "m"));
    assert.doesNotMatch(text, new RegExp("y".repeat(2001)));
    assert.match(text, /^3\| end$/m);
    assert.doesNotMatch(text, /offset=/);
  }));
