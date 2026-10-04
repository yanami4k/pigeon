// 快照器的临时索引（决策 350）：会话内复用一个临时索引，首次从用户索引复制。
// - racy-git 保护：复制出的临时索引的修改时间设回用户索引的修改时间。用户索引里某条目与索引文件处在同一秒（条目"临界干净"），
//   文件又在这一秒里被改成同样长度：git 只在索引文件不比该条目新时才比内容，副本的修改时间若是"现在"，git 只比 stat 就把
//   旧内容当成现状，基线与快照都错。ctime 关掉（core.trustctime=false），比对只剩修改时间与长度；时间一律显式设定，不靠墙钟卡秒；
// - 临时索引出错（这里直接弄坏它）后丢弃，下次从用户索引重新复制，快照照常；关闭后临时索引与临时忽略文件都删掉。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { createCheckpointer } from "./checkpoint.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repo(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-cp-index-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "pigeon@example.invalid"]);
  git(dir, ["config", "user.name", "pigeon-test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("racy-git：用户索引里与索引文件同一秒的条目，文件在这一秒里被改成同样长度，基线与快照都是改后的内容", async () => {
  const dir = repo();
  try {
    git(dir, ["config", "core.trustctime", "false"]);
    const file = join(dir, "a.txt");
    // 一分钟前的整秒：条目在这一秒入索引，文件在同一秒里被原地改写（长度不变），用户索引的修改时间也是这一秒
    const second = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(file, second, second);
    git(dir, ["update-index", "--refresh"]);
    writeFileSync(file, "two\n");
    utimesSync(file, second, second);
    utimesSync(join(dir, ".git", "index"), second, second);

    const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() });
    await checkpointer.beforeChange();
    writeFileSync(join(dir, "b.txt"), "b\n");
    const snapshot = await checkpointer.afterChange();
    assert.ok(snapshot !== undefined);
    assert.equal(git(dir, ["show", `${snapshot.commit}:a.txt`]), "two\n", "快照是现状");
    assert.equal(git(dir, ["show", `${snapshot.baseCommit}:a.txt`]), "two\n", "基线是现状");
    await checkpointer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("临时索引出错后丢弃并从用户索引重新复制，快照照常；关闭后临时索引删掉", async () => {
  const dir = repo();
  // 临时索引放进专用目录，才能认出并弄坏它（同时在跑的别的测试进程也往系统临时目录里放临时索引）
  const own = mkdtempSync(join(tmpdir(), "pigeon-cp-index-tmp-"));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const indexes = () => readdirSync(own).filter((name) => name.startsWith("pigeon-index-"));
  try {
    process.env.TMPDIR = own;
    process.env.TEMP = own;
    process.env.TMP = own;
    const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() });
    await checkpointer.beforeChange();
    const [index] = indexes();
    assert.ok(index !== undefined, "会话内的临时索引在专用目录里");
    writeFileSync(join(own, index), "not an index");
    writeFileSync(join(dir, "a.txt"), "two\n");
    await assert.rejects(() => checkpointer.afterChange(), "坏掉的临时索引让这一次失败");
    const snapshot = await checkpointer.afterChange();
    assert.ok(snapshot !== undefined, "重新复制后照常认出改动");
    assert.equal(git(dir, ["show", `${snapshot.commit}:a.txt`]), "two\n");
    assert.equal(git(dir, ["show", `${snapshot.baseCommit}:a.txt`]), "one\n", "改前基线不受影响");
    assert.equal(
      readdirSync(own).filter((name) => name.startsWith("pigeon-excludes-")).length,
      1,
      "快照的 add 用的临时忽略文件在专用目录里"
    );
    await checkpointer.close();
    assert.deepEqual(
      readdirSync(own).filter((name) => name.startsWith("pigeon-")),
      [],
      "关闭后临时索引与临时忽略文件都删掉"
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(own, { recursive: true, force: true });
  }
});
