// 跑批器的外部 agent 条件（实验设施）：让一个外部 agent 的进程在题目容器里对着工作区干活，经只通网关的跑批内部网络
// （gateway-network.ts）只连模型网关，其余照跑批器现有流程判题。仓库里只有通用接口与测试用的假启动器。
//   定义：宿主上的一个 JSON 配置文件——名字（条件名为 ext-<名字>）、工具目录（宿主路径，以只读方式挂进容器的固定位置，
//        不改实验镜像，镜像身份与人的基准缓存都不变）、启动命令（容器内路径）、提取改动时排除的工作区路径、可选的附加
//        环境变量（不得含密钥：名字像 key 的一律拒绝）。
//   每一步：作业容器照现有方式开（接内部网络、带只读挂载，用户照镜像的 USER），工作区照旧准备；请求写进容器内的固定
//        目录，用 docker exec 在工作区根运行启动命令（带本步标记、模型基址与占位 key）；启动器写结果文件与产物目录；
//        步末删容器之前把这个目录拷到宿主作业目录下（按步与尝试分目录，重做不覆盖）。到墙钟加 30 秒即杀掉 docker exec
//        与容器里的进程（clearMarkedProcesses），按超时记；轮数上限交给启动器自己管，结果行的轮数照旧取网关请求数。
//   身份：agents 下按条件名记配置、工具目录摘要（批次开始时算一次）、网络档与启动命令 --identity 自报的版本；与现有
//        agents 段同一规则（不进身份摘要，续跑时两边都记了才比对）。
// 启动器协议（容器内）：<启动命令…> <请求文件> <结果文件>
//   请求：{ prompt, directive, root, maxTurns, wallClockMs, modelBaseUrl, model, stepMarker }
//   结果：{ status, turns?, usage?: { input, output, totalTokens }, interrupted?, report? }（report 为任意 JSON 对象）
//   环境变量：PIGEON_STEP_MARKER、PIGEON_MODEL_BASE_URL、PIGEON_MODEL_API_KEY（占位）、PIGEON_MODEL、
//            PIGEON_AGENT_IO（请求目录）、PIGEON_AGENT_ARTIFACTS（产物目录），另加配置里的附加变量
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  dockerOnce,
  removeWorkspaceContainer,
  startWorkspaceContainer,
  trustedShell,
} from "../execution/container-host.ts";
import { GATEWAY_PLACEHOLDER_KEY } from "../pi-runtime/index.ts";
import {
  type CommandStepAgentOptions,
  clearMarkedProcesses,
  SECRET_ENV,
  STREAM_WORK_DIRECTIVE,
  superviseLauncher,
} from "./stream-agents.ts";
import {
  EXTERNAL_AGENT_NAME,
  EXTERNAL_CONDITION_PREFIX,
  type ExternalStreamCondition,
  ZERO_USAGE,
} from "./stream-results.ts";
import type { ConditionSpec, StepAgent, StepAgentResult } from "./stream-runner.ts";

// 工具目录在容器里的挂载点（只读）
export const EXTERNAL_TOOL_MOUNT = "/opt/pigeon-agent";
// 容器内的请求目录：request.json、result.json 与产物目录 artifacts/
export const EXTERNAL_IO_DIR = "/tmp/pigeon-agent-io";
export const EXTERNAL_ARTIFACTS_DIR = `${EXTERNAL_IO_DIR}/artifacts`;
// 网络档的名字（身份里记）
export const EXTERNAL_NETWORK_PROFILE = "gateway-only";
// 墙钟之外给启动器收尾的余量
export const EXTERNAL_GRACE_MS = 30_000;

