// 延续式实验的装配（第三至六节）：读流清单，按仓库选运行方式，起一个装有人的完整历史的参考容器算全量测量的基准，
// 按条件接入 agent，交给跑批器；结束后移除参考容器。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { removeWorkspaceContainer, startWorkspaceContainer } from "../execution/container-host.ts";
import { gatewayStreamFn, gatewayUpstreamBaseUrl } from "../pi-runtime/index.ts";
import { WORKSPACE_NETWORK_ARGS } from "./container-workspace.ts";
import { type ModelGateway, startModelGateway } from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";
import { currentHarnessRef } from "./runner.ts";
import { commandStepAgent, type PigeonStepAgentOptions, pigeonStepAgent } from "./stream-agents.ts";
import { gitHumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { STREAM_RUNTIMES } from "./stream-generate.ts";
import type { StreamManifest } from "./stream-manifest.ts";
import type { StreamCondition } from "./stream-results.ts";
import {
  dockerStreamEnvs,
  ReferenceCases,
  type RunStreamsSummary,
  runStreams,
  STREAM_CONTAINER_ROOT,
  type StepAgent,
  type StepBudget,
} from "./stream-runner.ts";
import { dockerStreamShell } from "./stream-workspace.ts";

// 清单里的仓库名 → 运行方式
const RUNTIME_BY_REPO: Record<string, string> = {
  "pigeon-harness": "pigeon",
  "strands-py": "strands",
};

export interface StreamExperimentOptions {
  manifestFile: string;
  repoDir: string;
  image: string;
  outDir: string;
  conditions: readonly StreamCondition[];
  streams?: readonly string[];
  attempts?: number;
  concurrency?: number;
  maxSteps?: number;
  budget: StepBudget;
  // 四个条件的模型请求都经跑批进程内置的网关（决策 155）：真 key 只在网关里
  gateway: { keys: readonly string[]; modelId: string };
  // Pigeon 各条件的运行参数（模型接入由网关给）；缺省则这些条件的作业停止并说明
  pigeon?: Omit<PigeonStepAgentOptions, "streamFn" | "streamFnFor">;
  // 最简 agent 的启动器命令；缺省则该条件的作业停止并说明
  minimalCommand?: readonly string[];
  docker?: readonly string[];
  containerRunArgs?: readonly string[];
  log?: (line: string) => void;
}

export async function runStreamExperiment(
  options: StreamExperimentOptions
): Promise<RunStreamsSummary> {
  const manifest = JSON.parse(readFileSync(options.manifestFile, "utf8")) as StreamManifest;
  const runtimeName = RUNTIME_BY_REPO[manifest.repo];
  const runtime = runtimeName === undefined ? undefined : STREAM_RUNTIMES[runtimeName];
  if (runtime === undefined) throw new Error(`清单的仓库 ${manifest.repo} 没有对应的运行方式`);
  const docker = options.docker ?? ["docker"];
  const outDir = path.resolve(options.outDir);
  const human = gitHumanRepo(options.repoDir);
  const prefix = `pigeon-stream-${createHash("sha256").update(outDir).digest("hex").slice(0, 8)}`;
  const referenceName = `${prefix}-reference`;
  const modelId = options.gateway.modelId;
  // 控制器与网关互相引用：控制器探测经网关的上游，网关把限额信号交给控制器
  let gateway: ModelGateway | undefined;
  const limits = new LimitController({
    probe: () => gateway?.probe() ?? Promise.resolve(false),
    slots: options.concurrency ?? 4,
  });
  gateway = await startModelGateway({
    upstreamBaseUrl: await gatewayUpstreamBaseUrl(modelId),
    keys: options.gateway.keys,
    limits,
    probeRequest: {
      path: "/v1/messages",
      body: { model: modelId, max_tokens: 1, messages: [{ role: "user", content: "回一个字" }] },
    },
  });
  const liveGateway = gateway;
  try {
    await removeWorkspaceContainer(referenceName, docker);
    await startWorkspaceContainer({
      image: options.image,
      name: referenceName,
      docker,
      runArgs: [
        ...WORKSPACE_NETWORK_ARGS,
        "--label",
        `pigeon.stream=${prefix}`,
        ...(options.containerRunArgs ?? []),
      ],
    });
    const referenceWs = new ReferenceWorkspace(
      dockerStreamShell({ container: referenceName, root: STREAM_CONTAINER_ROOT, docker })
    );
    await referenceWs.init(human.bundle(manifest.rangeEnd), manifest.rangeEnd);
    const agents: Partial<Record<"pigeon" | "minimal", StepAgent>> = {};
    if (options.pigeon !== undefined) {
      agents.pigeon = pigeonStepAgent({
        ...options.pigeon,
        docker,
        streamFnFor: (baseUrl) => gatewayStreamFn(baseUrl, modelId),
      });
    }
    if (options.minimalCommand !== undefined) {
      agents.minimal = commandStepAgent({
        command: options.minimalCommand,
        docker,
        model: modelId,
        limits,
      });
    }
    return await runStreams({
      manifest,
      runtime,
      human,
      envs: dockerStreamEnvs({
        image: options.image,
        human,
        prefix,
        docker,
        ...(options.containerRunArgs !== undefined ? { runArgs: options.containerRunArgs } : {}),
      }),
      agents,
      reference: new ReferenceCases({
        reference: referenceWs,
        runtime,
        cacheDir: path.join(outDir, "reference"),
      }),
      outDir,
      conditions: options.conditions,
      budget: options.budget,
      harnessRef: currentHarnessRef(),
      limits,
      gateway: liveGateway,
      ...(options.streams !== undefined ? { streams: options.streams } : {}),
      ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
  } finally {
    await removeWorkspaceContainer(referenceName, docker).catch(() => {});
    await liveGateway.close();
  }
}
