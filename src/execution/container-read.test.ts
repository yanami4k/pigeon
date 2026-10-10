// 容器里的读档（决策 355），真容器（busybox）：工作区内外按容器内的真实路径判定（含经链接落到工作区外），容器内家目录下的
// .ssh 与其他工作区外文件同一规则（决策 412）；grep、glob 的结果逐条分类。没有 Docker 或 busybox 镜像时跳过。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
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

test.skipIf(skip)(
  "容器里读档：工作区内外按容器内的真实路径判定（含链接），~/.ssh 照工作区外处理；结果逐条分类",
  async () => {
    const name = `pigeon-read-${process.pid}`;
    await removeWorkspaceContainer(name);
    await startWorkspaceContainer({ image: "busybox:latest", name });
    try {
      const made = await containerExec({
        container: name,
        command: [
          "sh",
          "-c",
          "mkdir -p /work /outside /root/.ssh && printf 'in' > /work/a.txt && printf 'lib' > /outside/lib.txt && " +
            "printf 'key' > /root/.ssh/id && ln -s /root/.ssh /work/keys",
        ],
        workdir: "/",
        user: "root",
      });
      assert.equal(made.exitCode, 0, made.stderr);
      const host = createContainerWorkspaceHost({ container: name, root: "/work" });
      assert.deepEqual(await host.resolveForRead?.("a.txt"), {
        path: "/work/a.txt",
        outside: false,
      });
      for (const [input, target] of [
        ["/outside/lib.txt", "/outside/lib.txt"],
        ["/root/.ssh/id", "/root/.ssh/id"],
        ["keys/id", "/root/.ssh/id"],
      ] as const) {
        assert.deepEqual(
          await host.resolveForRead?.(input),
          { path: target, outside: true },
          input
        );
      }
      // grep、glob 的结果逐条分类：经链接落在工作区外的记工作区外，取不到真实路径的不在结果里
      const result = await host.classifyReadPaths?.(["a.txt", "keys/id", "missing"]);
      assert.equal(result?.incomplete, false);
      assert.deepEqual(Object.fromEntries(result?.classes ?? []), {
        "a.txt": "ok",
        "keys/id": "outside",
      });
      // 检查超时：未查完的标明不完整（逐个 readlink 两万个路径，上限 1 秒）
      const slow = createContainerWorkspaceHost({
        container: name,
        root: "/work",
        helperTimeoutMs: 1000,
      });
      await slow.resolveForRead?.("a.txt");
      const partial = await slow.classifyReadPaths?.(Array.from({ length: 20_000 }, () => "a.txt"));
      assert.equal(partial?.incomplete, true);
      // 工具：未经授权拒读，授权后读到内容（一次一用）
      const tool = createReadFileTool(host, { outsideReads: "allowed" });
      await assert.rejects(
        tool.execute("tc-1", { path: "/outside/lib.txt" }),
        OutsideReadNotApprovedError
      );
      tool.authorizeOutsideRead("tc-2");
      const read = await tool.execute("tc-2", { path: "/outside/lib.txt" });
      assert.match(
        read.content.map((block) => ("text" in block ? block.text : "")).join(""),
        /lib/
      );
    } finally {
      await removeWorkspaceContainer(name);
    }
  }
);
