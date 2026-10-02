// 提交流实验的装配（第三至六节；193 固定起点）：读流清单，按仓库选运行方式，起一个装有人的完整历史的参考容器算全量测量的
// 基准，按条件接入 agent，交给跑批器；结束后移除参考容器。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { removeWorkspaceContainer, startWorkspaceContainer } from "../execution/container-host.ts";
import { MEMORY_TEXT_VERSION } from "../memory/learned.ts";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_THINKING_LEVEL,
  GATEWAY_PROVIDER,
  GATEWAY_UPSTREAM_BASE_URL,
  gatewayStreamFn,
  resolveCompactionConfig,
} from "../pi-runtime/index.ts";
import { DEFAULT_MEMORY_LIMITS } from "../state/memory-config.ts";
import { WORKSPACE_NETWORK_ARGS } from "./container-workspace.ts";
import {
  assertConcurrencyFits,
  type GatewayAccount,
  type ModelGateway,
  startModelGateway,
} from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";
import {
  commandStepAgent,
  type PigeonStepAgentOptions,
  pigeonStepAgent,
  STREAM_LOOP_GUARD,
  STREAM_SCRIPT_ORCHESTRATION,
  STREAM_SPAWN_WORKERS,
  STREAM_TASK_LIST,
  STREAM_WEB_TOOLS,
} from "./stream-agents.ts";
import {
  type BaselineCheck,
  type BaselineSummary,
  baselineTargets,
  type ClassesSummary,
  classTargets,
  computeBaselines,
  computeClasses,
} from "./stream-baseline.ts";
import { gitHumanRepo, type HumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { STREAM_RUNTIMES } from "./stream-generate.ts";
import { currentHarnessRef } from "./stream-harness.ts";
import {
  checkOrWriteIdentity,
  type HarnessAllowance,
  manifestDigestOf,
  readStoredIdentity,
  type TaskSelection,
} from "./stream-identity.ts";
import {
  chainedTasks,
  DEFAULT_TASK_PROMPT_FORMAT,
  type StreamManifest,
  TASK_CHAIN_SCOPE,
  TASK_PROMPT_LAYOUT,
  type TaskPromptFormat,
} from "./stream-manifest.ts";
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
  selectSteps,
} from "./stream-runner.ts";
import { CALIBRATION_SEED, sampleTasks } from "./stream-sample.ts";
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
  attempts?: number;
  concurrency?: number;
  maxSteps?: number;
  // 选题（202、219 校准）：给定题号，或按种子抽样（只在要做到的用例不为零的题中抽，需两类用例已预计算）；都不给即全部
  tasks?: readonly number[];
  sample?: { k: number; seed?: number };
  budget: StepBudget;
  // 题面格式（198、213）：缺省给测试文件路径；给用例名时名单为这一步要做到的用例
  promptFormat?: TaskPromptFormat;
  // 各条件的模型请求都经跑批进程内置的网关（决策 155）：真 key 只在网关里；spendLimitCny 为花费上限（人民币元，
  // 决策 235），缺省不设
  gateway: { accounts: readonly GatewayAccount[]; modelId: string; spendLimitCny?: number };
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
  // 代码版本的显式放行（269）：续跑时代码版本不符的放行原因、首次开跑时放行未提交改动；缺省都不放行
  harnessAllowance?: HarnessAllowance;
}

export type StreamPigeonOptions = Omit<PigeonStepAgentOptions, "streamFn" | "streamFnFor" | "yolo">;

// 延续式跑批无人值守：Pigeon 各条件一律放权（yolo），不依赖调用方记得传——没有审批通道时，prompt 档的写与执行
// 一律被拒，条件就不再是"完整 Pigeon"
export function streamPigeonOptions(
  pigeon: StreamPigeonOptions
): Omit<PigeonStepAgentOptions, "streamFn" | "streamFnFor"> {
  return { ...pigeon, yolo: true };
}

