// 生成流清单（决策 127、141、153）：起一个断网的参考容器，装入人的完整历史，逐提交测判题探针与格式化比对，
// 按写死的规则出清单。清单与探针原始记录各存一个文件，随结果一起保存。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeWorkspaceContainer, startWorkspaceContainer } from "../execution/container-host.ts";
import { assertKeepsWorkspaceOffline, WORKSPACE_NETWORK_ARGS } from "./container-workspace.ts";
import {
  collectStreamFacts,
  gitHumanRepo,
  manifestFromFacts,
  ReferenceWorkspace,
} from "./stream-facts.ts";
import { countStepKinds, type StreamManifest, stepsOf } from "./stream-manifest.ts";
import {
  pigeonRuntime,
  STRANDS_ENV_VARIANTS,
  type StreamRepoRuntime,
  strandsRuntime,
} from "./stream-profiles.ts";
import { dockerStreamShell } from "./stream-workspace.ts";

export const STREAM_RUNTIMES: Record<string, StreamRepoRuntime> = {
  pigeon: pigeonRuntime,
  strands: strandsRuntime,
};

// 容器内的工作区根；镜像把依赖预装在这里（被仓库的 .gitignore 忽略）
export const STREAM_WORKSPACE_ROOT = "/testbed";

export interface GenerateManifestOptions {
  repoDir: string;
  runtime: StreamRepoRuntime;
  rangeStart: string;
  rangeEnd: string;
  image: string;
  // 清单输出路径；探针记录写到同目录的 <名>.probes.json
  outFile: string;
  docker?: readonly string[];
  // docker run 的附加参数（内存上限等）；不得含打开网络的选项
  containerRunArgs?: readonly string[];
  testTimeoutMs?: number;
  log?: (line: string) => void;
}

export function probesPathFor(outFile: string): string {
  return outFile.replace(/(\.json)?$/, ".probes.json");
}

export function checkpointPathFor(outFile: string): string {
  return outFile.replace(/(\.json)?$/, ".facts.jsonl");
}

export async function generateStreamManifest(
  options: GenerateManifestOptions
): Promise<StreamManifest> {
  const docker = options.docker ?? ["docker"];
  assertKeepsWorkspaceOffline(options.containerRunArgs ?? []);
  const log = options.log ?? (() => {});
  const human = gitHumanRepo(options.repoDir);
  const rangeEnd = human.resolve(options.rangeEnd);
  const container = `pigeon-stream-probe-${options.runtime.profile.name}-${process.pid}-${Date.now()}`;
  await startWorkspaceContainer({
    image: options.image,
    name: container,
    docker,
    runArgs: [
      ...WORKSPACE_NETWORK_ARGS,
      "--label",
      "pigeon.stream-probe=1",
      ...(options.containerRunArgs ?? []),
    ],
  });
  try {
    const reference = new ReferenceWorkspace(
      dockerStreamShell({ container, root: STREAM_WORKSPACE_ROOT, docker })
    );
    log(`参考容器 ${container} 就绪，装入人的历史至 ${rangeEnd.slice(0, 9)}`);
    await reference.init(human.bundle(rangeEnd), rangeEnd);
    const facts = await collectStreamFacts({
      human,
      runtime: options.runtime,
      reference,
      rangeStart: options.rangeStart,
      rangeEnd,
      // 断点文件与清单同目录：同一条命令重跑即从断点续测
      options: {
        testTimeoutMs: options.testTimeoutMs ?? 600_000,
        log,
        checkpointFile: checkpointPathFor(options.outFile),
      },
    });
    const manifest = manifestFromFacts({
      human,
      runtime: options.runtime,
      rangeStart: options.rangeStart,
      facts,
    });
    writeFileSync(options.outFile, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(probesPathFor(options.outFile), `${JSON.stringify(facts.probes, null, 2)}\n`);
    return manifest;
  } finally {
    await removeWorkspaceContainer(container, docker).catch(() => {});
  }
}

// 组装工作区镜像的构建上下文（之后 docker build <目录>）：
//   pigeon：Dockerfile 加人的仓库里最新一份 package.json 与锁文件（lockRev，缺省 HEAD）；
//   strands：Dockerfile、stream_env.py、五套版本约束，加各组合起始提交的 strands-py/pyproject.toml
export function assembleImageContext(input: {
  profileName: string;
  repoDir: string;
  outDir: string;
  lockRev?: string;
}): string[] {
  const human = gitHumanRepo(input.repoDir);
  const assets = new URL("../../eval/stream/", import.meta.url);
  mkdirSync(input.outDir, { recursive: true });
  const written: string[] = [];
  const put = (name: string, content: Buffer | string) => {
    writeFileSync(path.join(input.outDir, name), content);
    written.push(name);
  };
  const copyAsset = (dir: string, name: string) =>
    put(name, readFileSync(fileURLToPath(new URL(`${dir}/${name}`, assets))));
  if (input.profileName === "pigeon") {
    const rev = human.resolve(input.lockRev ?? "HEAD");
    copyAsset("pigeon", "Dockerfile");
    put("package.json", human.show(rev, "package.json"));
    put("package-lock.json", human.show(rev, "package-lock.json"));
    return written;
  }
  if (input.profileName === "strands") {
    copyAsset("strands", "Dockerfile");
    copyAsset("strands", "stream_env.py");
    for (const v of STRANDS_ENV_VARIANTS) {
      copyAsset("strands", `constraints-${v.name}.txt`);
      put(
        `pyproject-${v.name}.toml`,
        human.show(human.resolve(v.commit), "strands-py/pyproject.toml")
      );
    }
    return written;
  }
  throw new Error(`未知的仓库配置：${input.profileName}`);
}

// 清单摘要：各流步数与类型分布（交付回报与审计用）
export function summarizeManifest(manifest: StreamManifest): string {
  const lines = [`${manifest.repo}：${manifest.steps.length} 步，${manifest.streams.length} 条流`];
  const all = countStepKinds(manifest.steps);
  lines.push(
    `  全部：题 ${all.task}、维护步 ${all.maintenance}、套用 ${all.apply}、跳过 ${all.skip}、重置 ${all.reset}`
  );
  for (const seg of manifest.streams) {
    const steps = stepsOf(manifest, seg.id);
    const k = countStepKinds(steps);
    const merged = steps.filter((s) => s.mergedCommits !== undefined).length;
    lines.push(
      `  ${seg.id}（起点 ${seg.startCommit.slice(0, 9)}，${steps.length} 步）：题 ${k.task}（其中红测试对 ${merged}）、维护步 ${k.maintenance}、套用 ${k.apply}、跳过 ${k.skip}`
    );
  }
  return lines.join("\n");
}
