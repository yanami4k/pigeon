// 决策 339 ⑥：会话检索的缓存——命中缓存时不读会话文件；会话文件大小或修改时间变了即重抽；格式版本不符即重建；
// 缓存损坏时丢弃重建、不报错中断；写缓存原子写入，多个进程并发检索同一批会话时缓存不损坏；缓存目录不可写时检索照常；
// 会话文件已不在的缓存与崩溃留下的旧临时文件被清理；目录信息里存父会话。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import {
  createFixtureSession,
  type FixtureSession,
  spawnFixtureWorker,
} from "../application/session-store-fixtures.ts";
import { asSessionId, type SessionId } from "../state/ids.ts";
import { listSessionRefs, readSessionView } from "./session-catalog.ts";
import type { SessionFileRef } from "./session-reader.ts";
import {
  createSessionSearchSource,
  pruneSessionSearchCache,
  SESSION_SEARCH_CACHE_VERSION,
  STALE_TEMP_MS,
} from "./session-search-cache.ts";

const SESSION = asSessionId("sess_01JAAAAAA30000000000000000");

interface Dirs {
  sessionsDir: string;
  cacheDir: string;
  root: string;
}

function withDirs(run: (dirs: Dirs) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-cache-"));
  return run({
    root,
    sessionsDir: join(root, ".pigeon", "state", "sessions"),
    cacheDir: join(root, ".pigeon", "state", "search-cache"),
  }).finally(() => rmSync(root, { recursive: true, force: true }));
}

async function seed(
  sessionsDir: string,
  write: (session: FixtureSession) => void,
  sessionId: SessionId = SESSION
): Promise<string> {
  const session = createFixtureSession({ sessionsDir, sessionId });
  write(session);
  return (await session.close()).path;
}

// 计数的读取函数：每读一次会话文件加一
function countingSource(cacheDir: string) {
  const reads: string[] = [];
  const source = createSessionSearchSource({
    cacheDir,
    readView: (ref: SessionFileRef) => {
      reads.push(ref.sessionId);
      return readSessionView(ref);
    },
  });
  return { source, reads };
}

function onlyRef(sessionsDir: string): SessionFileRef {
  const [ref] = listSessionRefs(sessionsDir);
  assert.ok(ref !== undefined);
  return ref;
}

const texts = (docs: readonly { text: string }[] | undefined) => (docs ?? []).map((d) => d.text);

test("命中缓存时不读会话文件：第二次起正文与工具输出都取自缓存；正文与工具输出分两份存放", () =>
  withDirs(async ({ sessionsDir, cacheDir }) => {
    await seed(sessionsDir, (s) => {
      s.startRun({ task: "部署网关" });
      s.toolTurn({ name: "run_command", result: "部署日志" });
      s.endRun();
    });
    const ref = onlyRef(sessionsDir);
    const first = countingSource(cacheDir);
    const extracted = first.source.load(ref, { toolOutput: true });
    assert.deepEqual(texts(extracted?.conversation), ["部署网关"]);
    assert.deepEqual(texts(extracted?.toolOutput), ["部署日志"]);
    assert.deepEqual(first.reads, [SESSION]);
    assert.deepEqual(readdirSync(cacheDir).sort(), [`${SESSION}.json`, `${SESSION}.tools.json`]);

    // 新的来源对象（如另一次检索）：只读缓存
    const second = countingSource(cacheDir);
    const conversationOnly = second.source.load(ref, { toolOutput: false });
    assert.equal(conversationOnly?.toolOutput, undefined);
    assert.deepEqual(texts(conversationOnly?.conversation), ["部署网关"]);
    assert.deepEqual(texts(second.source.load(ref, { toolOutput: true })?.toolOutput), [
      "部署日志",
    ]);
    assert.deepEqual(second.reads, []);
    assert.equal(conversationOnly?.info.sessionId, SESSION);
  }));

test("会话文件大小或修改时间变了即重抽：只改修改时间也重抽；追加内容后取到新内容", () =>
  withDirs(async ({ sessionsDir, cacheDir }) => {
    const path = await seed(sessionsDir, (s) => {
      s.startRun({ task: "第一句" });
      s.endRun();
    });
    const ref = onlyRef(sessionsDir);
    countingSource(cacheDir).source.load(ref, { toolOutput: false });

    // 大小不变、修改时间变了
    const stat = statSync(path);
    utimesSync(path, stat.atime, new Date(stat.mtimeMs + 5_000));
    const touched = countingSource(cacheDir);
    touched.source.load(ref, { toolOutput: false });
    assert.deepEqual(touched.reads, [SESSION]);
    const again = countingSource(cacheDir);
    again.source.load(ref, { toolOutput: false });
    assert.deepEqual(again.reads, []);

    // 追加内容：大小变了，取到新内容（修改时间钉回原值，只让大小不同）
    const before = statSync(path);
    const appended = createFixtureSession({ sessionsDir, sessionId: SESSION, existingPath: path });
    appended.startRun({ task: "第二句" });
    appended.endRun();
    await appended.close();
    utimesSync(path, before.atime, before.mtime);
    const grown = countingSource(cacheDir);
    const entry = grown.source.load(ref, { toolOutput: false });
    assert.deepEqual(grown.reads, [SESSION]);
    assert.deepEqual(texts(entry?.conversation), ["第一句", "第二句"]);
  }));