// Pigeon 条件实际生效的参数（身份头与结果行照记）：没给的推理档位、单轮输出上限、压缩配置与记忆上限记运行时的
// 缺省值（off、16,384、产品缺省的压缩配置、项目级记忆上限 4,000 字符），不记 null；温度没给即由服务端决定，记 null。
// 复盘随决策 331 删除，身份头不再记复盘模板版本与复盘上限，改记记忆文字的版本（之前写下的身份头与之不同，续跑即判为不同）
export function effectivePigeonSettings(pigeon: StreamPigeonOptions, modelId: string) {
  return {
    provider: pigeon.provider ?? GATEWAY_PROVIDER,
    modelId: pigeon.modelId ?? modelId,
    temperature: pigeon.temperature ?? null,
    thinking: pigeon.thinking ?? DEFAULT_THINKING_LEVEL,
    maxOutputTokens: pigeon.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    compaction: resolveCompactionConfig(pigeon.compaction),
    memoryLimitChars: pigeon.memoryLimitChars ?? DEFAULT_MEMORY_LIMITS.project,
    // 决策 328、332：推送段的文字版本（文字一改即换条件，续跑判为不同）
    memoryTextVersion: MEMORY_TEXT_VERSION,
    // 决策 265：主 agent 派 worker 在各条件里的实际生效值
    spawnWorkers: STREAM_SPAWN_WORKERS,
    // 决策 291 与 265 的先例：联网工具在各条件里的实际生效值（关）
    webTools: STREAM_WEB_TOOLS,
    // 决策 279：取用 worker 改动的工具与派 worker 同槽，同一个生效值
    takeWorker: STREAM_SPAWN_WORKERS,
    // 决策 297：等待、状态、发消息、停止四件编排积木与派 worker 同槽，同一个生效值
    workerTools: STREAM_SPAWN_WORKERS,
    // 决策 294 B1：任务清单工具在各条件里的实际生效值（关）
    taskList: STREAM_TASK_LIST,
    // 决策 308：打转检测在各条件里的实际生效值（关）
    loopGuard: STREAM_LOOP_GUARD,
    // 决策 309：提交编排脚本的工具在各条件里的实际生效值（关）
    scriptOrchestration: STREAM_SCRIPT_ORCHESTRATION,
  };
}

// 镜像的身份：按镜像的内容层——RootFS 各层摘要的有序列表——取摘要（各层摘要按顺序以换行相接，取 SHA-256），不看本地镜像
// ID：经典存储下镜像 ID 为 config 摘要，containerd 镜像存储下取到的是 manifest 摘要，同一个镜像在两种存储、两台机器上 ID
// 不同，内容层相同。也不用可变的标签——同一标签重建后内容层即变，已落盘的人的基准不再复用
export function layersIdentity(layers: readonly string[]): string {
  if (layers.length === 0) throw new Error("镜像没有内容层");
  return `layers:sha256:${createHash("sha256").update(layers.join("\n")).digest("hex")}`;
}

export function imageIdentityOf(image: string, docker: readonly string[]): string {
  const [program = "docker", ...pre] = docker;
  const out = execFileSync(
    program,
    [...pre, "image", "inspect", "--format", "{{json .RootFS.Layers}}", image],
    { encoding: "utf8" }
  ).trim();
  let layers: unknown;
  try {
    layers = JSON.parse(out);
  } catch {
    layers = undefined;
  }
  if (!Array.isArray(layers) || !layers.every((l) => typeof l === "string")) {
    throw new Error(`取不到镜像 ${image} 的内容层：${out.slice(0, 200)}`);
  }
  return layersIdentity(layers);
}