// 跑批器自己给启动器设的环境变量：配置里的附加变量不得重名
const RESERVED_ENV = new Set([
  "PIGEON_STEP_MARKER",
  "PIGEON_MODEL_BASE_URL",
  "PIGEON_MODEL_API_KEY",
  "PIGEON_MODEL",
  "PIGEON_AGENT_IO",
  "PIGEON_AGENT_ARTIFACTS",
  "PIGEON_STREAM_CONTAINER",
]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 配置里的附加变量名的密钥规则：比启动器环境去密钥用的 SECRET_ENV 更严（两条都查）——名字里有独立的 KEY 段（DEEPSEEK_KEY、
// ACCESS_KEY、KEY_ID 等），或含 PASS、COOKIE、BEARER、SESSION、CERT 的，一律当作密钥拒绝
export const EXTERNAL_SECRET_ENV = /(^|_)KEYS?(_|$)|PASS|COOKIE|BEARER|SESSION|CERT/i;

export function looksLikeSecretEnv(name: string): boolean {
  return SECRET_ENV.test(name) || EXTERNAL_SECRET_ENV.test(name);
}

export interface ExternalAgentConfig {
  name: string;
  // 宿主上的工具目录（已解析为绝对路径）
  toolDir: string;
  // 容器内的启动命令：首项为绝对路径，其后为固定参数
  command: string[];
  // 提取改动时排除的工作区相对路径
  excludePaths: string[];
  // 附加环境变量
  env: Record<string, string>;
}

export class ExternalAgentConfigError extends Error {
  override name = "ExternalAgentConfigError";
}

const CONFIG_KEYS = new Set(["name", "toolDir", "command", "excludePaths", "env"]);

// 解析并校验配置（raw 为 JSON 解析结果；baseDir 为配置文件所在目录，相对的工具目录据此解析）
export function parseExternalAgentConfig(
  raw: unknown,
  where: string,
  baseDir: string
): ExternalAgentConfig {
  const fail = (what: string): never => {
    throw new ExternalAgentConfigError(`外部 agent 配置 ${where}：${what}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("须为 JSON 对象");
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!CONFIG_KEYS.has(key)) fail(`未知字段 ${key}（可用 ${[...CONFIG_KEYS].join("、")}）`);
  }
  const name = obj.name;
  if (typeof name !== "string" || !EXTERNAL_AGENT_NAME.test(name)) {
    fail("name 须为小写字母或数字开头、只含小写字母、数字与连字符、至多 32 个字符");
  }
  const toolDirRaw = obj.toolDir;
  if (typeof toolDirRaw !== "string" || toolDirRaw.trim() === "")
    fail("缺 toolDir（宿主上的工具目录）");
  const toolDir = path.resolve(baseDir, toolDirRaw as string);
  // 工具目录原样拼进 docker 的 --mount：逗号、引号与换行会改变挂载参数的含义，一律拒绝；根目录与家目录不能整个挂进容器
  if (/[,"'\r\n]/.test(toolDir)) fail(`toolDir 不得含逗号、引号或换行：${toolDir}`);
  if (path.parse(toolDir).root === toolDir) fail(`toolDir 不能是根目录：${toolDir}`);
  if (path.resolve(homedir()) === toolDir) fail(`toolDir 不能是家目录：${toolDir}`);
  if (!existsSync(toolDir) || !statSync(toolDir).isDirectory()) {
    fail(`toolDir 不是存在的目录：${toolDir}`);
  }
  const commandRaw = typeof obj.command === "string" ? [obj.command] : obj.command;
  if (
    !Array.isArray(commandRaw) ||
    commandRaw.length === 0 ||
    !commandRaw.every((c) => typeof c === "string" && c !== "" && !c.includes("\0"))
  ) {
    fail("command 须为非空字符串或非空字符串数组（容器内的启动命令）");
  }
  const command = commandRaw as string[];
  if (!(command[0] ?? "").startsWith("/")) fail("command 的首项须为容器内的绝对路径");
  const excludeRaw = obj.excludePaths ?? [];
  if (!Array.isArray(excludeRaw)) fail("excludePaths 须为字符串数组");
  const excludePaths: string[] = [];
  for (const p of excludeRaw as unknown[]) {
    if (typeof p !== "string") fail("excludePaths 须为字符串数组");
    const normalized = normalizeExcludePath(p as string);
    if (normalized === undefined) {
      fail(
        `excludePaths 里的 ${JSON.stringify(p)} 须为工作区内的相对路径（不得为空、绝对路径、含 .. 或指向 .git）`
      );
    }
    if (!excludePaths.includes(normalized as string)) excludePaths.push(normalized as string);
  }
  const envRaw = obj.env ?? {};
  if (typeof envRaw !== "object" || envRaw === null || Array.isArray(envRaw)) {
    fail("env 须为对象（变量名 → 字符串）");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
    if (!ENV_NAME.test(key)) fail(`env 的变量名 ${key} 不合法`);
    if (looksLikeSecretEnv(key)) fail(`env 不得含密钥类变量：${key}（真 key 只在模型网关里）`);
    if (RESERVED_ENV.has(key)) fail(`env 的 ${key} 由跑批器设置，不能在配置里给`);
    if (typeof value !== "string" || value.includes("\0")) fail(`env 的 ${key} 须为字符串`);
    env[key] = value as string;
  }
  return { name: name as string, toolDir, command, excludePaths, env };
}

// 排除路径的规整：工作区相对路径、不含 . 与 .. 段、不指向 .git；不合法返回 undefined
export function normalizeExcludePath(p: string): string | undefined {
  if (p.includes("\0") || p.includes("\\")) return undefined;
  if (p.startsWith("/")) return undefined;
  const parts = p.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (parts.length === 0 || parts.some((seg) => seg === "..")) return undefined;
  if (parts[0] === ".git") return undefined;
  return parts.join("/");
}

export function loadExternalAgentConfig(file: string): ExternalAgentConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ExternalAgentConfigError(
      `外部 agent 配置 ${file} 读不出或不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parseExternalAgentConfig(raw, file, path.dirname(path.resolve(file)));
}

export function externalConditionOf(
  config: Pick<ExternalAgentConfig, "name">
): ExternalStreamCondition {
  return `${EXTERNAL_CONDITION_PREFIX}${config.name}` as ExternalStreamCondition;
}

// 外部 agent 条件的条件说明：agent 键即条件名；作业容器接只通网关的网络；网关上请求体逐字转发；提取改动时排除配置里的路径
export function externalConditionSpec(config: ExternalAgentConfig): ConditionSpec {
  const name = externalConditionOf(config);
  return {
    name,
    agent: name,
    sessionSearch: false,
    pushedMemory: false,
    network: "gateway-only",
    excludePaths: [...config.excludePaths],
    verbatimRequestBody: true,
  };
}

// 外部 agent 条件的作业容器参数（代替 --network none）：接跑批内部网络、只读挂载工具目录
export function externalContainerArgs(config: ExternalAgentConfig, networkName: string): string[] {
  return [
    "--network",
    networkName,
    "--mount",
    `type=bind,source=${config.toolDir},target=${EXTERNAL_TOOL_MOUNT},readonly`,
  ];
}

// 工具目录摘要：按相对路径排序，文件记可执行位与内容的 SHA-256，符号链接记指向，目录记名字；批次开始时算一次
export function toolDirDigest(dir: string): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    const abs = rel === "" ? dir : path.join(dir, rel);
    const entries = readdirSync(abs).sort();
    for (const entry of entries) {
      const childRel = rel === "" ? entry : `${rel}/${entry}`;
      const childAbs = path.join(dir, childRel);
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        lines.push(`L ${childRel} ${readlinkSync(childAbs)}`);
      } else if (st.isDirectory()) {
        lines.push(`D ${childRel}`);
        walk(childRel);
      } else if (st.isFile()) {
        const digest = createHash("sha256").update(readFileSync(childAbs)).digest("hex");
        lines.push(`F ${childRel} ${(st.mode & 0o111) !== 0 ? "x" : "-"} ${digest}`);
      }
    }
  };
  walk("");
  return `sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}

// 启动命令 --identity 的自报：取标准输出最后一个非空行，是 JSON 即按 JSON 记，否则记原文；取不到记 null
export function parseSelfReport(stdout: string): unknown {
  const last = stdout
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .at(-1);
  if (last === undefined) return null;
  try {
    return JSON.parse(last);
  } catch {
    return last.trim();
  }
}

// 身份段（记在 agents 下、按条件名）：配置（工具目录只记摘要，不记宿主路径）、工具目录摘要、网络档、自报的版本
export function externalAgentIdentity(
  config: ExternalAgentConfig,
  digest: string,
  selfReported: unknown
): Record<string, unknown> {
  return {
    config: {
      name: config.name,
      command: [...config.command],
      excludePaths: [...config.excludePaths],
      env: { ...config.env },
      mount: EXTERNAL_TOOL_MOUNT,
    },
    toolDirDigest: digest,
    network: EXTERNAL_NETWORK_PROFILE,
    selfReported,
  };
}

// 在实验镜像的一次性容器里（断网、只读挂载工具目录）运行"启动命令 --identity"，取自报的版本
export async function selfReportOf(
  config: ExternalAgentConfig,
  input: {
    image: string;
    container: string;
    docker?: readonly string[];
    runArgs?: readonly string[];
  }
): Promise<unknown> {
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
        `type=bind,source=${config.toolDir},target=${EXTERNAL_TOOL_MOUNT},readonly`,
        ...(input.runArgs ?? []),
      ],
    });
    const r = await dockerOnce(
      docker,
      ["exec", input.container, ...config.command, "--identity"],
      120_000
    );
    if (r.exitCode !== 0) return null;
    return parseSelfReport(r.stdout.toString("utf8"));
  } catch {
    return null;
  } finally {
    await removeWorkspaceContainer(input.container, docker).catch(() => {});
  }
}

// 读启动器的结果文件：拷出来的文件不可信——不是普通文件（符号链接等）即拒读，读不出或不是 JSON 对象同样为 undefined
export function readLauncherResult(file: string): Record<string, unknown> | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// 这一步的产物在宿主作业目录下的位置：external/step-<步序>/try-<第几次>，重做取下一个没用过的序号。其下 request.json
// 为宿主写的可信副本，io/ 为从容器拷出的请求目录（结果文件与产物，不可信）
export function artifactsDirFor(workDir: string, seq: number): string {
  const stepDir = path.join(workDir, "external", `step-${seq}`);
  mkdirSync(stepDir, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = path.join(stepDir, `try-${n}`);
    if (!existsSync(dir)) {
      mkdirSync(dir);
      return dir;
    }
  }
}

// 在容器里准备请求目录（以 root 建好、放开写权限给镜像的用户），写入请求文件
const PREPARE_IO = [
  'd="$1"',
  'rm -rf -- "$d"',
  'mkdir -p -- "$d/artifacts"',
  'cat > "$d/request.json"',
  'chmod 0777 -- "$d" "$d/artifacts"',
  'chmod 0644 -- "$d/request.json"',
].join(" && ");

export interface ExternalStepAgentOptions {
  config: ExternalAgentConfig;
  docker?: readonly string[];
  // 模型名（启动器按它向网关发请求）
  model?: string;
  // 墙钟之外给启动器收尾的余量（缺省 30 秒）
  graceMs?: number;
  limits?: CommandStepAgentOptions["limits"];
}

interface LauncherResult {
  status?: unknown;
  turns?: unknown;
  usage?: { input?: unknown; output?: unknown; totalTokens?: unknown };
  interrupted?: unknown;
  report?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function externalStepAgent(options: ExternalStepAgentOptions): StepAgent {
  const docker = options.docker ?? ["docker"];
  const [program = "docker", ...pre] = docker;
  const { config } = options;
  return {
    async run(input): Promise<StepAgentResult> {
      const container = input.target.container;
      const root = input.target.root;
      const marker = `pigeon-step-${randomBytes(8).toString("hex")}`;
      const request = {
        prompt: input.prompt,
        directive: STREAM_WORK_DIRECTIVE,
        root,
        maxTurns: input.budget.maxTurns,
        wallClockMs: input.budget.wallClockMs,
        modelBaseUrl: input.modelBaseUrl ?? null,
        model: options.model ?? null,
        stepMarker: marker,
      };
      const prepared = await dockerOnce(
        docker,
        ["exec", "-i", "-u", "0", container, ...trustedShell(PREPARE_IO, EXTERNAL_IO_DIR)],
        60_000,
        JSON.stringify(request)
      );
      if (prepared.exitCode !== 0) {
        throw new Error(`外部 agent ${config.name} 的请求写不进容器：${prepared.stderr.trim()}`);
      }
      const env: Record<string, string> = {
        ...config.env,
        PIGEON_STEP_MARKER: marker,
        PIGEON_MODEL_BASE_URL: input.modelBaseUrl ?? "",
        PIGEON_MODEL_API_KEY: GATEWAY_PLACEHOLDER_KEY,
        PIGEON_MODEL: options.model ?? "",
        PIGEON_AGENT_IO: EXTERNAL_IO_DIR,
        PIGEON_AGENT_ARTIFACTS: EXTERNAL_ARTIFACTS_DIR,
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
          ...config.command,
          `${EXTERNAL_IO_DIR}/request.json`,
          `${EXTERNAL_IO_DIR}/result.json`,
        ],
        budgetMs: input.budget.wallClockMs + (options.graceMs ?? EXTERNAL_GRACE_MS),
        limits: options.limits,
        abortSignal: input.abortSignal,
        label: `外部 agent ${config.name} 的启动命令`,
      });
      // 墙钟只算启动器本身（拷产物之前取）
      const wallMs = Date.now() - started;
      // 不论怎么结束，先清掉容器里的进程（docker exec 客户端被杀时容器里的进程不随之退出）
      const cleared = await clearMarkedProcesses(docker, container, marker, root);
      // 请求目录（含结果文件与产物）拷到宿主作业目录的 io/ 下；请求另由宿主写一份可信副本，不用容器里拷出的那份；
      // 重做不覆盖
      const outDir = artifactsDirFor(input.workDir, input.step.seq);
      writeFileSync(path.join(outDir, "request.json"), JSON.stringify(request));
      const ioDir = path.join(outDir, "io");
      mkdirSync(ioDir);
      await dockerOnce(docker, ["cp", `${container}:${EXTERNAL_IO_DIR}/.`, ioDir], 300_000);
      if (!cleared) {
        return {
          status: "aborted",
          turns: 0,
          usage: ZERO_USAGE,
          wallMs,
          interrupted: `外部 agent ${config.name} 在容器里的进程清理不净：这一步作废`,
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
              ? `跑批器按步中止（排队超时等）：外部 agent ${config.name} 已中止`
              : `限额信号：外部 agent ${config.name} 已中止`,
        };
      }
      if (ended === "timeout") {
        return { status: "wall-clock-limit", turns: 0, usage: ZERO_USAGE, wallMs };
      }
      const parsed = readLauncherResult(path.join(ioDir, "result.json"));
      if (parsed === undefined) {
        return { status: "unknown", turns: 0, usage: ZERO_USAGE, wallMs };
      }
      const raw = parsed as LauncherResult;
      const report =
        typeof raw.report === "object" && raw.report !== null && !Array.isArray(raw.report)
          ? (raw.report as Record<string, unknown>)
          : undefined;
      return {
        status: typeof raw.status === "string" ? raw.status : "unknown",
        turns: num(raw.turns),
        usage: {
          ...ZERO_USAGE,
          input: num(raw.usage?.input),
          output: num(raw.usage?.output),
          totalTokens: num(raw.usage?.totalTokens),
        },
        wallMs,
        ...(typeof raw.interrupted === "string" ? { interrupted: raw.interrupted } : {}),
        ...(report !== undefined ? { report } : {}),
      };
    },
  };
}
