// 决策 334：编辑工具写入前复核路径——本机与容器两条写入路径各验一遍：
//   ① 检查之后、写入之前把路径上的某层目录换成指向工作区外的符号链接：拒写，告知路径已变，工作区外的文件不变；
//   ② 检查之后、写入之前把要写的文件本身换成符号链接：拒写并报出其指向；
//   ③ 模型给的路径本身是符号链接：在检查时即拒写并报出其指向，链接两端都不变。
// "检查后、写入前"经包一层执行端注入：包装的 writeText 先换路径，再交给真实现（复核在真实现里）。
// 容器一侧用本机执行的假 docker（local-docker-fixtures.ts），写入脚本与本机 shell 同一份。
import assert from "node:assert/strict";
import {
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
import { describe, test } from "vitest";
import { createEditFileTool } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import { WorkspaceWriteRefusedError } from "../tools/paths.ts";
import { createReplaceEditTool } from "../tools/replace-edit.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { localDockerHost } from "./local-docker-fixtures.ts";

const NO_SYMLINKS = process.platform === "win32" ? "Windows 上建符号链接需要额外权限" : false;

interface Fixture {
  base: string;
  root: string;
  outside: string;
  host: WorkspaceHost;
  cleanup: () => void;
}

// 工作区 root 下有 sub/a.txt；工作区外 outside 下有同名的 a.txt
function fixture(kind: "local" | "container"): Fixture {
  const base = mkdtempSync(join(tmpdir(), "pigeon-write-recheck-"));
  const root = join(base, "ws");
  const outside = join(base, "outside");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "sub", "a.txt"), "old\n");
  writeFileSync(join(outside, "a.txt"), "outside\n");
  if (kind === "local") {
    return {
      base,
      root,
      outside,
      host: createLocalWorkspaceHost(root),
      cleanup: () => rmSync(base, { recursive: true, force: true }),
    };
  }
  const docker = localDockerHost(root);
  return {
    base,
    root,
    outside,
    host: docker.host,
    cleanup: () => {
      docker.cleanup();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

// 包一层：writeText 先执行 swap（模拟检查与写入之间别的进程动了路径），再交给真实现
function swapBeforeWrite(host: WorkspaceHost, swap: () => void): WorkspaceHost {
  return {
    ...host,
    writeText: (resolvedPath, content) => {
      swap();
      return host.writeText(resolvedPath, content);
    },
  };
}

// 两种编辑工具（hashline 与 replace）都把 sub/a.txt 的 old 改成 new
const EDITORS = {
  hashline: (host: WorkspaceHost) =>
    createEditFileTool(host).execute("c1", {
      path: "sub/a.txt",
      snapshot: snapshotTag("old\n"),
      edits: [{ op: "replace", anchor: `1#${lineTag("old")}`, lines: ["new"] }],
    }),
  replace: (host: WorkspaceHost) =>
    createReplaceEditTool(host).execute("c1", {
      path: "sub/a.txt",
      old_string: "old",
      new_string: "new",
    }),
} as const;

for (const kind of ["local", "container"] as const) {
  describe.skipIf(NO_SYMLINKS)(`写入前复核（${kind === "local" ? "本机" : "容器"}）`, () => {
    for (const [editor, edit] of Object.entries(EDITORS)) {
      test(`检查后、写入前把某层目录换成指向工作区外的符号链接：拒写并告知路径已变，工作区外的文件不变（${editor}）`, async () => {
        const f = fixture(kind);
        try {
          const host = swapBeforeWrite(f.host, () => {
            renameSync(join(f.root, "sub"), join(f.root, "sub-moved"));
            symlinkSync(f.outside, join(f.root, "sub"));
          });
          await assert.rejects(
            () => edit(host),
            (error: unknown) =>
              error instanceof WorkspaceWriteRefusedError && /路径已变/.test(error.message)
          );
          assert.equal(readFileSync(join(f.outside, "a.txt"), "utf8"), "outside\n");
          assert.equal(readFileSync(join(f.root, "sub-moved", "a.txt"), "utf8"), "old\n");
        } finally {
          f.cleanup();
        }
      });
    }

    test("检查后、写入前把要写的文件换成符号链接：拒写并报出其指向，链接指向的文件不变", async () => {
      const f = fixture(kind);
      try {
        const target = join(f.outside, "a.txt");
        const host = swapBeforeWrite(f.host, () => {
          rmSync(join(f.root, "sub", "a.txt"));
          symlinkSync(target, join(f.root, "sub", "a.txt"));
        });
        await assert.rejects(
          () => EDITORS.hashline(host),
          (error: unknown) =>
            error instanceof WorkspaceWriteRefusedError &&
            /符号链接/.test(error.message) &&
            error.message.includes(target)
        );
        assert.equal(readFileSync(target, "utf8"), "outside\n");
      } finally {
        f.cleanup();
      }
    });

    test("模型给的路径本身是符号链接（指向工作区内）：检查时即拒写并报出其指向，两端都不变", async () => {
      const f = fixture(kind);
      try {
        symlinkSync("sub/a.txt", join(f.root, "link.txt"));
        await assert.rejects(
          () =>
            createReplaceEditTool(f.host).execute("c1", {
              path: "link.txt",
              old_string: "old",
              new_string: "new",
            }),
          (error: unknown) =>
            error instanceof WorkspaceWriteRefusedError &&
            error.message.includes("link.txt → sub/a.txt")
        );
        assert.equal(readFileSync(join(f.root, "sub", "a.txt"), "utf8"), "old\n");
        // 路径上的目录是符号链接（最后一级是普通文件）照常可写
        symlinkSync("sub", join(f.root, "dirlink"));
        await createReplaceEditTool(f.host).execute("c2", {
          path: "dirlink/a.txt",
          old_string: "old",
          new_string: "new",
        });
        assert.equal(readFileSync(join(f.root, "sub", "a.txt"), "utf8"), "new\n");
      } finally {
        f.cleanup();
      }
    });

    test("路径未变时照常写入", async () => {
      const f = fixture(kind);
      try {
        await EDITORS.hashline(swapBeforeWrite(f.host, () => {}));
        assert.equal(readFileSync(join(f.root, "sub", "a.txt"), "utf8"), "new\n");
      } finally {
        f.cleanup();
      }
    });
  });
}
