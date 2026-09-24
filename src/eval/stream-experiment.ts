// 延续式实验的装配（第三至六节）：读流清单，按仓库选运行方式，起一个装有人的完整历史的参考容器算全量测量的基准，
// 按条件接入 agent，交给跑批器；结束后移除参考容器。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { removeWorkspaceContainer, startWorkspaceContainer } from "../execution/container-host.ts";
import { gatewayStreamFn, gatewayUpstreamBaseUrl } from "../pi-runtime/index.ts";
import { WORKSPACE_NETWORK_ARGS } from "./container-workspace.ts";
import { type ModelGateway, startModelGateway } from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";
import { currentHarnessRef } from "./runner.ts";
import { commandStepAgent, type PigeonStepAgentOptions, pigeonStepAgent } from "./stream-agents.ts";
import {
  type BaselineCheck,
  type BaselineSummary,
  baselineTargets,
  computeBaselines,
} from "./stream-baseline.ts";
import { gitHumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { STREAM_RUNTIMES } from "./stream-generate.ts";
import { checkOrWriteIdentity, manifestDigestOf } from "./stream-identity.ts";
import type { StreamManifest } from "./stream-manifest.ts";
import { gateFromSteps, type StreamRepoRuntime } from "./stream-profiles.ts";
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
  // Pigeon 各条件的运行参数（模型接入由网关给；放权固定为无人值守，见 streamPigeonOptions）；缺省则这些条件的作业停止并说明
  pigeon?: StreamPigeonOptions;
  // 最简 agent 的启动器命令；缺省则该条件的作业停止并说明
  minimalCommand?: readonly string[];
  docker?: readonly string[];
  containerRunArgs?: readonly string[];
  // 提前单独算好的人的基准目录（eval stream-baseline 的输出）；缺省在输出目录下现算
  baselineDir?: string;
  log?: (line: string) => void;
}

export type StreamPigeonOptions = Omit<PigeonStepAgentOptions, "streamFn" | "streamFnFor" | "yolo">;

// 延续式跑批无人值守：Pigeon 各条件一律放权（yolo），不依赖调用方记得传——没有审批通道时，prompt 档的写与执行
// 一律被拒，条件就不再是"完整 Pigeon"
export function streamPigeonOptions(
  pigeon: StreamPigeonOptions
): Omit<PigeonStepAgentOptions, "streamFn" | "streamFnFor"> {
  return { ...pigeon, yolo: true };
}

// 镜像的标识：镜像 ID（内容摘要），不用可变的标签——同一标签重建后 ID 即变，已落盘的人的基准不再复用
export function imageIdOf(image: string, docker: readonly string[]): string {
  const [program = "docker", ...pre] = docker;
  const id = execFileSync(program, [...pre, "image", "inspect", "--format", "{{.Id}}", image], {
    encoding: "utf8",
  }).trim();
  if (id === "") throw new Error(`取不到镜像 ${image} 的 ID`);
  return id;
}

// 最简 agent 的版本与它自己的模型设定：用装有 mini-swe-agent 的解释器查（取不到的项记 null，照实）
const MINI_IDENTITY_SCRIPT = [
  "import json, importlib.metadata as m",
  "out = {}",
  "for k, p in (('miniSweAgent', 'mini-swe-agent'), ('litellm', 'litellm')):",
  "    try: out[k] = m.version(p)",
  "    except Exception: out[k] = None",
  "try:",
  "    import yaml",
  "    from minisweagent.config import builtin_config_dir",
  "    c = yaml.safe_load((builtin_config_dir / 'benchmarks' / 'swebench.yaml').read_text(encoding='utf-8'))",
  "    out['modelKwargs'] = c.get('model', {}).get('model_kwargs', {})",
  "except Exception:",
  "    out['modelKwargs'] = None",
  "print(json.dumps(out))",
].join("\n");

function miniIdentityOf(python: string): {
  miniSweAgent: string | null;
  litellm: string | null;
  modelKwargs: Record<string, unknown> | null;
} {
  try {
    // mini-swe-agent 导入时会在标准输出打横幅，结果取最后一个非空行
    const out = execFileSync(python, ["-c", MINI_IDENTITY_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
    });
    const last = out
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .at(-1);
    return JSON.parse(last ?? "");
  } catch {
    return { miniSweAgent: null, litellm: null, modelKwargs: null };
  }
}

function readManifest(file: string): { manifest: StreamManifest; runtime: StreamRepoRuntime } {
  const manifest = JSON.parse(readFileSync(file, "utf8")) as StreamManifest;
  const runtimeName = RUNTIME_BY_REPO[manifest.repo];
  const runtime = runtimeName === undefined ? undefined : STREAM_RUNTIMES[runtimeName];
  if (runtime === undefined) throw new Error(`清单的仓库 ${manifest.repo} 没有对应的运行方式`);
  return { manifest, runtime };
}

