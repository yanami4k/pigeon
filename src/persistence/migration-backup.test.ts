// 迁移备份（决策 341）：旧文件挪进用户级 ~/.pigeon/state/migration-backup/ 下本项目的目录，原文不变、仓库里不留；
// 已有同名备份时不覆盖；经符号链接打开的同一项目落到同一目录。用户主目录一律指到临时目录。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  MigrationBackupError,
  migrationBackupConflict,
  migrationBackupLocation,
  moveToMigrationBackup,
} from "./migration-backup.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

test("旧文件挪进用户级本项目的备份目录：原文不变，仓库里不留；同名备份已在时不覆盖", () => {
  const root = temp("pigeon-backup-root-");
  const home = temp("pigeon-backup-home-");
  const source = join(root, ".pigeon", "web.json");
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  writeFileSync(source, '{"key":"k-1"}');
  const dir = migrationBackupLocation(root, home);
  assert.ok(dir.startsWith(join(home, ".pigeon", "state", "migration-backup")), dir);
  assert.equal(migrationBackupConflict(root, "web.json", home), undefined);
  const target = moveToMigrationBackup(root, source, "web.json", home);
  assert.equal(target, join(dir, "web.json"));
  assert.equal(readFileSync(target, "utf8"), '{"key":"k-1"}');
  assert.ok(!existsSync(source));
  assert.ok(!existsSync(join(root, ".pigeon", "state")), "仓库里不建备份目录");
  writeFileSync(source, "{}");
  assert.match(migrationBackupConflict(root, "web.json", home) ?? "", /已存在，不覆盖/);
  assert.throws(() => moveToMigrationBackup(root, source, "web.json", home), MigrationBackupError);
  assert.equal(readFileSync(target, "utf8"), '{"key":"k-1"}', "已有备份原样");
});

test("经符号链接打开的同一项目落到同一备份目录", () => {
  const root = temp("pigeon-backup-real-");
  const home = temp("pigeon-backup-home-");
  const link = join(temp("pigeon-backup-link-"), "via");
  symlinkSync(root, link);
  assert.equal(migrationBackupLocation(link, home), migrationBackupLocation(root, home));
});
