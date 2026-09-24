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
  // 并行的参考容器数（缺省 1）
  concurrency?: number;
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
  const lanes = options.concurrency ?? 1;
  const containers = Array.from(
    { length: lanes },
    (_, k) =>
      `pigeon-stream-probe-${options.runtime.profile.name}-${process.pid}-${Date.now()}-${k}`
  );
  try {
    const bundle = human.bundle(rangeEnd);
    const references: ReferenceWorkspace[] = [];
    for (const container of containers) {
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
      const reference = new ReferenceWorkspace(
        dockerStreamShell({ container, root: STREAM_WORKSPACE_ROOT, docker })
      );
      await reference.init(bundle, rangeEnd);
      references.push(reference);
      log(`参考容器 ${container} 就绪，装入人的历史至 ${rangeEnd.slice(0, 9)}`);
    }
    const facts = await collectStreamFacts({
      human,
      runtime: options.runtime,
      references,
      rangeStart: options.rangeStart,
      rangeEnd,
      // 断点文件与清单同目录：同一条命令重跑即从断点续测
      options: {
        testTimeoutMs: options.testTimeoutMs ?? 600_000,
        log,
        checkpointFile: checkpointPathFor(options.outFile),
      },
    });
    // 探针记录先写：出清单报错（例如有探针环境错误待定）时也留得下
    writeFileSync(probesPathFor(options.outFile), `${JSON.stringify(facts.probes, null, 2)}\n`);
    const manifest = manifestFromFacts({
      human,
      runtime: options.runtime,
      rangeStart: options.rangeStart,
      facts,
    });
    writeFileSync(options.outFile, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    for (const container of containers) {
      await removeWorkspaceContainer(container, docker).catch(() => {});
    }
  }
}

// 组装工作区镜像的构建上下文（之后 docker build <目录>）：
//   pigeon：Dockerfile 加人的仓库里最新一份 package.json 与锁文件（lockRev，缺省 HEAD）；
//   strands：Dockerfile、stream_env.py，加各组合起始提交的 strands-py/pyproject.toml 与起始提交的日期（env-dates.txt，
//   每行"组合 日期"；构建时每套组合只取该日期之前已发布的依赖）
// strands lint 层要解析的提交（148 补记"lint 按提交解析"）：各流题、维护步与套用步的提交——人的基准、开跑前检查与
// 判题都按"该步人的提交"选 lint 环境；按清单顺序去重，跳过与重置沿用上一步、不在其内
export function strandsLintCommits(manifest: StreamManifest): string[] {
  const out = new Set<string>();
  for (const seg of manifest.streams) {
    for (const step of stepsOf(manifest, seg.id)) {
      if (step.kind === "task" || step.kind === "maintenance" || step.kind === "apply")
        out.add(step.commit);
    }
  }
  return [...out];
}

export function assembleImageContext(input: {
  profileName: string;
  repoDir: string;
  outDir: string;
  lockRev?: string;
  // strands-lint：要测哪些提交取自这份清单
  manifest?: StreamManifest;
  // strands 的依赖组合与起始提交（缺省为写死的五套；测试用合成仓库时注入）
  variants?: readonly { name: string; commit: string }[];
}): string[] {
  const human = gitHumanRepo(input.repoDir);
  const assets = new URL("../../eval/stream/", import.meta.url);
  mkdirSync(input.outDir, { recursive: true });
  const written: string[] = [];
  const put = (name: string, content: Buffer | string) => {
    mkdirSync(path.dirname(path.join(input.outDir, name)), { recursive: true });
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
    const variants = input.variants ?? STRANDS_ENV_VARIANTS;
    for (const v of variants) {
      put(
        `pyproject-${v.name}.toml`,
        human.show(human.resolve(v.commit), "strands-py/pyproject.toml")
      );
    }
    put("env-dates.txt", variants.map((v) => `${v.name} ${human.commitDate(v.commit)}\n`).join(""));
    return written;
  }
  if (input.profileName === "strands-lint") {
    // lint 层（在 strands 基础镜像之上构建）：每个要测的提交一份 pyproject 与它的提交时间，构建时按提交时间解析
    if (input.manifest === undefined) throw new Error("strands-lint 需要 --manifest <清单>");
    copyAsset("strands", "Dockerfile.lint");
    copyAsset("strands", "build-lint.sh");
    copyAsset("strands", "stream_env.py");
    const commits = strandsLintCommits(input.manifest);
    for (const c of commits) put(`lint/${c}.toml`, human.show(c, "strands-py/pyproject.toml"));
    put("lint-dates.txt", commits.map((c) => `${c} ${human.commitDate(c)}\n`).join(""));
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
