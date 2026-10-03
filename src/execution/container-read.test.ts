// 容器里的读档（决策 355），真容器（busybox）：工作区外读取按容器内的路径判定；禁读名单按容器内的家目录展开、
// 按真实路径拒（含链接）。没有 Docker 或 busybox 镜像时跳过。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { ReadDeniedError, readDenyList } from "../tools/read-deny.ts";
import { createReadFileTool, OutsideReadNotApprovedError } from "../tools/read-file.ts";
import {
  containerExec,
  createContainerWorkspaceHost,
  removeWorkspaceContainer,
  startWorkspaceContainer,
} from "./container-host.ts";

const docker = (...args: string[]) =>
  spawnSync("docker", args, { encoding: "utf8", timeout: 60_000, windowsHide: true });
const skip =
  docker("version", "--format", "{{.Server.Version}}").status === 0 &&
  docker("image", "inspect", "busybox:latest").status === 0
    ? false
    : "没有 Docker 或 busybox 镜像";

test("容器里读档：工作区外按容器内路径判定；禁读名单按容器内的家目录展开、按真实路径拒（含链接）", {
  skip,
}, async () => {
  const name = `pigeon-read-${process.pid}`;
  await removeWorkspaceContainer(name);
  await startWorkspaceContainer({ image: "busybox:latest", name });
  try {
    const made = await containerExec({
      container: name,
      command: [
        "sh",
        "-c",
        "mkdir -p /work /outside /creds /root/.ssh && printf 'in' > /work/a.txt && printf 'lib' > /outside/lib.txt && " +
          "printf 'key' > /root/.ssh/id && printf 'aws' > /creds/key && ln -s /root/.ssh /work/keys && ln -s /creds /root/.aws",
      ],
      workdir: "/",
      user: "root",
    });
    assert.equal(made.exitCode, 0, made.stderr);
    const host = createContainerWorkspaceHost({ container: name, root: "/work" });
    const deny = readDenyList();
    assert.deepEqual(await host.resolveForRead?.("a.txt", deny), {
      path: "/work/a.txt",
      outside: false,
    });
    assert.deepEqual(await host.resolveForRead?.("/outside/lib.txt", deny), {
      path: "/outside/lib.txt",
      outside: true,
    });
    for (const denied of ["/root/.ssh/id", "keys/id", "/root/.aws/key", "/creds/key"]) {
      await assert.rejects(
        host.resolveForRead?.(denied, deny) ?? Promise.resolve(),
        ReadDeniedError,
        denied
      );
    }
    assert.deepEqual(await host.readDenyWithin?.(deny), []);
    // 工具：未经授权拒读，授权后读到内容（一次一用）
    const tool = createReadFileTool(host, { outsideReads: "allowed" });
    await assert.rejects(
      tool.execute("tc-1", { path: "/outside/lib.txt" }),
      OutsideReadNotApprovedError
    );
    tool.authorizeOutsideRead("tc-2");
    const read = await tool.execute("tc-2", { path: "/outside/lib.txt" });
    assert.match(read.content.map((block) => ("text" in block ? block.text : "")).join(""), /lib/);
  } finally {
    await removeWorkspaceContainer(name);
  }
});
