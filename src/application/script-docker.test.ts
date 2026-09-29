// 脚本编排对着真 Docker（决策 310、311）：用产品的容器路径（日常沙箱的通用镜像）跑一个小流水线——派 3 个 worker、接力一次、
// 收回；跑的同时核对脚本容器不挂任何目录、断网、限内存与进程数、只读根。没有 Docker 或本地没有通用镜像时跳过（不构建镜像）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resolveSandboxImage } from "../execution/sandbox-image.ts";
import { SCRIPT_CONTAINER_LABEL } from "../execution/script-sandbox.ts";
import { scriptHarness, tempRepo } from "./script-fixtures.ts";
import { dockerLauncherFor } from "./script-host.ts";

const docker = (...args: string[]) =>
  spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
const dockerUp = docker("version", "--format", "{{.Server.Version}}").status === 0;
const image = resolveSandboxImage(process.cwd(), {}).image;
const ready = dockerUp && docker("image", "inspect", image).status === 0;

test("真容器：小流水线派 3 个 worker、接力一次、收回；容器不挂目录、断网、限资源、只读根", {
  skip: ready ? false : `没有 Docker 或本地没有通用镜像 ${image}`,
}, async () => {
  const repo = tempRepo();
  let inspected: string | undefined;
  const harness = scriptHarness({
    repo,
    launcher: dockerLauncherFor(repo),
    planner: (input) => {
      if (input.task === "写 a") {
        // 脚本在跑：此刻核对脚本容器
        const names = docker(
          "ps",
          "--filter",
          `label=${SCRIPT_CONTAINER_LABEL}=1`,
          "--format",
          "{{.Names}}"
        ).stdout.trim();
        const name = names.split("\n").find((line) => line.startsWith("pigeon-script-"));
        inspected =
          name === undefined
            ? "no container"
            : docker(
                "inspect",
                "-f",
                "{{json .Mounts}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Memory}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.CapDrop}}",
                name
              ).stdout.trim();
        return { files: { "a.txt": "from a\n" }, reply: "写了 a" };
      }
      if (input.task === "接着写 b") {
        const sees = existsSync(join(input.worktree, "a.txt"))
          ? readFileSync(join(input.worktree, "a.txt"), "utf8")
          : "";
        return { files: { "b.txt": `b saw ${sees}` }, reply: "写了 b" };
      }
      return { files: { "c.txt": "c\n" }, reply: "写了 c" };
    },
  });
  const notice = harness.nextNotice();
  await harness.runs.start(
    {
      name: "真容器",
      phases: ["写", "接力"],
      script: [
        'phase("写");',
        'const a = await agent("写 a");',
        'phase("接力");',
        'const b = await agent("接着写 b", { relay: a });',
        'const c = await agent("写 c", { phase: "写" });',
        "return { collect: [a, b, c] };",
      ].join("\n"),
    },
    undefined
  );
  const summary = await notice;
  assert.match(summary, /已完成。worker 3 个：成功 3，失败 0/);
  assert.match(summary, /收回：叠入 a\.txt、b\.txt、c\.txt；冲突未写入 无/);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "from a\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "b saw from a\n");
  assert.equal(readFileSync(join(repo, "c.txt"), "utf8"), "c\n");
  assert.equal(inspected, "[]|none|268435456|64|true|[ALL]");
  // 脚本结束即删掉容器
  const left = docker(
    "ps",
    "-a",
    "--filter",
    `label=${SCRIPT_CONTAINER_LABEL}=1`,
    "--format",
    "{{.Names}}"
  );
  assert.equal(left.stdout.trim(), "");
});
