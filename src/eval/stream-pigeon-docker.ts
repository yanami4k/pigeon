// 对比评测的 Pigeon 容器条件（决策 380、385、389、390；条件名 pigeon-docker）：Pigeon 的打包产物（dist/）以只读方式
// 挂进题目容器，在容器里跑产品缺省的 pigeon run --yolo --no-web --json，思考档位显式给 high（决策 390：产品缺省改为
// 开思考的施工另有一段，合并前由启动参数显式给出，合并后两者一致）；模型经只通网关的跑批内部网络（与外部 agent 条件
// 同一网络档，gateway-network.ts），自带 DeepSeek 接入产物（dist/deepseek-stream-fn.mjs）的端点根由
// DEEPSEEK_BASE_URL 指到本作业的网关地址。实验镜像没有 node：Node 运行时（官方 Linux x64 构建）同样只读挂载进容器，
// 不改镜像身份（与人的基准缓存同一道理，工具目录只读挂载的先例）。
//   治理根与工作区分开：--governance-root 指到容器里的独立挂载点（宿主侧即作业目录下的 .pigeon/，挂载到容器
//     /pigeon-gov/.pigeon）。设置三层与项目 .mcp.json 锚在治理根——题目仓库自带的 .pigeon/ 设置不生效（隔离），
//     程序状态（会话、检索缓存等）不落工作区、不进 diff 与判题；用户级目录由 HOME 指到每步新建的空目录隔离。
//   会话跨题保留（决策 389）：治理根的宿主侧就是作业目录下的 .pigeon/，跑批器现成的每步会话清单（sessions-<seq>.json）、
//     作废移出（quarantineSessions）与续跑恢复原样生效——同一作业（流 × 条件 × 遍次）内后面的题能检索到前面题的
//     会话，作业之间互不相通，作废的题的会话按现有规矩移出。
//   工作方式指令（STREAM_WORK_DIRECTIVE）与提示拼成任务文本（指令在前、空行相接）：CLI 没有单独的指令入口，与
//     启动器协议里 directive 交给启动器组合同一做法。
//   终态判定与进程内条件同一口径（stream-agents.ts 的 pigeonStepAgent）：内容审核拒答与确定性错误照常判题；空回复
//     异常结束（决策 170 ②）照常判题；其余以错误收尾的算模型服务故障，这一步作废重做。没有结果 JSON（装配或启动
//     失败）同样作废重做（不计数信号类，连续裸打断到上限即停作业）。
//   产物：每步把容器里的运行目录（结果 JSON、标准错误、提示文本）拷到作业目录
//     pigeon-docker/step-<步序>/try-<第几次>/io/，提示文本另由宿主写一份可信副本；重做取下一个没用过的序号。
// 身份：agents.pigeonDocker 记打包产物摘要、自报的版本（产品与 Node 运行时）与逐项设置（与现有各段同一规则：
//   不进身份摘要，续跑时两边都记了才比对）。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  dockerOnce,
  removeWorkspaceContainer,
  startWorkspaceContainer,
  trustedShell,
} from "../execution/container-host.ts";
import { GATEWAY_PLACEHOLDER_KEY } from "../pi-runtime/index.ts";
import { PIGEON_DIR, projectPigeonDir } from "../state/paths.ts";
import {
  type CommandStepAgentOptions,
  clearMarkedProcesses,
  STREAM_WORK_DIRECTIVE,
  superviseLauncher,
} from "./stream-agents.ts";
import { deterministicErrorOf, isContentRefusal } from "./stream-errors.ts";
import {
  EXTERNAL_GRACE_MS,
  EXTERNAL_NETWORK_PROFILE,
  parseSelfReport,
  readLauncherResult,
  toolDirDigest,
} from "./stream-external.ts";
import { type StreamJobId, ZERO_USAGE } from "./stream-results.ts";
import { jobDirName, type StepAgent, type StepAgentResult } from "./stream-runner.ts";

// 条件名与 agent 键（内置条件，见 stream-results.ts 的 STREAM_CONDITIONS 与 stream-runner.ts 的 CONDITION_SPECS）
export const PIGEON_DOCKER_CONDITION = "pigeon-docker";
// 打包产物（dist/）在容器里的挂载点（只读）
export const PIGEON_BUNDLE_MOUNT = "/opt/pigeon-bundle";
// Node 运行时（实验镜像没有 node）在容器里的挂载点（只读）：宿主目录含 bin/node（官方 Linux x64 构建）
export const PIGEON_NODE_MOUNT = "/opt/pigeon-node";
// 治理根在容器里的位置：宿主作业目录的 .pigeon/ 挂在它的 .pigeon 上
export const PIGEON_GOV_ROOT = "/pigeon-gov";
// 容器里的运行目录：prompt.txt（宿主写入）、result.json、stderr.txt、home/（每步新建的空用户级目录）
export const PIGEON_RUN_IO_DIR = "/tmp/pigeon-run-io";

