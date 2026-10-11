// read_file 认出图片与其他二进制（决策 414）：按文件头认 PNG、JPEG、GIF、WebP（扩展名不算数）；模型能看图且在上限以内时
// 交出图片内容并附一行元信息，否则只给元信息；其他二进制（开头有 NUL、认得的格式、非 UTF-8 编码）只给类型与大小，
// 不放解码出的乱码；这些读取同样记进读取记录。少量非法字节的文本照常按行读。
// 决策 416：超出单张上限的图片缩小后交出（保持原格式，只超字节的转 JPEG）；缩放库载入失败时退回只给元信息。
// 决策 417：交出前完整解码一遍，截断的图只给元信息；其他工具（MCP）结果里的图片块走同一道关口。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { Type } from "typebox";
import { test } from "vitest";
import { detectImage } from "./file-kind.ts";
import { IMAGE_MAX_BASE64_BYTES, IMAGE_MAX_EDGE, withImageGate } from "./image-gate.ts";
import { createPhotonPreparer, photonPreparer } from "./image-resize.ts";
import { createReadFileTool } from "./read-file.ts";
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

// 合法的 JPEG、WebP（由 photon 从 PNG 转码）与最小的 1×1 GIF
async function encoded(kind: "jpeg" | "webp", width: number, height: number): Promise<Buffer> {
  const mod = await import("@silvia-odwyer/photon-node");
  const lib = "PhotonImage" in mod ? mod : (mod as unknown as { default: typeof mod }).default;
  const image = lib.PhotonImage.new_from_byteslice(png(width, height));
  try {
    return Buffer.from(kind === "jpeg" ? image.get_bytes_jpeg(80) : image.get_bytes_webp());
  } finally {
    image.free();
  }
}
const GIF_1X1 = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
// 截掉后 40%：文件头与尺寸完好，像素数据不全
const truncated = (bytes: Buffer) => bytes.subarray(0, Math.floor(bytes.length * 0.6));

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

test("能看图：四种图片按文件头认出（扩展名不算数），交出图片内容并附一行尺寸与字节数；读取记进读取记录", async () => {
  const images: Array<[string, Buffer, string, string]> = [
    ["shot.dat", png(3, 2), "image/png", "3×2"],
    ["b.jpg", await encoded("jpeg", 64, 48), "image/jpeg", "64×48"],
    ["c.gif", GIF_1X1, "image/gif", "1×1"],
    ["d.webp", await encoded("webp", 17, 5), "image/webp", "17×5"],
  ];
  await withFiles(
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

test("截断的图在交出前被拦下只给元信息；图像库载入失败时同样只给元信息", () =>
  withFiles({ "cut.png": truncated(png(40, 30)), "ok.png": png(3, 2) }, async (root) => {
    const kinds = async (read: ReturnType<typeof createReadFileTool>, path: string) => {
      const blocks = blocksOf(await read.execute("r", { path }));
      return { types: blocks.map((block) => block.type), text: blocks[0]?.text ?? "" };
    };
    const cut = await kinds(createReadFileTool(root, { imageInput: true }), "cut.png");
    assert.deepEqual(cut.types, ["text"]);
    assert.match(cut.text, /40×30.*解不开/);
    const broken = createReadFileTool(root, {
      imageInput: true,
      prepareImage: createPhotonPreparer(() => Promise.reject(new Error("载入失败"))),
    });
    const ok = await kinds(broken, "ok.png");
    assert.deepEqual(ok.types, ["text"]);
    assert.match(ok.text, /3×2.*载入失败/);
  }));

test("其他工具结果里的图片块走同一道关口：好图照交、截断的换成一行说明、超限的缩小后交出，文字块不动", async () => {
  const good = png(3, 2);
  const tool = withImageGate(
    {
      name: "shot",
      label: "shot",
      description: "截图",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [
          { type: "text", text: "三张图" },
          { type: "image", data: good.toString("base64"), mimeType: "image/png" },
          { type: "image", data: truncated(png(40, 30)).toString("base64"), mimeType: "image/png" },
          {
            type: "image",
            data: png(IMAGE_MAX_EDGE + 400, 12).toString("base64"),
            mimeType: "image/png",
          },
        ],
        details: undefined,
      }),
    },
    photonPreparer
  );
  const content = blocksOf(await tool.execute("t", {}));
  assert.deepEqual(
    content.map((block) => block.type),
    ["text", "image", "text", "text", "image"]
  );
  assert.equal(content[1]?.data, good.toString("base64"));
  assert.match(content[2]?.text ?? "", /未交出.*解不开.*40×30/);
  assert.match(content[3]?.text ?? "", /2000×10/);
  assert.equal(detectImage(Buffer.from(content[4]?.data ?? "", "base64"))?.width, 2000);
});

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
