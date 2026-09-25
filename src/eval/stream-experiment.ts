// 延续式实验的装配（第三至六节）：读流清单，按仓库选运行方式，起一个装有人的完整历史的参考容器算全量测量的基准，
// 按条件接入 agent，交给跑批器；结束后移除参考容器。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { removeWorkspaceContainer, startWorkspaceContainer } from "../execution/container-host.ts";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_THINKING_LEVEL,
  gatewayStreamFn,
  gatewayUpstreamBaseUrl,
} from "../pi-runtime/index.ts";
import { WORKSPACE_NETWORK_ARGS } from "./container-workspace.ts";
import {
  assertConcurrencyFits,
  type GatewayAccount,
  type ModelGateway,
  startModelGateway,
} from "./model-gateway.ts";
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
  lockOutDir,
  ReferenceCases,
  type RunStreamsSummary,
  runStreams,
  STREAM_CONTAINER_ROOT,
  type StepAgent,
  type StepBudget,
} from "./stream-runner.ts";
import { runStreamTrial, type StreamTrialSummary } from "./stream-trial.ts";
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
  gateway: { accounts: readonly GatewayAccount[]; modelId: string };
  // Pigeon 各条件的运行参数（模型接入由网关给；放权固定为无人值守，见 streamPigeonOptions）；缺省则这些条件的作业停止并说明
  pigeon?: StreamPigeonOptions;
  // 最简 agent 的启动器命令；缺省则该条件的作业停止并说明
  minimalCommand?: readonly string[];
  docker?: readonly string[];
  containerRunArgs?: readonly string[];
  // 提前单独算好的人的基准目录（eval stream-baseline 的输出）；缺省在输出目录下现算
  baselineDir?: string;
  log?: (line: string) => void;
  // 停止信号（CLI 收到 SIGTERM 时触发，reason 为说明）：交给限额控制器收尾
  shutdownSignal?: AbortSignal;
}

export type StreamPigeonOptions = Omit<PigeonStepAgentOptions, "streamFn" | "streamFnFor" | "yolo">;

// 延续式跑批无人值守：Pigeon 各条件一律放权（yolo），不依赖调用方记得传——没有审批通道时，prompt 档的写与执行
// 一律被拒，条件就不再是"完整 Pigeon"
export function streamPigeonOptions(
  pigeon: StreamPigeonOptions
): Omit<PigeonStepAgentOptions, "streamFn" | "streamFnFor"> {
  return { ...pigeon, yolo: true };
}