// 挂载来源路径原样拼进 docker 的 --mount：逗号、引号与换行会改变挂载参数的含义，一律拒绝（与工具目录同一规则）
function assertMountable(p: string, what: string): void {
  if (/[,"'\r\n]/.test(p)) throw new Error(`${what}不得含逗号、引号或换行：${p}`);
}

// Node 运行时目录的校验：须含 bin/node（官方 Linux x64 构建解开后的样子）
export function assertNodeRuntimeDir(dir: string): void {
  if (!existsSync(path.join(dir, "bin", "node"))) {
    throw new Error(`Node 运行时目录 ${dir} 里没有 bin/node（解开官方 Linux x64 构建）`);
  }
}

// 作业容器参数（代替 --network none）：接跑批内部网络、只读挂载打包产物与 Node 运行时、读写挂载作业的治理目录。
// 治理目录为宿主作业目录下的 .pigeon/（跑批器的会话清单、作废移出与续跑都按这个布局工作）；治理目录由调用方建好
export function pigeonDockerContainerArgs(input: {
  bundleDir: string;
  nodeRuntimeDir: string;
  governanceDir: string;
  networkName: string;
}): string[] {
  const bundleDir = path.resolve(input.bundleDir);
  const nodeRuntimeDir = path.resolve(input.nodeRuntimeDir);
  const governanceDir = path.resolve(input.governanceDir);
  assertMountable(bundleDir, "打包产物目录 ");
  assertMountable(nodeRuntimeDir, "Node 运行时目录 ");
  assertMountable(governanceDir, "治理目录 ");
  return [
    "--network",
    input.networkName,
    "--mount",
    `type=bind,source=${bundleDir},target=${PIGEON_BUNDLE_MOUNT},readonly`,
    "--mount",
    `type=bind,source=${nodeRuntimeDir},target=${PIGEON_NODE_MOUNT},readonly`,
    "--mount",
    `type=bind,source=${governanceDir},target=${PIGEON_GOV_ROOT}/${PIGEON_DIR}`,
  ];
}

// 一个作业的容器参数：治理目录 = 宿主作业目录下的 .pigeon/（跑批器的会话清单、作废移出与续跑都按这个布局
// 工作——sessionsDirOf(作业目录) 即其下的 state/sessions）；目录在此建好（bind 挂载要求来源存在）
export function pigeonDockerJobContainerArgs(input: {
  outDir: string;
  job: StreamJobId;
  bundleDir: string;
  nodeRuntimeDir: string;
  networkName: string;
}): string[] {
  const governanceDir = projectPigeonDir(path.join(input.outDir, "streams", jobDirName(input.job)));
  mkdirSync(governanceDir, { recursive: true });
  return pigeonDockerContainerArgs({
    bundleDir: input.bundleDir,
    nodeRuntimeDir: input.nodeRuntimeDir,
    governanceDir,
    networkName: input.networkName,
  });
}

// 身份段（记在 agents.pigeonDocker）：打包产物摘要（不记宿主路径）、自报的版本（产品与 Node 运行时）、逐项设置
export function pigeonDockerIdentity(
  bundleDir: string,
  selfReported: unknown
): Record<string, unknown> {
  return {
    bundleDigest: toolDirDigest(bundleDir),
    bundleMount: PIGEON_BUNDLE_MOUNT,
    // Node 运行时只记挂载点与自报版本（目录大，不取摘要）
    nodeMount: PIGEON_NODE_MOUNT,
    network: EXTERNAL_NETWORK_PROFILE,
    selfReported,
    settings: {
      command: "pigeon run --yolo --no-web --json --thinking high",
      thinking: "high",
      // 开思考后服务端不接受温度参数：未下发
      temperature: null,
      // 未配置：跟模型上限走（决策 347 的口径）
      maxOutputTokens: null,
      // 产品缺省开；决策 389：同一作业（流 × 条件 × 遍次）跨题保留，作业之间互不相通
      sessionSearch: true,
      sessionRetention: "per-job",
      // 产品缺省（无人值守不注册写记忆工具，只推送）
      pushedMemory: true,
      // 产品缺省：容器里是本机执行端，worker 用容器内仓库的 git 工作树
      spawnWorkers: true,
      loopGuard: true,
      taskList: true,
      webTools: false,
      yolo: true,
      // 治理根与工作区分开：题目仓库自带的 .pigeon/ 设置与 .mcp.json 不生效
      projectSettings: "ignored",
    },
  };
}

// 在实验镜像的一次性容器里（断网、只读挂载打包产物与 Node 运行时）取 pigeon --version 与 node --version 的自报
export async function pigeonDockerSelfReport(input: {
  bundleDir: string;
  nodeRuntimeDir: string;
  image: string;
  container: string;
  docker?: readonly string[];
  runArgs?: readonly string[];
}): Promise<unknown> {
  const docker = input.docker ?? ["docker"];
  await removeWorkspaceContainer(input.container, docker);
  try {
    await startWorkspaceContainer({
      image: input.image,
      name: input.container,
      docker,
      runArgs: [
        "--network",
        "none",
        "--mount",
        `type=bind,source=${path.resolve(input.bundleDir)},target=${PIGEON_BUNDLE_MOUNT},readonly`,
        "--mount",
        `type=bind,source=${path.resolve(input.nodeRuntimeDir)},target=${PIGEON_NODE_MOUNT},readonly`,
        ...(input.runArgs ?? []),
      ],
    });
    const pigeon = await dockerOnce(
      docker,
      [
        "exec",
        input.container,
        `${PIGEON_NODE_MOUNT}/bin/node`,
        `${PIGEON_BUNDLE_MOUNT}/pigeon.mjs`,
        "--version",
      ],
      120_000
    );
    const node = await dockerOnce(
      docker,
      ["exec", input.container, `${PIGEON_NODE_MOUNT}/bin/node`, "--version"],
      60_000
    );
    return {
      pigeon: pigeon.exitCode === 0 ? parseSelfReport(pigeon.stdout.toString("utf8")) : null,
      node: node.exitCode === 0 ? parseSelfReport(node.stdout.toString("utf8")) : null,
    };
  } catch {
    return null;
  } finally {
    await removeWorkspaceContainer(input.container, docker).catch(() => {});
  }
}

// 这一步的产物在宿主作业目录下的位置：pigeon-docker/step-<步序>/try-<第几次>，重做取下一个没用过的序号。
// 其下 prompt.txt 为宿主写的可信副本，io/ 为从容器拷出的运行目录（结果与标准错误，不可信）
export function pigeonDockerArtifactsDir(workDir: string, seq: number): string {
  const stepDir = path.join(workDir, "pigeon-docker", `step-${seq}`);
  mkdirSync(stepDir, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = path.join(stepDir, `try-${n}`);
    if (!existsSync(dir)) {
      mkdirSync(dir);
      return dir;
    }
  }
}

// 在容器里准备运行目录（以 root 建好、放开写权限给镜像的用户），写入提示文件；home/ 为每步新建的空用户级目录
const PREPARE_IO = [
  'd="$1"',
  'rm -rf -- "$d"',
  'mkdir -p -- "$d/home"',
  'cat > "$d/prompt.txt"',
  'chmod 0777 -- "$d" "$d/home"',
  'chmod 0644 -- "$d/prompt.txt"',
].join(" && ");

// 运行命令：提示从文件读（不经参数，避免长度与转义问题），结果与标准错误落运行目录；$1 工作区根、$2 治理根
const RUN_PIGEON = [
  `cd -- "$1"`,
  `${PIGEON_NODE_MOUNT}/bin/node ${PIGEON_BUNDLE_MOUNT}/pigeon.mjs run --yolo --no-web --json --thinking high \\`,
  `  --root "$1" --governance-root "$2" \\`,
  `  --stream-fn ${PIGEON_BUNDLE_MOUNT}/deepseek-stream-fn.mjs \\`,
  `  < "${PIGEON_RUN_IO_DIR}/prompt.txt" > "${PIGEON_RUN_IO_DIR}/result.json" 2> "${PIGEON_RUN_IO_DIR}/stderr.txt"`,
].join("\n");

export interface PigeonDockerStepAgentOptions {
  // 打包产物目录（dist/，含 pigeon.mjs、pigeon-cli.mjs 与 deepseek-stream-fn.mjs）
  bundleDir: string;
  docker?: readonly string[];
  // 墙钟之外给收尾的余量（缺省 30 秒）
  graceMs?: number;
  limits?: CommandStepAgentOptions["limits"];
}

interface RunResultJson {
  status?: unknown;
  turns?: unknown;
  usage?: { input?: unknown; output?: unknown; totalTokens?: unknown };
  failure?: { category?: unknown } | null;
  errorMessage?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function pigeonDockerStepAgent(options: PigeonDockerStepAgentOptions): StepAgent {
  const docker = options.docker ?? ["docker"];
  const [program = "docker", ...pre] = docker;
  return {
    async run(input): Promise<StepAgentResult> {
      const container = input.target.container;
      const root = input.target.root;
      const marker = `pigeon-step-${randomBytes(8).toString("hex")}`;
      // 工作方式指令与提示拼成任务文本（指令在前、空行相接）：CLI 没有单独的指令入口
      const prompt = `${STREAM_WORK_DIRECTIVE}\n\n${input.prompt}`;
      const prepared = await dockerOnce(
        docker,
        ["exec", "-i", "-u", "0", container, ...trustedShell(PREPARE_IO, PIGEON_RUN_IO_DIR)],
        60_000,
        prompt
      );
      if (prepared.exitCode !== 0) {
        throw new Error(`pigeon-docker 的提示写不进容器：${prepared.stderr.trim()}`);
      }
      const env: Record<string, string> = {
        // 用户级目录指到每步新建的空目录：容器镜像家目录里的用户级设置与状态不生效
        HOME: `${PIGEON_RUN_IO_DIR}/home`,
        DEEPSEEK_BASE_URL: input.modelBaseUrl ?? "",
        DEEPSEEK_API_KEY: GATEWAY_PLACEHOLDER_KEY,
        PIGEON_STEP_MARKER: marker,
      };
      const started = Date.now();
      const ended = await superviseLauncher({
        program,
        args: [
          ...pre,
          "exec",
          "-w",
          root,
          ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          container,
          ...trustedShell(RUN_PIGEON, root, PIGEON_GOV_ROOT),
        ],
        budgetMs: input.budget.wallClockMs + (options.graceMs ?? EXTERNAL_GRACE_MS),
        limits: options.limits,
        abortSignal: input.abortSignal,
        label: "pigeon-docker 的容器内运行",
      });
      // 墙钟只算运行本身（拷产物之前取）
      const wallMs = Date.now() - started;
      // 不论怎么结束，先清掉容器里的进程（docker exec 客户端被杀时容器里的进程不随之退出）
      const cleared = await clearMarkedProcesses(docker, container, marker, root);
      // 运行目录拷到宿主作业目录的 io/ 下；提示另由宿主写一份可信副本；重做不覆盖
      const outDir = pigeonDockerArtifactsDir(input.workDir, input.step.seq);
      writeFileSync(path.join(outDir, "prompt.txt"), prompt);
      const ioDir = path.join(outDir, "io");
      mkdirSync(ioDir);
      await dockerOnce(docker, ["cp", `${container}:${PIGEON_RUN_IO_DIR}/.`, ioDir], 300_000);
      if (!cleared) {
        return {
          status: "aborted",
          turns: 0,
          usage: ZERO_USAGE,
          wallMs,
          interrupted: "pigeon-docker 在容器里的进程清理不净：这一步作废",
        };
      }
      if (ended === "paused") {
        return {
          status: "aborted",
          turns: 0,
          usage: ZERO_USAGE,
          wallMs,
          interrupted:
            input.abortSignal?.aborted === true
              ? "跑批器按步中止（排队超时等）：pigeon-docker 已中止"
              : "限额信号：pigeon-docker 已中止",
        };
      }
      if (ended === "timeout") {
        return { status: "wall-clock-limit", turns: 0, usage: ZERO_USAGE, wallMs };
      }
      const parsed = readLauncherResult(path.join(ioDir, "result.json"));
      if (parsed === undefined) {
        // 没有结果 JSON：装配或启动失败（参数、接入模块、设置确认等），stderr 在产物里；作废重做，连续裸打断到上限即停
        return {
          status: "aborted",
          turns: 0,
          usage: ZERO_USAGE,
          wallMs,
          interrupted: "pigeon-docker 没有写出结果 JSON（装配或启动失败；标准错误见这一步的产物）",
        };
      }
      const raw = parsed as RunResultJson;
      const status = typeof raw.status === "string" ? raw.status : "unknown";
      const errorMessage = typeof raw.errorMessage === "string" ? raw.errorMessage : undefined;
      // 与进程内条件同一判法：内容审核拒答与确定性错误照常判分；空回复异常结束（决策 170 ②）照常判题；
      // 其余以错误收尾的算模型服务故障，这一步作废重做
      const refused = status === "failed" && isContentRefusal(errorMessage);
      const deterministic =
        status === "failed" && !refused ? deterministicErrorOf(errorMessage) : undefined;
      const providerFailed =
        status !== "empty-reply" &&
        !refused &&
        deterministic === undefined &&
        (raw.failure?.category === "infrastructure" || status === "failed");
      return {
        status,
        turns: num(raw.turns),
        usage: {
          ...ZERO_USAGE,
          input: num(raw.usage?.input),
          output: num(raw.usage?.output),
          totalTokens: num(raw.usage?.totalTokens),
        },
        wallMs,
        ...(providerFailed
          ? { interrupted: `模型服务故障（终态 ${status}）：${errorMessage ?? ""}` }
          : {}),
      };
    },
  };
}
