// 容器里的 grep 与 glob（决策 368），真容器：各后端的结果与本机 rg 一致——busybox 覆盖 grep -r 与 find 降级，
// 带 rg 与 git 的镜像覆盖 rg 与 git grep。没有 Docker、所需镜像或本机随包的 ripgrep 时跳过。
// 带 git 的镜像取环境变量 PIGEON_SANDBOX_TEST_IMAGE，否则取本地已有的通用镜像（pigeon-sandbox:*）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import { bundledRipgrepPath, type SearchBackendKind } from "../tools/search-backend.ts";
import {
  CONTAINER_TREE_SCRIPT,
  containerTreeArgs,
  makeSearchTree,
  searchOutputs,
} from "../tools/search-fixtures.ts";
import {
  containerExec,
  createContainerWorkspaceHost,
  removeWorkspaceContainer,
  startWorkspaceContainer,
} from "./container-host.ts";

const docker = (...args: string[]) =>
  spawnSync("docker", args, { encoding: "utf8", timeout: 60_000, windowsHide: true });
const dockerUp = docker("version", "--format", "{{.Server.Version}}").status === 0;
const localRg = (await bundledRipgrepPath()) !== undefined;

function gitImage(): string | undefined {
  const fromEnv = process.env.PIGEON_SANDBOX_TEST_IMAGE;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (!dockerUp) return undefined;
  return docker("images", "pigeon-sandbox", "--format", "{{.Repository}}:{{.Tag}}")
    .stdout.split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
}

function skipReason(image: string | undefined): string | false {
  if (!localRg) return "本机没有随包的 ripgrep";
  if (image === undefined || !dockerUp || docker("image", "inspect", image).status !== 0) {
    return `没有 Docker 或镜像 ${image ?? "（带 rg 与 git 的）"}`;
  }
  return false;
}

async function sh(container: string, script: string, args: string[] = []) {
  const result = await containerExec({
    container,
    command: ["sh", "-c", script, "sh", ...args],
    workdir: "/",
  });
  assert.equal(result.exitCode, 0, result.stderr);
}

// 起一个容器，在里面建树，比对各后端的结果与本机同一棵树上 rg 的结果
async function compareWithLocal(
  image: string,
  cases: Array<[string, boolean, SearchBackendKind[]]>
) {
  const name = `pigeon-search-${process.pid}`;
  await removeWorkspaceContainer(name);
  await startWorkspaceContainer({ image, name });
  try {
    for (const [root, git, kinds] of cases) {
      await sh(name, `mkdir -p "$1"`, [root]);
      await sh(name, CONTAINER_TREE_SCRIPT, containerTreeArgs(root));
      if (git) await sh(name, `git init -q "$1"`, [root]);
      const local = makeSearchTree(git);
      try {
        const expected = await searchOutputs(createLocalWorkspaceHost(local.root), "rg", true);
        const host = createContainerWorkspaceHost({ container: name, root });
        for (const kind of kinds) {
          assert.deepEqual(
            await searchOutputs(host, kind),
            expected,
            `容器里的 ${kind} 与本机 rg 不同`
          );
        }
      } finally {
        local.cleanup();
      }
    }
  } finally {
    await removeWorkspaceContainer(name);
  }
}

test("busybox：grep -r 与 find 降级，结果与本机 rg 一致（不在仓库里）", {
  skip: skipReason("busybox:latest"),
}, async () => {
  await compareWithLocal("busybox:latest", [["/tmp/work", false, ["grep"]]]);
});

const image = gitImage();
test("带 rg 与 git 的镜像：git 仓库里 rg 与 git grep、不在仓库里 rg 与 grep -r，结果都与本机 rg 一致", {
  skip: skipReason(image),
}, async () => {
  await compareWithLocal(image ?? "", [
    ["/tmp/work-git", true, ["rg", "git"]],
    ["/tmp/work-plain", false, ["rg", "grep"]],
  ]);
});