test("缓存格式版本不符即重建：读会话文件重抽并写回当前版本", () =>
  withDirs(async ({ sessionsDir, cacheDir }) => {
    await seed(sessionsDir, (s) => {
      s.startRun({ task: "版本" });
      s.endRun();
    });
    const ref = onlyRef(sessionsDir);
    countingSource(cacheDir).source.load(ref, { toolOutput: true });
    for (const name of [`${SESSION}.json`, `${SESSION}.tools.json`]) {
      const file = join(cacheDir, name);
      const value = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...value, version: SESSION_SEARCH_CACHE_VERSION + 1 }));
    }
    const stale = countingSource(cacheDir);
    assert.deepEqual(texts(stale.source.load(ref, { toolOutput: false })?.conversation), ["版本"]);
    assert.deepEqual(stale.reads, [SESSION]);
    for (const name of [`${SESSION}.json`, `${SESSION}.tools.json`]) {
      assert.equal(
        JSON.parse(readFileSync(join(cacheDir, name), "utf8")).version,
        SESSION_SEARCH_CACHE_VERSION
      );
    }
  }));

test("缓存损坏时丢弃重建、不报错：不是 JSON、形状不对、只坏了工具输出那一份", () =>
  withDirs(async ({ sessionsDir, cacheDir }) => {
    await seed(sessionsDir, (s) => {
      s.startRun({ task: "损坏" });
      s.toolTurn({ name: "run_command", result: "输出" });
      s.endRun();
    });
    const ref = onlyRef(sessionsDir);
    countingSource(cacheDir).source.load(ref, { toolOutput: true });
    const main = join(cacheDir, `${SESSION}.json`);
    const tools = join(cacheDir, `${SESSION}.tools.json`);

    writeFileSync(main, '{"version":1,"source":');
    const broken = countingSource(cacheDir);
    assert.deepEqual(texts(broken.source.load(ref, { toolOutput: false })?.conversation), ["损坏"]);
    assert.deepEqual(broken.reads, [SESSION]);
    assert.doesNotThrow(() => JSON.parse(readFileSync(main, "utf8")));

    const valid = JSON.parse(readFileSync(main, "utf8"));
    writeFileSync(main, JSON.stringify({ ...valid, conversation: [{ text: 1 }] }));
    const misshapen = countingSource(cacheDir);
    assert.deepEqual(texts(misshapen.source.load(ref, { toolOutput: false })?.conversation), [
      "损坏",
    ]);
    assert.deepEqual(misshapen.reads, [SESSION]);

    writeFileSync(tools, "not json");
    const toolsBroken = countingSource(cacheDir);
    assert.deepEqual(texts(toolsBroken.source.load(ref, { toolOutput: false })?.conversation), [
      "损坏",
    ]);
    assert.deepEqual(toolsBroken.reads, [], "不要工具输出时不看那一份");
    assert.deepEqual(texts(toolsBroken.source.load(ref, { toolOutput: true })?.toolOutput), [
      "输出",
    ]);
    assert.deepEqual(toolsBroken.reads, [SESSION]);
  }));

test("缓存目录不可写：检索照常返回，只是不落缓存", () =>
  withDirs(async ({ sessionsDir, root }) => {
    await seed(sessionsDir, (s) => {
      s.startRun({ task: "照常" });
      s.endRun();
    });
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "");
    const { source } = countingSource(join(blocker, "cache"));
    assert.deepEqual(texts(source.load(onlyRef(sessionsDir), { toolOutput: true })?.conversation), [
      "照常",
    ]);
  }));

test("并发写不损坏：多个进程同时对同一批会话首次检索，缓存文件都完整可用，不留临时文件", () =>
  withDirs(async ({ sessionsDir, cacheDir, root }) => {
    const ids: SessionId[] = [];
    for (let index = 0; index < 6; index++) {
      const id = asSessionId(`sess_01JAAAAAA${index}0000000000000000`);
      ids.push(id);
      await seed(
        sessionsDir,
        (s) => {
          s.startRun({ task: `会话 ${index} ${"正文".repeat(2_000)}` });
          s.toolTurn({ name: "run_command", result: "输出".repeat(5_000) });
          s.endRun();
        },
        id
      );
    }
    const script = join(root, "load-all.ts");
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "session-search-cache.ts")).href;
    const catalogUrl = pathToFileURL(join(import.meta.dirname, "session-catalog.ts")).href;
    writeFileSync(
      script,
      [
        `import { createSessionSearchSource } from ${JSON.stringify(moduleUrl)};`,
        `import { listSessionRefs } from ${JSON.stringify(catalogUrl)};`,
        "const [sessionsDir, cacheDir] = process.argv.slice(2);",
        "for (let round = 0; round < 5; round++) {",
        "  const source = createSessionSearchSource({ cacheDir });",
        "  for (const ref of listSessionRefs(sessionsDir)) {",
        "    if (source.load(ref, { toolOutput: true }) === undefined) process.exit(3);",
        "  }",
        "}",
      ].join("\n")
    );
    const runOne = () =>
      new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [script, sessionsDir, cacheDir], {
          stdio: "ignore",
        });
        child.on("exit", (code) => resolve(code));
      });
    const codes = await Promise.all(Array.from({ length: 6 }, runOne));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);

    const files = readdirSync(cacheDir).sort();
    assert.deepEqual(
      files,
      ids.flatMap((id) => [`${id}.json`, `${id}.tools.json`]).sort(),
      "不留临时文件"
    );
    const check = countingSource(cacheDir);
    for (const ref of listSessionRefs(sessionsDir)) {
      assert.equal(check.source.load(ref, { toolOutput: true })?.toolOutput?.length, 1);
    }
    assert.deepEqual(check.reads, [], "并发写下的缓存全部有效，不必重抽");
  }));