// Pigeon 条件实际生效的参数（身份头与结果行照记）：没给的推理档位与单轮输出上限记运行时的缺省值（off、16,384），
// 不记 null；温度没给即由服务端决定，记 null
export function effectivePigeonSettings(pigeon: StreamPigeonOptions, modelId: string) {
  return {
    provider: pigeon.provider ?? "kimi-coding",
    modelId: pigeon.modelId ?? modelId,
    temperature: pigeon.temperature ?? null,
    thinking: pigeon.thinking ?? DEFAULT_THINKING_LEVEL,
    maxOutputTokens: pigeon.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

// Docker 的镜像存储：经典存储（overlay2 等）下镜像 ID 为 config 摘要；containerd 镜像存储下 {{.Id}} 取到的是 manifest
// 摘要，同一个镜像两种存储下 ID 不同。人的基准、镜像等价表与身份头记的都是经典存储下的 config 摘要
export function imageStoreOf(docker: readonly string[]): { driver: string; containerd: boolean } {
  const [program = "docker", ...pre] = docker;
  const out = execFileSync(
    program,
    [...pre, "info", "--format", "{{.Driver}}|{{json .DriverStatus}}"],
    {
      encoding: "utf8",
    }
  ).trim();
  const bar = out.indexOf("|");
  const driver = bar < 0 ? out : out.slice(0, bar);
  return { driver, containerd: out.includes("io.containerd.snapshotter") };
}

// 镜像的标识：镜像 ID（内容摘要），不用可变的标签——同一标签重建后 ID 即变，已落盘的人的基准不再复用。
// containerd 镜像存储下取到的 ID 与已记下的对不上：响亮报错，不静默地换一套 ID
export function imageIdOf(image: string, docker: readonly string[]): string {
  const store = imageStoreOf(docker);
  if (store.containerd) {
    throw new Error(
      `Docker 用的是 containerd 镜像存储（${store.driver}）：镜像 ID 取到的是 manifest 摘要，与经典存储下记录的 config 摘要` +
        "（人的基准、镜像等价表、身份头）对不上。请把 Docker 改回经典存储（daemon.json 里 features.containerd-snapshotter 设为 false）后再跑"
    );
  }
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

// 输出目录的锁在最前面取（读清单、写身份头、起网关探测各账号之前）：误起第二个进程时它什么都不动就被拒
export async function runStreamExperiment(
  options: StreamExperimentOptions
): Promise<RunStreamsSummary> {
  const outDir = path.resolve(options.outDir);
  const release = lockOutDir(outDir);
  try {
    return await runStreamExperimentLocked(options, outDir);
  } finally {
    release();
  }
}

async function runStreamExperimentLocked(
  options: StreamExperimentOptions,
  outDir: string
): Promise<RunStreamsSummary> {
  const { manifest, runtime } = readManifest(options.manifestFile);
  const docker = options.docker ?? ["docker"];
  const human = gitHumanRepo(options.repoDir);
  const prefix = `pigeon-stream-${createHash("sha256").update(outDir).digest("hex").slice(0, 8)}`;
  const referenceName = `${prefix}-reference`;
  const modelId = options.gateway.modelId;
  // 路数大于各账号配置并发之和即拒绝开跑（决策 163）：在写身份头、起网关与容器之前
  assertConcurrencyFits(options.concurrency ?? 4, options.gateway.accounts);
  // 身份头（决策 147，修复审计"身份头、预算缺省与两种 agent 的参数"一节）：开跑前写入或比对，不一致即拒绝续跑——在起网关与容器之前做
  const imageId = imageIdOf(options.image, docker);
  const pigeonSettings =
    options.pigeon === undefined ? undefined : effectivePigeonSettings(options.pigeon, modelId);
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
    // 路数与账号数只记不比：换机器、加账号后可以续跑
    info: {
      concurrency: options.concurrency ?? 4,
      accounts: options.gateway.accounts.length,
      accountConcurrency: options.gateway.accounts.map((a) => a.concurrency),
      harness: currentHarnessRef(),
    },
  });
  const { gateway: liveGateway, limits } = await startGatewayAndLimits(
    options.gateway,
    options.concurrency ?? 4
  );
  const shutdown = options.shutdownSignal;
  if (shutdown !== undefined) {
    const onShutdown = () => limits.shutdown(String(shutdown.reason ?? "收到停止信号"));
    if (shutdown.aborted) onShutdown();
    else shutdown.addEventListener("abort", onShutdown, { once: true });
  }
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
      outDirLocked: true,
      manifest,
      runtime,
      human,
      envs: dockerStreamEnvs({
        image: options.image,
        human,
        prefix,
        docker,
        ...(options.containerRunArgs !== undefined ? { runArgs: options.containerRunArgs } : {}),
        ...(options.log !== undefined ? { log: options.log } : {}),
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
    limits.close();
  }
}

export interface StreamTrialExperimentOptions {
  manifestFile: string;
  repoDir: string;
  image: string;
  outDir: string;
  // 要试跑的步（清单里的步序）
  steps: readonly number[];
  conditions: readonly StreamCondition[];
  budget: StepBudget;
  concurrency: number;
  gateway: { accounts: readonly GatewayAccount[]; modelId: string };
  pigeon?: StreamPigeonOptions;
  minimalCommand?: readonly string[];
  containerRunArgs?: readonly string[];
  docker?: readonly string[];
  log?: (line: string) => void;
}

// 预算校准的试跑（147 修订）：与正式跑同一套网关、限额控制器、容器与两种 agent，只是每步各自从人在父提交上的代码起跑
export async function runStreamTrialExperiment(
  options: StreamTrialExperimentOptions
): Promise<StreamTrialSummary> {
  const outDir = path.resolve(options.outDir);
  const release = lockOutDir(outDir);
  try {
    return await runStreamTrialExperimentLocked(options, outDir);
  } finally {
    release();
  }
}

async function runStreamTrialExperimentLocked(
  options: StreamTrialExperimentOptions,
  outDir: string
): Promise<StreamTrialSummary> {
  const { manifest, runtime } = readManifest(options.manifestFile);
  const docker = options.docker ?? ["docker"];
  const human = gitHumanRepo(options.repoDir);
  const prefix = `pigeon-trial-${createHash("sha256").update(outDir).digest("hex").slice(0, 8)}`;
  const modelId = options.gateway.modelId;
  assertConcurrencyFits(options.concurrency, options.gateway.accounts);
  const { gateway: liveGateway, limits } = await startGatewayAndLimits(
    options.gateway,
    options.concurrency
  );
  try {
    const agents: Partial<Record<"pigeon" | "minimal", StepAgent>> = {};
    if (options.pigeon !== undefined) {
      agents.pigeon = pigeonStepAgent({
        ...streamPigeonOptions(options.pigeon),
        docker,
        streamFnFor: (baseUrl) => gatewayStreamFn(baseUrl, modelId),
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
    return await runStreamTrial({
      outDirLocked: true,
      manifest,
      human,
      runtime,
      steps: options.steps,
      conditions: options.conditions,
      budget: options.budget,
      concurrency: options.concurrency,
      outDir,
      envs: dockerStreamEnvs({
        image: options.image,
        human,
        prefix,
        docker,
        ...(options.containerRunArgs !== undefined ? { runArgs: options.containerRunArgs } : {}),
      }),
      agents,
      gateway: liveGateway,
      limits,
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
  } finally {
    await liveGateway.close();
    limits.close();
  }
}

// 起限额控制器与网关（互相引用：控制器探测经网关的上游，网关把限额信号交给控制器）。控制器按网关报来的可用容量
// 放行（决策 163），网关的容量一变即通知控制器；开跑前逐账号探测一次，未通过即关掉两者、拒绝开跑
async function startGatewayAndLimits(
  settings: { accounts: readonly GatewayAccount[]; modelId: string },
  concurrency: number
): Promise<{ gateway: ModelGateway; limits: LimitController }> {
  let gateway: ModelGateway | undefined;
  const limits = new LimitController({
    probe: () => gateway?.probe() ?? Promise.resolve(false),
    slots: concurrency,
    capacity: () => gateway?.capacity() ?? Number.POSITIVE_INFINITY,
  });
  gateway = await startModelGateway({
    upstreamBaseUrl: await gatewayUpstreamBaseUrl(settings.modelId),
    accounts: settings.accounts,
    limits,
    probeRequest: {
      path: "/v1/messages",
      body: {
        model: settings.modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "回一个字" }],
      },
    },
  });
  gateway.subscribeCapacity(() => limits.capacityChanged());
  try {
    await gateway.preflight();
  } catch (error) {
    await gateway.close();
    limits.close();
    throw error;
  }
  return { gateway, limits };
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

// 停止信号的硬时限：低于 systemd 单元的 TimeoutStopSec（120 秒），在它发 SIGKILL 之前自行退出
export const SHUTDOWN_GRACE_MS = 90_000;

// SIGTERM（systemd 停服或整机关机）：第一次交给 stop 收尾（在途的步作废、不再取新步），并设硬时限——正在判题或测量的步
// 到时收不完即直接退出，与进程崩溃同一续跑口径（结果行写在流历史与会话清单之后，断点仍指向上一个完成步）；再收到一次
// 即立即退出。返回卸下处理器的函数
export function installTerminationHandler(
  target: NodeJS.EventEmitter,
  stop: (reason: string) => void,
  exit: (code: number) => void,
  graceMs = SHUTDOWN_GRACE_MS
): () => void {
  let timer: NodeJS.Timeout | undefined;
  const onTerm = () => {
    if (timer !== undefined) {
      exit(143);
      return;
    }
    stop("收到 SIGTERM：在途的步作废，跑批停下（已完成的步保留，之后在同一输出目录续跑）");
    timer = setTimeout(() => exit(143), graceMs);
    timer.unref();
  };
  target.on("SIGTERM", onTerm);
  return () => {
    target.off("SIGTERM", onTerm);
    if (timer !== undefined) clearTimeout(timer);
  };
}
