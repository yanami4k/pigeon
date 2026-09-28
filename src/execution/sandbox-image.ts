// 日常沙箱的镜像（决策 247）：缺省用 Pigeon 自带的通用镜像（仓库里 docker/sandbox/Dockerfile，Ubuntu 24.04），
// 首次使用时构建，标签带 Dockerfile 内容与底镜像名的哈希，之后直接用缓存；项目可在 .pigeon/sandbox.json 里改用任一镜像名，
// 或指向项目自己的 Dockerfile。国内网络经构建参数替换底镜像与 apt / pip / npm 的软件源（环境变量或配置的 build 段）。
// 镜像里须有 git：开工时由沙箱检查（sandbox.ts），这里只负责给出可用的镜像名。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dockerOnce } from "./container-host.ts";

// 项目的沙箱配置文件（相对治理根）
export const SANDBOX_CONFIG_FILE = path.join(".pigeon", "sandbox.json");

// 通用镜像的 Dockerfile（仓库内）
export const GENERIC_DOCKERFILE = fileURLToPath(
  new URL("../../docker/sandbox/Dockerfile", import.meta.url)
);
export const GENERIC_IMAGE_REPO = "pigeon-sandbox";
export const PROJECT_IMAGE_REPO = "pigeon-sandbox-project";
export const DEFAULT_BASE_IMAGE = "ubuntu:24.04";

// 通用镜像的构建参数：配置字段、环境变量与 Dockerfile 里的 ARG 名一一对应
const BUILD_PARAMS = [
  {
    key: "baseImage",
    env: "PIGEON_SANDBOX_BASE_IMAGE",
    arg: "BASE_IMAGE",
    what: "底镜像名（缺省 ubuntu:24.04）",
  },
  {
    key: "aptMirror",
    env: "PIGEON_SANDBOX_APT_MIRROR",
    arg: "APT_MIRROR",
    what: "apt 软件源根地址",
  },
  { key: "pipIndex", env: "PIGEON_SANDBOX_PIP_INDEX", arg: "PIP_INDEX_URL", what: "pip 索引地址" },
  { key: "npmRegistry", env: "PIGEON_SANDBOX_NPM_REGISTRY", arg: "NPM_REGISTRY", what: "npm 源" },
] as const;

export type SandboxBuildParams = Partial<Record<(typeof BUILD_PARAMS)[number]["key"], string>>;

export interface SandboxConfig {
  // 改用的镜像名（与 dockerfile 二选一）
  image?: string;
  // 项目自己的 Dockerfile（相对治理根）；构建上下文缺省为其所在目录
  dockerfile?: string;
  context?: string;
  // 通用镜像的构建参数（压过环境变量）
  build?: SandboxBuildParams;
}

// 解析出的镜像来源：现成的镜像名，或要按 Dockerfile 构建（带缓存标签）
export type SandboxImageSpec =
  | { kind: "image"; image: string }
  | {
      kind: "build";
      image: string;
      dockerfile: string;
      context: string;
      buildArgs: Record<string, string>;
      // 是否 Pigeon 自带的通用镜像（构建失败时才提示通用镜像的构建参数）
      generic: boolean;
    };

// 读项目的沙箱配置；没有即空配置，畸形一律响亮失败
export function loadSandboxConfig(governanceRoot: string): SandboxConfig {
  const file = path.join(governanceRoot, SANDBOX_CONFIG_FILE);
  if (!existsSync(file)) {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `沙箱配置 ${SANDBOX_CONFIG_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const bad = (why: string): Error => new Error(`沙箱配置 ${SANDBOX_CONFIG_FILE} 不对：${why}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw bad("顶层须为对象");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["image", "dockerfile", "context", "build"].includes(key)) {
      throw bad(`未知字段 ${key}（可用 image、dockerfile、context、build）`);
    }
  }
  const text = (key: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") throw bad(`${key} 须为非空字符串`);
    return value;
  };
  const config: SandboxConfig = {};
  const image = text("image", record.image);
  const dockerfile = text("dockerfile", record.dockerfile);
  const context = text("context", record.context);
  if (image !== undefined && dockerfile !== undefined) {
    throw bad("image 与 dockerfile 只能给一个");
  }
  if (context !== undefined && dockerfile === undefined) {
    throw bad("context 只配合 dockerfile 用");
  }
  if (image !== undefined) config.image = image;
  if (dockerfile !== undefined) config.dockerfile = dockerfile;
  if (context !== undefined) config.context = context;
  if (record.build !== undefined) {
    if (typeof record.build !== "object" || record.build === null || Array.isArray(record.build)) {
      throw bad("build 须为对象");
    }
    const build: SandboxBuildParams = {};
    for (const [key, value] of Object.entries(record.build)) {
      const param = BUILD_PARAMS.find((p) => p.key === key);
      if (param === undefined) {
        throw bad(`build 里的未知字段 ${key}（可用 ${BUILD_PARAMS.map((p) => p.key).join("、")}）`);
      }
      const checked = text(`build.${key}`, value);
      if (checked !== undefined) build[param.key] = checked;
    }
    config.build = build;
  }
  return config;
}

