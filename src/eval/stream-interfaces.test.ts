import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { readTaskInterfaces } from "./stream-interfaces.ts";

test("接口数据文件（374）：按步号取出有内容的题，摘要为文件内容的摘要；清单摘要与本次清单不符即拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-interfaces-"));
  try {
    const file = join(dir, "task-interfaces.json");
    const module = { module: "strands.a", newModule: true, names: [] };
    writeFileSync(
      file,
      JSON.stringify({
        manifestDigest: "m1",
        tasks: [
          { seq: 3, interfaces: [module] },
          { seq: 5, interfaces: [] },
        ],
      })
    );
    const read = readTaskInterfaces(file, "m1");
    assert.deepEqual([...read.bySeq], [[3, [module]]]);
    assert.match(read.digest, /^[0-9a-f]{16}$/);
    writeFileSync(file, JSON.stringify({ manifestDigest: "m1", tasks: [] }));
    assert.notEqual(readTaskInterfaces(file, "m1").digest, read.digest);
    assert.throws(() => readTaskInterfaces(file, "m2"), /清单摘要.*不符/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
