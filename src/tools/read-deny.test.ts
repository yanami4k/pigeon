// 读档禁读名单与工作区外解析（决策 355），本机执行端：判定按符号链接解析后的真实路径；工作区内外一律生效；
// 设置追加项只能往内置名单上加；Windows 上的路径别名（大小写、8.3 短名、设备前缀、数据流）绕不过。家目录注入临时目录，
// 不碰真实的 ~。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";
import { createGrepTool } from "./grep.ts";
import { createLocalWorkspaceHost } from "./local-host.ts";
import {
  BUILTIN_READ_DENY,
  containedIn,
  deniedEntry,
  ReadDeniedError,
  readDenyList,
  UnsupportedPathFormError,
} from "./read-deny.ts";

function layout() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-read-deny-")));
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

test("工作区就是家目录：工作区内的禁读同样拒；grep、glob 的结果逐条按真实路径分类（可读、禁读、经链接落在工作区外）", async () => {
  const { base, home, cleanup } = layout();
  try {
    symlinkSync(join(base, "lib"), join(home, "libs"), "junction");
    writeFileSync(join(home, "notes.txt"), "n");
    const host = createLocalWorkspaceHost(home, { homeDir: home });
    const deny = readDenyList();
    await assert.rejects(
      host.resolveForRead?.(".ssh/id_rsa", deny) ?? Promise.resolve(),
      ReadDeniedError
    );
    const classes = await host.classifyReadPaths?.(
      ["notes.txt", ".ssh/id_rsa", ".aws/credentials", "libs/dep.js", "missing.txt"],
      deny
    );
    assert.deepEqual(Object.fromEntries(classes ?? []), {
      "notes.txt": "ok",
      ".ssh/id_rsa": "denied",
      ".aws/credentials": "denied",
      "libs/dep.js": "outside",
    });
  } finally {
    cleanup();
  }
});

test("不分大小写的平台：包含关系与禁读判定按不分大小写比较", () => {
  const rules = { p: path.posix, insensitive: true };
  const entries = [{ entry: "~/.ssh", paths: ["/home/u/.ssh"] }];
  assert.equal(deniedEntry("/home/u/.SSH/id_rsa", entries, rules), "~/.ssh");
  assert.equal(containedIn("/Work", "/work/a.txt", rules), true);
  // 区分大小写的平台照旧
  assert.equal(
    deniedEntry("/home/u/.SSH/id_rsa", entries, { ...rules, insensitive: false }),
    undefined
  );
});

// Windows 上的路径别名：大小写、8.3 短名、\\?\ 与 \\.\ 前缀、数据流；grep 的 path 与结果同样按真实路径判
const windowsOnly = process.platform === "win32" ? false : "只在 Windows 上有这些路径写法";

test("Windows：大小写、8.3 短名、设备前缀与数据流的写法都绕不过禁读名单；grep 的 path 与结果同样", {
  skip: windowsOnly,
}, async (t) => {
  const { home, cleanup } = layout();
  try {
    writeFileSync(join(home, "notes.txt"), "key here\n");
    const host = createLocalWorkspaceHost(home, { homeDir: home });
    const deny = readDenyList();
    const key = join(home, ".ssh", "id_rsa");
    const rejects = (input: string, kind: typeof ReadDeniedError) =>
      assert.rejects(host.resolveForRead?.(input, deny) ?? Promise.resolve(), kind, input);
    await rejects(join(home, ".SSH", "ID_RSA"), ReadDeniedError);
    await rejects(`\\\\?\\${key}`, UnsupportedPathFormError);
    await rejects(`\\\\.\\${key}`, UnsupportedPathFormError);
    await rejects(`//?/${key}`, UnsupportedPathFormError);
    await rejects(`${key}::$DATA`, UnsupportedPathFormError);
    await rejects(`${join(home, "notes.txt")}:hidden`, UnsupportedPathFormError);
    // 8.3 短名：卷上开着短名时才有
    const short = spawnSync(
      "cmd",
      ["/d", "/c", `for %I in ("${join(home, ".ssh")}") do @echo %~sI`],
      {
        encoding: "utf8",
        windowsVerbatimArguments: true,
      }
    ).stdout.trim();
    if (short !== "" && short.toLowerCase() !== join(home, ".ssh").toLowerCase()) {
      await rejects(join(short, "id_rsa"), ReadDeniedError);
    } else {
      t.diagnostic("本卷没有 8.3 短名，短名一项未测");
    }
    // grep：path 写成大小写别名即拒；搜整个家目录时 .ssh 下的结果逐条滤掉并计数
    const grep = createGrepTool(host, { maxResults: 50, bundledRipgrep: true });
    await assert.rejects(grep.execute("tc", { pattern: "key", path: ".SSH" }), ReadDeniedError);
    const all = await grep.execute("tc", { pattern: "key" });
    assert.equal(all.details.total, 1);
    assert.ok(all.details.deniedOmitted >= 1);
  } finally {
    cleanup();
  }
});
