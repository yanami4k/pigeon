// 容器执行端的新建（决策 358 照 334）：两段容器内脚本经替身容器（本机执行的假 docker）验——新建含中间目录、读后覆盖；
// 路径按内核顺序解析（链接 l→a/b 时 l/../.pigeon/x 落在 a/.pigeon/x，与受保护路径的容器判定同一口径，不按词法折叠成
// .pigeon/x）；路径里的换行不被吃掉、解析结果含控制字符即拒绝；检查之后被别人建了不覆盖、路径上的目录被换成链接拒写。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspacePathError, WorkspaceWriteRefusedError } from "../tools/paths.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { FileReadTracker } from "../tools/read-tracker.ts";
import { createWriteFileTool } from "../tools/write-file.ts";
import { localDockerHost } from "./local-docker-fixtures.ts";

const POSIX = process.platform !== "win32";

async function withContainer(
  body: (root: string, docker: ReturnType<typeof localDockerHost>) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-container-write-"));
  const docker = localDockerHost(root);
  try {
    await body(root, docker);
  } finally {
    docker.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

test("容器：write_file 新建含中间目录，读过后可整体覆盖", { skip: !POSIX }, () =>
  withContainer(async (root, docker) => {
    const reads = new FileReadTracker();
    const write = createWriteFileTool(docker.host, reads);
    const read = createReadFileTool(docker.host, { editMode: "replace", reads });
    await write.execute("w1", { path: "a/b/new.txt", content: "one\n" });
    assert.equal(readFileSync(join(root, "a", "b", "new.txt"), "utf8"), "one\n");
    writeFileSync(join(root, "old.txt"), "old\n");
    await read.execute("r", { path: "old.txt" });
    await write.execute("w2", { path: "old.txt", content: "new\n" });
    assert.equal(readFileSync(join(root, "old.txt"), "utf8"), "new\n");
  })
);

test("容器：链接加 .. 按内核顺序解析，落点与受保护路径判定一致", { skip: !POSIX }, () =>
  withContainer(async (root, docker) => {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    mkdirSync(join(root, ".pigeon"));
    symlinkSync(join(root, "a", "b"), join(root, "l"));
    const created = await docker.host.resolveForCreate?.("l/../.pigeon/x");
    assert.deepEqual(created, { path: join(root, "a", ".pigeon", "x"), exists: false });
    writeFileSync(join(root, "a", "f.txt"), "f\n");
    const existing = await docker.host.resolveForCreate?.("l/../f.txt");
    assert.deepEqual(existing, { path: join(root, "a", "f.txt"), exists: true });
    await assert.rejects(
      async () => docker.host.resolveForCreate?.("new/../x"),
      WorkspacePathError
    );
  })
);

test("容器：路径里的换行不被吃掉，解析结果含控制字符即拒绝，什么也不建", { skip: !POSIX }, () =>
  withContainer(async (root, docker) => {
    mkdirSync(join(root, ".pigeon"));
    await assert.rejects(
      async () => docker.host.resolveForCreate?.(".pigeon\n/x"),
      WorkspacePathError
    );
    assert.equal(existsSync(join(root, ".pigeon", "x")), false);
  })
);

test("容器：检查之后被别人建了不覆盖；路径上的目录被换成链接拒写", { skip: !POSIX }, () =>
  withContainer(async (root, docker) => {
    const raced = await docker.host.resolveForCreate?.("raced.txt");
    assert.equal(raced?.exists, false);
    writeFileSync(join(root, "raced.txt"), "theirs\n");
    await assert.rejects(
      async () => docker.host.createText?.(raced?.path ?? "", "mine\n"),
      WorkspaceWriteRefusedError
    );
    assert.equal(readFileSync(join(root, "raced.txt"), "utf8"), "theirs\n");
    mkdirSync(join(root, "d"));
    const nested = await docker.host.resolveForCreate?.("d/sub/new.txt");
    const away = mkdtempSync(join(tmpdir(), "pigeon-container-away-"));
    try {
      renameSync(join(root, "d"), join(root, "d-old"));
      symlinkSync(away, join(root, "d"));
      await assert.rejects(
        async () => docker.host.createText?.(nested?.path ?? "", "x"),
        WorkspaceWriteRefusedError
      );
      assert.equal(existsSync(join(away, "sub")), false);
    } finally {
      rmSync(away, { recursive: true, force: true });
    }
  })
);