test("清理：会话文件已不在会话根下的缓存删掉（删前再列一次确认），超过一小时的临时文件删掉，其余不动", () =>
  withDirs(async ({ sessionsDir, cacheDir }) => {
    const kept = asSessionId("sess_01JAAAAAA10000000000000000");
    await seed(
      sessionsDir,
      (s) => {
        s.startRun({ task: "留着" });
        s.endRun();
      },
      kept
    );
    const gone = asSessionId("sess_01JAAAAAA20000000000000000");
    const gonePath = await seed(
      sessionsDir,
      (s) => {
        s.startRun({ task: "会被移走" });
        s.endRun();
      },
      gone
    );
    const born = asSessionId("sess_01JAAAAAA40000000000000000");
    const { source } = countingSource(cacheDir);
    for (const ref of listSessionRefs(sessionsDir)) {
      source.load(ref, { toolOutput: true });
    }
    rmSync(gonePath);
    // 第一次列出时还没有、删前再列时已出现的会话（另一进程刚建）：不删
    writeFileSync(join(cacheDir, `${born}.json`), "{}");
    const now = Date.now();
    const staleTemp = join(cacheDir, `${kept}.json.123.abcd.tmp`);
    const freshTemp = join(cacheDir, `${kept}.json.456.ef01.tmp`);
    writeFileSync(staleTemp, "{");
    writeFileSync(freshTemp, "{");
    utimesSync(
      staleTemp,
      new Date(now - STALE_TEMP_MS - 1000),
      new Date(now - STALE_TEMP_MS - 1000)
    );
    const listings = [new Set([kept]), new Set([kept, born])];
    let calls = 0;
    pruneSessionSearchCache(cacheDir, () => listings[Math.min(calls++, 1)] as Set<string>, now);
    assert.deepEqual(
      readdirSync(cacheDir).sort(),
      [`${kept}.json`, `${kept}.json.456.ef01.tmp`, `${kept}.tools.json`, `${born}.json`].sort()
    );
    assert.equal(calls, 2);
  }));

test("目录信息里存父会话：worker 会话的缓存带派出它的会话号，命中缓存时照样取到", () =>
  withDirs(async ({ sessionsDir, cacheDir }) => {
    const parent = createFixtureSession({ sessionsDir, sessionId: SESSION });
    parent.startRun({ task: "主会话" });
    const child = spawnFixtureWorker(parent, { sessionsDir, name: "w1", task: "活" });
    child.startRun({ task: "活" });
    child.endRun();
    const { sessionId: childId } = await child.close();
    parent.endRun();
    await parent.close();
    const ref = listSessionRefs(sessionsDir).find((item) => item.sessionId === childId);
    assert.ok(ref !== undefined);
    assert.equal(
      countingSource(cacheDir).source.load(ref, { toolOutput: false })?.info.parentSessionId,
      SESSION
    );
    const cached = countingSource(cacheDir);
    assert.equal(cached.source.load(ref, { toolOutput: false })?.info.parentSessionId, SESSION);
    assert.deepEqual(cached.reads, []);
  }));

test("清理时列会话根失败（子目录正好消失等）：跳过这次清理，不抛错", () =>
  withDirs(async ({ sessionsDir, cacheDir }) => {
    await seed(sessionsDir, (s) => {
      s.startRun({ task: "照常" });
      s.endRun();
    });
    countingSource(cacheDir).source.load(onlyRef(sessionsDir), { toolOutput: false });
    const before = readdirSync(cacheDir).sort();
    assert.doesNotThrow(() =>
      pruneSessionSearchCache(cacheDir, () => {
        throw new Error("ENOENT");
      })
    );
    let calls = 0;
    assert.doesNotThrow(() =>
      pruneSessionSearchCache(cacheDir, () => {
        calls += 1;
        if (calls > 1) {
          throw new Error("ENOENT");
        }
        return new Set<string>();
      })
    );
    assert.deepEqual(readdirSync(cacheDir).sort(), before);
  }));
