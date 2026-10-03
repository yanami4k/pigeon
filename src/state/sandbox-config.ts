// 日常沙箱的镜像配置（决策 247；决策 325 起为 settings.json 的 sandbox 一节）：改用现成的镜像名，或指向项目自己的 Dockerfile，
// 另可给通用镜像的构建参数。纯 schema 与判据，无 IO；镜像解析与构建在 execution/sandbox-image.ts。
import { type Static, Type } from "typebox";

// 非空字符串（去掉首尾空白后仍非空）
const Text = () => Type.String({ minLength: 1, pattern: "\\S" });

export const SandboxBuildSchema = Type.Object(
  {
    baseImage: Type.Optional(Text()),
    aptMirror: Type.Optional(Text()),
    nodeMirror: Type.Optional(Text()),
    pipIndex: Type.Optional(Text()),
    npmRegistry: Type.Optional(Text()),
  },
  { additionalProperties: false }
);
export type SandboxBuildParams = Static<typeof SandboxBuildSchema>;

// 内存大小的写法：0，或数字加单位 k/m/g/t（不分大小写）
const MEMORY_PATTERN = "^(0|[0-9]+(\\.[0-9]+)?[kKmMgGtT])$";
const MEMORY_UNITS: Record<string, number> = { k: 1, m: 2, g: 3, t: 4 };
// Docker 接受的内存上限下限
const MIN_MEMORY_BYTES = 6 * 1024 * 1024;

export const SandboxSectionSchema = Type.Object(
  {
    // 改用的镜像名（与 dockerfile 二选一）
    image: Type.Optional(Text()),
    // 项目自己的 Dockerfile（相对项目根）；构建上下文缺省为其所在目录
    dockerfile: Type.Optional(Text()),
    context: Type.Optional(Text()),
    // 通用镜像的构建参数（压过环境变量）
    build: Type.Optional(SandboxBuildSchema),
    // 决策 333：容器的资源上限，0 为不限；不写取缺省（内存为 Docker 所在机器内存的一半、进程数 4096、CPU 不限）。
    // 内存写带单位的大小（k/m/g/t，按 1024 进位，如 "8g"、"512m"），交换区不另占
    memory: Type.Optional(Type.Union([Type.Literal(0), Type.String({ pattern: MEMORY_PATTERN })])),
    pids: Type.Optional(Type.Integer({ minimum: 0 })),
    cpus: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false }
);
export type SandboxConfig = Static<typeof SandboxSectionSchema>;

// 合并后的组合判据：返回问题描述（由读取方响亮失败）
export function sandboxConfigProblems(config: SandboxConfig): string[] {
  const problems: string[] = [];
  if (config.image !== undefined && config.dockerfile !== undefined) {
    problems.push("image 与 dockerfile 只能给一个");
  }
  if (config.context !== undefined && config.dockerfile === undefined) {
    problems.push("context 只配合 dockerfile 用");
  }
  if (config.memory !== undefined) {
    const bytes = parseMemorySize(config.memory);
    if (bytes > 0 && bytes < MIN_MEMORY_BYTES) {
      problems.push(`memory 至少 6m（Docker 的下限），现为 ${config.memory}`);
    }
  }
  return problems;
}

// 内存大小换算成字节（写法已经 schema 校验）
export function parseMemorySize(value: 0 | string): number {
  if (value === 0 || value === "0") {
    return 0;
  }
  const unit = MEMORY_UNITS[value.slice(-1).toLowerCase()] ?? 0;
  return Math.floor(Number(value.slice(0, -1)) * 1024 ** unit);
}

// 决策 333：开沙箱用的资源上限设置（只含写了的项，缺项由开沙箱时取缺省）
export function sandboxLimitSettingsOf(config: SandboxConfig): {
  memoryBytes?: number;
  pids?: number;
  cpus?: number;
} {
  return {
    ...(config.memory !== undefined ? { memoryBytes: parseMemorySize(config.memory) } : {}),
    ...(config.pids !== undefined ? { pids: config.pids } : {}),
    ...(config.cpus !== undefined ? { cpus: config.cpus } : {}),
  };
}