export async function runStreamExperiment(
  options: StreamExperimentOptions
): Promise<RunStreamsSummary> {
  const { manifest, runtime } = readManifest(options.manifestFile);
  const docker = options.docker ?? ["docker"];
  const outDir = path.resolve(options.outDir);
  const human = gitHumanRepo(options.repoDir);
  const prefix = `pigeon-stream-${createHash("sha256").update(outDir).digest("hex").slice(0, 8)}`;
  const referenceName = `${prefix}-reference`;
  const modelId = options.gateway.modelId;
  // 身份头（应修 9）：开跑前写入或比对，不一致即拒绝续跑——在起网关与容器之前做
  const imageId = imageIdOf(options.image, docker);
  const pigeonSettings =
    options.pigeon === undefined
      ? undefined
      : {
          provider: options.pigeon.provider ?? "kimi-coding",
          modelId: options.pigeon.modelId ?? modelId,
          temperature: options.pigeon.temperature ?? null,
          thinking: options.pigeon.thinking ?? null,
          maxOutputTokens: options.pigeon.maxOutputTokens ?? null,
        };
  const miniSettings =
    options.minimalCommand === undefined
      ? undefined
      : { model: modelId, ...miniIdentityOf(options.minimalCommand[0] ?? "python") };
  mkdirSync(outDir, { recursive: true });
  const runIdentity = checkOrWriteIdentity(outDir, {
    core: {
      repo: manifest.repo,
      manifestDigest: manifestDigestOf(options.manifestFile),
      image: imageId,
      budget: options.budget,
      conditions: [...options.conditions],
      maxSteps: options.maxSteps ?? null,
      agents: {
        ...(pigeonSettings !== undefined ? { pigeon: pigeonSettings } : {}),
        ...(miniSettings !== undefined ? { minimal: miniSettings } : {}),
      },
    },
    info: { concurrency: options.concurrency ?? 4, harness: currentHarnessRef() },
  });
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
        ...streamPigeonOptions(options.pigeon),
        docker,
        // 回炉验证前还原人写的测试与测试辅助文件（按这条流的运行方式归类）
        humanTestFile: (file) => {
          const kind = runtime.profile.classifyFile(file);
          return kind === "test" || kind === "testaux";
        },
        streamFnFor: (baseUrl) => gatewayStreamFn(baseUrl, modelId),
        // 限额信号一到即中止在途的一步（反正要作废重做）
        limits,
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
        image: imageId,
        cacheDir:
          options.baselineDir !== undefined
            ? path.resolve(options.baselineDir)
            : path.join(outDir, "reference"),
      }),
      outDir,
      conditions: options.conditions,
      budget: options.budget,
      harnessRef: currentHarnessRef(),
      limits,
      gateway: liveGateway,
      runIdentity,
      agentSettings: {
        ...(pigeonSettings !== undefined ? { pigeon: pigeonSettings } : {}),
        ...(miniSettings !== undefined ? { minimal: miniSettings } : {}),
      },
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

export interface StreamBaselineOptions {
  manifestFile: string;
  repoDir: string;
  image: string;
  // 基准目录：每个提交一个结果文件，同一目录重跑即续算
  outDir: string;
  // 路数：每路一个独立的参考容器
  concurrency?: number;
  streams?: readonly string[];
  docker?: readonly string[];
  containerRunArgs?: readonly string[];
  // 算什么：人的基准（用例）、开跑前置检查（人的代码逐步跑验证门），或两者（缺省）
  check?: BaselineCheck;
  log?: (line: string) => void;
}

// 提前单独算人的基准：起 N 个参考容器（与作业的参考容器分开），按提交分摊，结束后移除
export async function runStreamBaselines(options: StreamBaselineOptions): Promise<BaselineSummary> {
  const { manifest, runtime } = readManifest(options.manifestFile);
  const docker = options.docker ?? ["docker"];
  const outDir = path.resolve(options.outDir);
  const human = gitHumanRepo(options.repoDir);
  const prefix = `pigeon-stream-${createHash("sha256").update(outDir).digest("hex").slice(0, 8)}`;
  const lanes = Math.max(1, options.concurrency ?? 1);
  const names = Array.from({ length: lanes }, (_, i) => `${prefix}-baseline-${i + 1}`);
  const imageId = imageIdOf(options.image, docker);
  const targets = baselineTargets({
    manifest,
    human,
    runtime,
    ...(options.streams !== undefined ? { streams: options.streams } : {}),
  });
  try {
    const references = await Promise.all(
      names.map(async (name) => {
        await removeWorkspaceContainer(name, docker);
        await startWorkspaceContainer({
          image: options.image,
          name,
          docker,
          runArgs: [
            ...WORKSPACE_NETWORK_ARGS,
            "--label",
            `pigeon.stream=${prefix}`,
            ...(options.containerRunArgs ?? []),
          ],
        });
        const ws = new ReferenceWorkspace(
          dockerStreamShell({ container: name, root: STREAM_CONTAINER_ROOT, docker })
        );
        await ws.init(human.bundle(manifest.rangeEnd), manifest.rangeEnd);
        return new ReferenceCases({ reference: ws, runtime, cacheDir: outDir, image: imageId });
      })
    );
    return await computeBaselines({
      targets,
      references,
      check: options.check ?? "both",
      gateCommand: gateFromSteps(runtime.verifySteps),
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
  } finally {
    for (const name of names) await removeWorkspaceContainer(name, docker).catch(() => {});
  }
}