const digest = (...parts: string[]): string =>
  createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);

// 由配置与环境变量得出镜像来源
export function resolveSandboxImage(
  governanceRoot: string,
  config: SandboxConfig,
  env: Record<string, string | undefined> = process.env
): SandboxImageSpec {
  if (config.image !== undefined) {
    return { kind: "image", image: config.image };
  }
  if (config.dockerfile !== undefined) {
    const dockerfile = path.resolve(governanceRoot, config.dockerfile);
    if (!existsSync(dockerfile)) {
      throw new Error(`沙箱配置指向的 Dockerfile 不存在：${config.dockerfile}`);
    }
    const context =
      config.context !== undefined
        ? path.resolve(governanceRoot, config.context)
        : path.dirname(dockerfile);
    return {
      kind: "build",
      image: `${PROJECT_IMAGE_REPO}:${digest(readFileSync(dockerfile, "utf8"))}`,
      dockerfile,
      context,
      buildArgs: {},
      generic: false,
    };
  }
  const buildArgs: Record<string, string> = {};
  for (const param of BUILD_PARAMS) {
    const value = config.build?.[param.key] ?? env[param.env];
    if (value !== undefined && value !== "") buildArgs[param.arg] = value;
  }
  const content = readFileSync(GENERIC_DOCKERFILE, "utf8");
  // 换了底镜像即是另一份镜像；软件源只影响下载来源，不进标签
  const base = buildArgs.BASE_IMAGE ?? DEFAULT_BASE_IMAGE;
  return {
    kind: "build",
    image: `${GENERIC_IMAGE_REPO}:${digest(content, base)}`,
    dockerfile: GENERIC_DOCKERFILE,
    context: path.dirname(GENERIC_DOCKERFILE),
    buildArgs,
    generic: true,
  };
}

// 构建失败时说明可设的参数
export function buildParamsHelp(): string {
  return (
    "可设的构建参数（环境变量，或 .pigeon/sandbox.json 的 build 段，后者优先）：" +
    BUILD_PARAMS.map((p) => `${p.env} / build.${p.key}：${p.what}`).join("；") +
    "。也可在 .pigeon/sandbox.json 里用 image 改用现成的镜像，或用 dockerfile 指向项目自己的 Dockerfile"
  );
}

// 给出可用的镜像名：要构建的先看本地有没有同标签的缓存，没有才构建
export async function ensureSandboxImage(
  spec: SandboxImageSpec,
  options: { docker?: readonly string[]; log?: (line: string) => void; timeoutMs?: number } = {}
): Promise<string> {
  if (spec.kind === "image") {
    return spec.image;
  }
  const docker = options.docker ?? ["docker"];
  const cached = await dockerOnce(docker, ["image", "inspect", spec.image], 60_000);
  if (cached.exitCode === 0) {
    return spec.image;
  }
  options.log?.(`首次使用，正在构建沙箱镜像 ${spec.image}（可能要几分钟）`);
  const built = await dockerOnce(
    docker,
    [
      "build",
      "-t",
      spec.image,
      "-f",
      spec.dockerfile,
      ...Object.entries(spec.buildArgs).flatMap(([key, value]) => [
        "--build-arg",
        `${key}=${value}`,
      ]),
      spec.context,
    ],
    options.timeoutMs ?? 60 * 60_000
  );
  if (built.exitCode !== 0) {
    const tail = `${built.stdout.toString("utf8")}\n${built.stderr}`
      .trim()
      .split("\n")
      .slice(-15)
      .join("\n");
    throw new Error(
      `沙箱镜像构建失败（${spec.image}，退出码 ${built.exitCode}）：\n${tail}\n` +
        (spec.generic ? buildParamsHelp() : `请检查项目的 Dockerfile：${spec.dockerfile}`)
    );
  }
  return spec.image;
}
