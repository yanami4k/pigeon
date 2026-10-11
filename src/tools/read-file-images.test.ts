// read_file 认出图片与其他二进制（决策 414）：按文件头认 PNG、JPEG、GIF、WebP（扩展名不算数）；模型能看图且在上限以内时
// 交出图片内容并附一行元信息，否则只给元信息；其他二进制（开头有 NUL、认得的格式、非 UTF-8 编码）只给类型与大小，
// 不放解码出的乱码；这些读取同样记进读取记录。少量非法字节的文本照常按行读。
// 决策 416：超出单张上限的图片缩小后交出（保持原格式，只超字节的转 JPEG）；缩放库载入失败时退回只给元信息。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { test } from "vitest";
import { detectImage } from "./file-kind.ts";
import { createPhotonResizer } from "./image-resize.ts";
import { createReadFileTool, IMAGE_MAX_BASE64_BYTES, IMAGE_MAX_EDGE } from "./read-file.ts";
import { FileReadTracker } from "./read-tracker.ts";

// 合法的最小 PNG（全透明，RGBA）；padTo 给出时在末尾补零到这么多字节（只用来撑大体积）
function png(width: number, height: number, padTo = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const pixels = deflateSync(Buffer.alloc(height * (1 + width * 4)));
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return padTo > file.length ? Buffer.concat([file, Buffer.alloc(padTo - file.length)]) : file;
}

// 其余三种只含读尺寸所需的文件头结构（不经解码器）
function jpeg(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, ...Array(9).fill(1), 0xff, 0xd9]);
}
function gif(width: number, height: number): Buffer {
  const out = Buffer.from("GIF89a\0\0\0\0\0\0\0;", "latin1");
  out.writeUInt16LE(width, 6);
  out.writeUInt16LE(height, 8);
  return out;
}
function webp(width: number, height: number): Buffer {
  const out = Buffer.alloc(30);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(22, 4);
  out.write("WEBPVP8L", 8, "latin1");
  out.writeUInt32LE(5, 16);
  out[20] = 0x2f;
  out.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return out;
}

function withFiles(
  files: Record<string, Buffer | string>,
  body: (root: string) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-read-images-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };
const blocksOf = (result: { content: readonly Block[] }) => result.content;

test("能看图：四种图片按文件头认出（扩展名不算数），交出图片内容并附一行尺寸与字节数；读取记进读取记录", () => {
  const images: Array<[string, Buffer, string, string]> = [
    ["shot.dat", png(3, 2), "image/png", "3×2"],
    ["b.jpg", jpeg(640, 480), "image/jpeg", "640×480"],
    ["c.gif", gif(7, 9), "image/gif", "7×9"],
    ["d.webp", webp(17, 5), "image/webp", "17×5"],
  ];
  return withFiles(
    Object.fromEntries(images.map(([name, bytes]) => [name, bytes])),
    async (root) => {
      const reads = new FileReadTracker();
      const read = createReadFileTool(root, { imageInput: true, reads });
      assert.match(read.description, /PNG.*WebP/);
      for (const [name, bytes, mimeType, dims] of images) {
        const result = await read.execute("r", { path: name });
        const [head, image] = blocksOf(result);
        assert.match(head?.text ?? "", new RegExp(`${name}.*${dims}.*${bytes.length} 字节`));
        assert.deepEqual(image, { type: "image", data: bytes.toString("base64"), mimeType });
        assert.equal(reads.unchangedSinceRead(join(root, name), bytes), true, name);
      }
    }
  );
});

test("不能看图：图片只给元信息；其他二进制（开头有 NUL、认得的格式、非 UTF-8 编码）只给类型与大小，不放乱码，同样记进读取记录", () => {
  const gbk = Buffer.from(Array(200).fill([0xc4, 0xe3, 0xba, 0xc3]).flat());
  const files = {
    "a.png": png(3, 2),
    "x.bin": Buffer.from([0x7b, 0x00, 0x01, 0x02, 0x22, 0x10, 0x00, 0x41]),
    "doc.pdf": `%PDF-1.7\n${"stream text ".repeat(50)}`,
    "gbk.txt": gbk,
  };
  return withFiles(files, async (root) => {
    const reads = new FileReadTracker();
    const read = createReadFileTool(root, { reads });
    assert.doesNotMatch(read.description, /PNG|图片/);
    const image = blocksOf(await read.execute("r", { path: "a.png" }));
    assert.equal(image.length, 1);
    assert.match(image[0]?.text ?? "", /3×2/);
    for (const [name, pattern] of [
      ["x.bin", /二进制/],
      ["doc.pdf", /PDF/],
      ["gbk.txt", /UTF-8.*iconv/],
    ] as const) {
      const result = await read.execute("r", { path: name });
      const [only, ...rest] = blocksOf(result);
      assert.equal(rest.length, 0);
      assert.match(only?.text ?? "", pattern);
      assert.doesNotMatch(only?.text ?? "", /�|stream text|\d+#/, name);
      assert.equal(reads.hasRead(join(root, name)), true, name);
    }
    assert.equal(reads.hasRead(join(root, "a.png")), true);
  });
});

test("超出单张上限的图片缩小后交出：长边超的缩到上限内并保持格式，只超字节的转 JPEG；恰在上限上的原样交出", () =>
  withFiles(
    {
      "edge.png": png(IMAGE_MAX_EDGE, 1),
      "wide.png": png(IMAGE_MAX_EDGE + 400, 12),
      "heavy.png": png(4, 4, Math.floor((IMAGE_MAX_BASE64_BYTES / 4) * 3) + 1),
    },
    async (root) => {
      const read = createReadFileTool(root, { imageInput: true });
      const sent = async (path: string) => {
        const [head, image] = blocksOf(await read.execute("r", { path }));
        assert.equal(image?.type, "image", path);
        const bytes = Buffer.from(image?.data ?? "", "base64");
        return { head: head?.text ?? "", bytes, info: detectImage(bytes) };
      };
      const edge = await sent("edge.png");
      assert.deepEqual(edge.bytes, png(IMAGE_MAX_EDGE, 1));
      const wide = await sent("wide.png");
      assert.deepEqual(wide.info, {
        mimeType: "image/png",
        format: "PNG",
        width: 2000,
        height: 10,
      });
      assert.match(wide.head, /2400×12.*2000×10/);
      const heavy = await sent("heavy.png");
      assert.equal(heavy.info?.mimeType, "image/jpeg");
      assert.ok(heavy.bytes.length < IMAGE_MAX_BASE64_BYTES);
    }
  ));

test("缩放库载入失败时退回只给元信息", () =>
  withFiles({ "wide.png": png(IMAGE_MAX_EDGE + 1, 1) }, async (root) => {
    const read = createReadFileTool(root, {
      imageInput: true,
      resizeImage: createPhotonResizer(() => Promise.reject(new Error("载入失败"))),
    });
    const blocks = blocksOf(await read.execute("r", { path: "wide.png" }));
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["text"]
    );
    assert.match(blocks[0]?.text ?? "", /2001×1.*缩小未成功/);
  }));

test("少量非法字节的文本照常按行读（带锚点、分页不变）", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
  return withFiles(
    {
      "mostly.txt": Buffer.concat([
        Buffer.from("caf"),
        Buffer.from([0xe9]),
        Buffer.from(`\n${lines}\n`),
      ]),
    },
    async (root) => {
      const text = blocksOf(await createReadFileTool(root).execute("r", { path: "mostly.txt" }))[0]
        ?.text;
      assert.match(text ?? "", /共 201 行/);
      assert.match(text ?? "", /^201#\w+\| line 200$/m);
    }
  );
});
