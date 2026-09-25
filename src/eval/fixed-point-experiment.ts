// 定点对照的装配（决策 139、155、156）：与正式跑同一套断网容器、本地网关、限额控制器与 Pigeon 步 agent。
// 事件认定只起容器、不调模型；单步重跑的 Pigeon 按原尝试照搬的运行面造，模型请求经网关。
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContainerWorkspaceHost } from "../execution/container-host.ts";
import { gatewayStreamFn } from "../pi-runtime/index.ts";
import {
  type FixedPointEventList,
  type FixedPointGroup,
  identifyEvents,
  readEventList,
  writeEventList,
} from "./fixed-point-events.ts";
import { assertHarnessMatches } from "./fixed-point-harness.ts";
import {
  DEFAULT_FIXED_POINT_CONCURRENCY,
  type FixedPointSummary,
  runFixedPoint,
} from "./fixed-point-rerun.ts";
import { assertConcurrencyFits, type GatewayAccount } from "./model-gateway.ts";
import { currentHarnessRef } from "./runner.ts";
import { pigeonStepAgent } from "./stream-agents.ts";
import {
  imageIdOf,
  readManifest,
  startGatewayAndLimits,
  streamPigeonOptions,
} from "./stream-experiment.ts";
import { gitHumanRepo } from "./stream-facts.ts";
import { dockerStreamEnvs, lockOutDir } from "./stream-runner.ts";

function prefixOf(kind: string, outPath: string): string {
  return `pigeon-${kind}-${createHash("sha256").update(path.resolve(outPath)).digest("hex").slice(0, 8)}`;
}

export interface FixedPointEventsOptions {
  manifestFile: string;
  repoDir: string;
  image: string;
  noMemoryDir: string;
  // 事件清单写到哪里
  outFile: string;
  attempt?: number;
  streams?: readonly string[];
  docker?: readonly string[];
  containerRunArgs?: readonly string[];
  log?: (line: string) => void;
}

export async function runFixedPointEvents(
  options: FixedPointEventsOptions
): Promise<FixedPointEventList> {
  const { manifest, runtime } = readManifest(options.manifestFile);
  const docker = options.docker ?? ["docker"];
  const human = gitHumanRepo(options.repoDir);
  const outFile = path.resolve(options.outFile);
  const list = await identifyEvents({
    manifest,
    runtime,
    human,
    noMemoryDir: path.resolve(options.noMemoryDir),
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(options.streams !== undefined ? { streams: options.streams } : {}),
    envs: dockerStreamEnvs({
      image: options.image,
      human,
      prefix: prefixOf("fixed-point-events", outFile),
      docker,
      ...(options.containerRunArgs !== undefined ? { runArgs: options.containerRunArgs } : {}),
    }),
    hostFor: (target) =>
      createContainerWorkspaceHost({ container: target.container, root: target.root, docker }),
    scratch: `${outFile}.scratch`,
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  writeEventList(outFile, list);
  return list;
}

export interface FixedPointExperimentOptions {
  manifestFile: string;
  repoDir: string;
  image: string;
  noMemoryDir: string;
  eventsFile: string;
  outDir: string;
  concurrency?: number;
  passes?: number;
  groups?: readonly FixedPointGroup[];
  // 模型请求经网关（155）：上游模型须与原尝试的模型相同
  gateway: { accounts: readonly GatewayAccount[]; modelId: string };
  docker?: readonly string[];
  containerRunArgs?: readonly string[];
  log?: (line: string) => void;
}

export async function runFixedPointExperiment(
  options: FixedPointExperimentOptions
): Promise<FixedPointSummary> {
  // 与正式跑批同一口径：先取输出目录锁，再读清单、探测账号
  const outDir = path.resolve(options.outDir);
  const release = lockOutDir(outDir);
  try {
    return await runFixedPointExperimentLocked(options, outDir);
  } finally {
    release();
  }
}

async function runFixedPointExperimentLocked(
  options: FixedPointExperimentOptions,
  outDir: string
): Promise<FixedPointSummary> {
  const { manifest, runtime } = readManifest(options.manifestFile);
  const docker = options.docker ?? ["docker"];
  const human = gitHumanRepo(options.repoDir);
  const events = readEventList(options.eventsFile);
  const concurrency = options.concurrency ?? DEFAULT_FIXED_POINT_CONCURRENCY;
  const modelId = options.gateway.modelId;
  // 放行与正式跑批同一套（决策 163）：路数不超过各账号配置并发之和；网关与限额控制器按可用容量放行，
  // 开跑前逐个探测账号（认证失败即拒绝开跑）；结束时关掉两者
  assertConcurrencyFits(concurrency, options.gateway.accounts);
  const { gateway: liveGateway, limits } = await startGatewayAndLimits(
    options.gateway,
    concurrency
  );
  try {
    return await runFixedPoint({
      events,
      manifest,
      runtime,
      human,
      noMemoryDir: path.resolve(options.noMemoryDir),
      envs: dockerStreamEnvs({
        image: options.image,
        human,
        prefix: prefixOf("fixed-point", outDir),
        docker,
        ...(options.containerRunArgs !== undefined ? { runArgs: options.containerRunArgs } : {}),
      }),
      hostFor: (target) =>
        createContainerWorkspaceHost({ container: target.container, root: target.root, docker }),
      // 照搬原尝试的模型、推理档位、输出上限与温度；网关的上游模型须与原尝试一致
      agentFor: (rt) => {
        if (rt.modelId !== modelId) {
          throw new Error(
            `网关的上游模型 ${modelId} 与原尝试的模型 ${rt.modelId} 不同：请用 --model-id ${rt.modelId}`
          );
        }
        return pigeonStepAgent({
          ...streamPigeonOptions({
            provider: rt.provider,
            modelId: rt.modelId,
            thinking: rt.thinkingLevel,
            ...(rt.maxOutputTokens !== undefined ? { maxOutputTokens: rt.maxOutputTokens } : {}),
            ...(rt.temperature !== undefined ? { temperature: rt.temperature } : {}),
          }),
          docker,
          humanTestFile: (file) => {
            const kind = runtime.profile.classifyFile(file);
            return kind === "test" || kind === "testaux";
          },
          streamFnFor: (baseUrl) => gatewayStreamFn(baseUrl, rt.modelId),
          limits,
        });
      },
      outDir,
      ...(options.groups !== undefined ? { groups: options.groups } : {}),
      ...(options.passes !== undefined ? { passes: options.passes } : {}),
      limits,
      gateway: liveGateway,
      outDirLocked: true,
      // 镜像与 harness 代码须与无记忆整流时相同（决策 156）
      imageId: imageIdOf(options.image, docker),
      checkHarness: (recorded) =>
        assertHarnessMatches(
          fileURLToPath(new URL("../..", import.meta.url)),
          recorded,
          currentHarnessRef()
        ),
      concurrency,
      harnessRef: currentHarnessRef(),
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
  } finally {
    await liveGateway.close();
    limits.close();
  }
}
