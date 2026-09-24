// 定点对照的装配（决策 139、155、156）：与正式跑同一套断网容器、本地网关、限额控制器与 Pigeon 步 agent。
// 事件认定只起容器、不调模型；单步重跑的 Pigeon 按原尝试照搬的运行面造，模型请求经网关。
import { createHash } from "node:crypto";
import path from "node:path";
import { createContainerWorkspaceHost } from "../execution/container-host.ts";
import { gatewayStreamFn, gatewayUpstreamBaseUrl } from "../pi-runtime/index.ts";
import {
  type FixedPointEventList,
  type FixedPointGroup,
  identifyEvents,
  readEventList,
  writeEventList,
} from "./fixed-point-events.ts";
import { type FixedPointSummary, runFixedPoint } from "./fixed-point-rerun.ts";
import { type GatewayAccount, type ModelGateway, startModelGateway } from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";
import { currentHarnessRef } from "./runner.ts";
import { pigeonStepAgent } from "./stream-agents.ts";
import { readManifest, streamPigeonOptions } from "./stream-experiment.ts";
import { gitHumanRepo } from "./stream-facts.ts";
import { dockerStreamEnvs } from "./stream-runner.ts";

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
  const { manifest, runtime } = readManifest(options.manifestFile);
  const docker = options.docker ?? ["docker"];
  const human = gitHumanRepo(options.repoDir);
  const outDir = path.resolve(options.outDir);
  const events = readEventList(options.eventsFile);
  const modelId = options.gateway.modelId;
  let gateway: ModelGateway | undefined;
  const limits = new LimitController({
    probe: () => gateway?.probe() ?? Promise.resolve(false),
    slots: options.concurrency ?? 2,
  });
  gateway = await startModelGateway({
    upstreamBaseUrl: await gatewayUpstreamBaseUrl(modelId),
    accounts: options.gateway.accounts,
    limits,
    probeRequest: {
      path: "/v1/messages",
      body: { model: modelId, max_tokens: 1, messages: [{ role: "user", content: "回一个字" }] },
    },
  });
  const liveGateway = gateway;
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
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      limits,
      gateway: liveGateway,
      harnessRef: currentHarnessRef(),
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
  } finally {
    await liveGateway.close();
  }
}
