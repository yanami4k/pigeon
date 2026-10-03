// 读档禁读名单与工作区外解析（决策 355），本机执行端：判定按符号链接解析后的真实路径；工作区内外一律生效；
// 设置追加项只能往内置名单上加。家目录注入临时目录，不碰真实的 ~。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { BUILTIN_READ_DENY, ReadDeniedError, readDenyList } from "./read-deny.ts";

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pigeon-read-deny-")));
  const home = join(base, "home");
  const ws = join(base, "ws");
  for (const dir of [
    join(home, ".ssh"),
    join(home, "extra"),
    join(base, "real-aws"),
    ws,
    join(base, "lib"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(home, ".ssh", "id_rsa"), "key");
  writeFileSync(join(home, "extra", "secret"), "s");
  writeFileSync(join(base, "real-aws", "credentials"), "aws");
  writeFileSync(join(base, "lib", "dep.js"), "dep");
  writeFileSync(join(ws, "a.txt"), "a");
  // ~/.aws 本身是符号链接：指向处同样禁读
  symlinkSync(join(base, "real-aws"), join(home, ".aws"), "junction");
  // 工作区里的符号链接指向禁读处
  symlinkSync(join(home, ".ssh"), join(ws, "keys"), "junction");
  return { base, home, ws, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("本机读档解析：工作区外标出并给真实路径；禁读名单按真实路径拒——直接命中、经工作区里的链接、禁读项本身是链接指向处", async () => {
  const { base, home, ws, cleanup } = layout();
  try {
    const host = createLocalWorkspaceHost(ws, { homeDir: home });
    const deny = readDenyList();
    assert.deepEqual(await host.resolveForRead?.("a.txt", deny), {
      path: join(ws, "a.txt"),
      outside: false,
    });
    assert.deepEqual(await host.resolveForRead?.(join(base, "lib", "dep.js"), deny), {
      path: join(base, "lib", "dep.js"),
      outside: true,
    });
    assert.deepEqual(await host.resolveForRead?.("../lib/dep.js", deny), {
      path: join(base, "lib", "dep.js"),
      outside: true,
    });
    for (const denied of [
      join(home, ".ssh", "id_rsa"),
      "keys/id_rsa",
      join(home, ".aws", "credentials"),
      join(base, "real-aws", "credentials"),
    ]) {
      await assert.rejects(host.resolveForRead?.(denied, deny) ?? Promise.resolve(), (error) => {
        assert.ok(error instanceof ReadDeniedError, `${denied} 应禁读`);
        return true;
      });
    }
    // 设置追加项生效；不追加时同一文件可读
    assert.equal((await host.resolveForRead?.(join(home, "extra", "secret"), deny))?.outside, true);
    await assert.rejects(
      host.resolveForRead?.(join(home, "extra", "secret"), readDenyList(["~/extra"])) ??
        Promise.resolve(),
      ReadDeniedError
    );
    // 追加只能加：内置项总在
    assert.deepEqual(readDenyList(["~/extra"]).slice(0, BUILTIN_READ_DENY.length), [
      ...BUILTIN_READ_DENY,
    ]);
  } finally {
    cleanup();
  }
});

test("工作区就是家目录：工作区内的禁读同样拒，grep/glob 用的禁读前缀给出相对工作区根的路径", async () => {
  const { home, cleanup } = layout();
  try {
    const host = createLocalWorkspaceHost(home, { homeDir: home });
    const deny = readDenyList();
    await assert.rejects(
      host.resolveForRead?.(".ssh/id_rsa", deny) ?? Promise.resolve(),
      ReadDeniedError
    );
    const within = (await host.readDenyWithin?.(deny)) ?? [];
    assert.ok(within.includes(".ssh"), within.join(","));
    assert.ok(within.includes(".aws"), within.join(","));
    assert.ok(!within.some((prefix) => prefix.startsWith("..")), within.join(","));
  } finally {
    cleanup();
  }
});