// 最简 agent 的版本与实际生效的模型参数：由启动器自己报（run_mini.py --identity，含它覆盖后的输出上限、温度与思考开关），
// 取不到的项记 null，照实
function miniIdentityOf(command: readonly string[]): {
  miniSweAgent: string | null;
  litellm: string | null;
  modelKwargs: Record<string, unknown> | null;
} {
  const [program = "python", ...args] = command;
  try {
    // mini-swe-agent 导入时会在标准输出打横幅，结果取最后一个非空行
    const out = execFileSync(program, [...args, "--identity"], {
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

export function readManifest(file: string): {
  manifest: StreamManifest;
  runtime: StreamRepoRuntime;
} {
  const manifest = JSON.parse(readFileSync(file, "utf8")) as StreamManifest;
  const runtimeName = RUNTIME_BY_REPO[manifest.repo];
  const runtime = runtimeName === undefined ? undefined : STREAM_RUNTIMES[runtimeName];
  if (runtime === undefined) throw new Error(`清单的仓库 ${manifest.repo} 没有对应的运行方式`);
  return { manifest, runtime };
}

// 选题（202、219）：给题号即按题号；抽样只在要做到的用例不为零的题中抽，要求全部题的两类用例都已预计算（只读落盘结果，
// 不现算），缺了即拒绝并说明；两者都给即拒绝。都不给为全部
export function resolveTaskSelection(
  manifest: StreamManifest,
  reference: Pick<ReferenceCases, "cachedClasses">,
  options: Pick<StreamExperimentOptions, "tasks" | "sample">
): TaskSelection {
  if (options.tasks !== undefined && options.sample !== undefined) {
    throw new Error("题号列表与抽样只能二选一");
  }
  if (options.tasks !== undefined) return { method: "list", tasks: [...options.tasks] };
  if (options.sample === undefined) return { method: "all" };
  const counts = new Map<string, number>();
  const missing: number[] = [];
  chainedTasks(manifest).forEach((step, i) => {
    const classes = reference.cachedClasses(step);
    if (classes === undefined) missing.push(i + 1);
    else counts.set(step.commit, classes.failToPass.length);
  });
  if (missing.length > 0) {
    throw new Error(
      `抽样要先算好全部题的两类用例，还缺 ${missing.length} 道（题号 ${missing.slice(0, 20).join(",")}${missing.length > 20 ? "…" : ""}）：先用 eval stream-baseline --check classes 预计算`
    );
  }
  return sampleTasks(
    manifest,
    (step) => counts.get(step.commit) ?? 0,
    options.sample.k,
    options.sample.seed ?? CALIBRATION_SEED
  );
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
  const promptFormat = options.promptFormat ?? DEFAULT_TASK_PROMPT_FORMAT;
  const { manifest, runtime } = readManifest(options.manifestFile);
  const docker = options.docker ?? ["docker"];
  const human = gitHumanRepo(options.repoDir);
  const prefix = `pigeon-stream-${createHash("sha256").update(outDir).digest("hex").slice(0, 8)}`;
  const referenceName = `${prefix}-reference`;
  const modelId = options.gateway.modelId;
  // 路数大于各账号配置并发之和即拒绝开跑（决策 163）：在写身份头、起网关与容器之前
  assertConcurrencyFits(options.concurrency ?? 4, options.gateway.accounts);
  // 身份头（决策 147，修复审计"身份头、预算缺省与两种 agent 的参数"一节）：开跑前写入或比对，不一致即拒绝续跑——在起网关与容器之前做
  const imageId = imageIdentityOf(options.image, docker);
  // 参考工作区的容器开跑时才起；选题只读已落盘的两类用例，用不到容器
  const referenceWs = new ReferenceWorkspace(
    dockerStreamShell({ container: referenceName, root: STREAM_CONTAINER_ROOT, docker })
  );
  const reference = new ReferenceCases({
    reference: referenceWs,
    runtime,
    human,
    image: imageId,
    cacheDir:
      options.baselineDir !== undefined
        ? path.resolve(options.baselineDir)
        : path.join(outDir, "reference"),
  });
  const taskSelection = resolveTaskSelection(manifest, reference, options);
  const tasks = taskSelection.method === "all" ? undefined : taskSelection.tasks;
  // 题号越界、重复即在写身份头之前拒绝
  selectSteps(manifest, { tasks, maxSteps: options.maxSteps });
  const pigeonSettings =
    options.pigeon === undefined ? undefined : effectivePigeonSettings(options.pigeon, modelId);
  const miniSettings =
    options.minimalCommand === undefined
      ? undefined
      : { model: modelId, ...miniIdentityOf(options.minimalCommand) };
  mkdirSync(outDir, { recursive: true });
  // 代码版本只取一次：身份头比对的与结果行记的是同一个
  const harness = currentHarnessRef();
  const runIdentity = checkOrWriteIdentity(
    outDir,
    {
      core: {
        repo: manifest.repo,
        manifestDigest: manifestDigestOf(options.manifestFile),
        image: imageId,
        budget: options.budget,
        conditions: [...options.conditions],
        stepScope: TASK_CHAIN_SCOPE,
        promptFormat,
        promptLayout: TASK_PROMPT_LAYOUT,
        taskSelection,
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
        harness,
      },
    },
    undefined,
    // 代码版本不符（续跑）或认不出（首次开跑）即拒绝，除非显式放行（269）
    options.harnessAllowance
  );
  const storedIdentity = readStoredIdentity(outDir);
  const { gateway: liveGateway, limits } = await startGatewayAndLimits(
    options.gateway,
    options.concurrency ?? 4,
    path.join(outDir, GATEWAY_SPEND_FILE)
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
    await referenceWs.init(human.bundle(manifest.rangeEnd), manifest.rangeEnd);
    const agents: Partial<Record<"pigeon" | "minimal", StepAgent>> = {};
    if (options.pigeon !== undefined) {
      agents.pigeon = pigeonStepAgent({
        ...streamPigeonOptions(options.pigeon),
        docker,
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
      reference,
      outDir,
      conditions: options.conditions,
      budget: options.budget,
      promptFormat,
      harnessRef: harness,
      limits,
      gateway: liveGateway,
      runIdentity,
      // 报告的设置一节：开跑时的代码与显式放行的代码更换（269）
      ...(storedIdentity !== undefined ? { reportIdentity: storedIdentity } : {}),
      agentSettings: {
        ...(pigeonSettings !== undefined ? { pigeon: pigeonSettings } : {}),
        ...(miniSettings !== undefined ? { minimal: miniSettings } : {}),
      },
      ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(tasks !== undefined ? { tasks } : {}),
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
  } finally {
    await removeWorkspaceContainer(referenceName, docker).catch(() => {});
    await liveGateway.close();
    limits.close();
  }
}

// 网关花费累计的落盘文件（在输出目录下）：续跑时接着累计
export const GATEWAY_SPEND_FILE = "gateway-spend.json";

// 起限额控制器与网关（互相引用：控制器探测经网关的上游，网关把限额信号交给控制器）。控制器按网关报来的可用容量
// 放行（决策 163），网关的容量一变即通知控制器；开跑前逐账号探测一次，未通过即关掉两者、拒绝开跑
export async function startGatewayAndLimits(
  settings: { accounts: readonly GatewayAccount[]; modelId: string; spendLimitCny?: number },
  concurrency: number,
  spendFile?: string
): Promise<{ gateway: ModelGateway; limits: LimitController }> {
  let gateway: ModelGateway | undefined;
  const limits = new LimitController({
    probe: () => gateway?.probe() ?? Promise.resolve(false),
    slots: concurrency,
    capacity: () => gateway?.capacity() ?? Number.POSITIVE_INFINITY,
  });
  gateway = await startModelGateway({
    upstreamBaseUrl: GATEWAY_UPSTREAM_BASE_URL,
    accounts: settings.accounts,
    limits,
    // 探测：max_tokens 1、关思考（不发 thinking 时 DeepSeek 默认开思考，只回一个思考块），探针实测 200
    probeRequest: {
      path: "/v1/messages",
      body: {
        model: settings.modelId,
        max_tokens: 1,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "回一个字" }],
      },
    },
    spend: {
      ...(spendFile !== undefined ? { file: spendFile } : {}),
      ...(settings.spendLimitCny !== undefined ? { limitCny: settings.spendLimitCny } : {}),
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

// 起 N 个参考容器（与作业的参考容器分开），交给 work 分摊，结束后移除
async function withBaselineReferences<T>(
  options: StreamBaselineOptions,
  work: (input: {
    manifest: StreamManifest;
    runtime: StreamRepoRuntime;
    human: HumanRepo;
    outDir: string;
    references: ReferenceCases[];
  }) => Promise<T>
): Promise<T> {
  const { manifest, runtime } = readManifest(options.manifestFile);
  const docker = options.docker ?? ["docker"];
  const outDir = path.resolve(options.outDir);
  const human = gitHumanRepo(options.repoDir);
  const prefix = `pigeon-stream-${createHash("sha256").update(outDir).digest("hex").slice(0, 8)}`;
  const lanes = Math.max(1, options.concurrency ?? 1);
  const names = Array.from({ length: lanes }, (_, i) => `${prefix}-baseline-${i + 1}`);
  const imageId = imageIdentityOf(options.image, docker);
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
        return new ReferenceCases({
          reference: ws,
          runtime,
          human,
          cacheDir: outDir,
          image: imageId,
        });
      })
    );
    return await work({ manifest, runtime, human, outDir, references });
  } finally {
    for (const name of names) await removeWorkspaceContainer(name, docker).catch(() => {});
  }
}

// 提前单独算人的基准：按提交分摊到各路参考容器
export function runStreamBaselines(options: StreamBaselineOptions): Promise<BaselineSummary> {
  return withBaselineReferences(options, ({ manifest, runtime, human, references }) =>
    computeBaselines({
      targets: baselineTargets({
        manifest,
        human,
        runtime,
        ...(options.streams !== undefined ? { streams: options.streams } : {}),
      }),
      references,
      check: options.check ?? "both",
      gateCommand: gateFromSteps(runtime.verifySteps),
      ...(options.log !== undefined ? { log: options.log } : {}),
    })
  );
}

// 两类用例的汇总文件（基准目录下）：每道题两类用例的条数，供选题核对与事后分析
export const CLASSES_SUMMARY_FILE = "classes-summary.json";

// 预计算两类用例（214）：全部题（清单里的题按时间接成的流）按题分摊到各路参考容器；同一目录重跑即续算。
// 结束后写汇总文件
export function runStreamClasses(options: StreamBaselineOptions): Promise<ClassesSummary> {
  return withBaselineReferences(options, async ({ manifest, outDir, references }) => {
    const summary = await computeClasses({
      targets: classTargets(manifest),
      references,
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
    writeFileSync(
      path.join(outDir, CLASSES_SUMMARY_FILE),
      `${JSON.stringify(summary, null, 2)}
`
    );
    return summary;
  });
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
