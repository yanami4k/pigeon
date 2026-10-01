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

export const SandboxSectionSchema = Type.Object(
  {
    // 改用的镜像名（与 dockerfile 二选一）
    image: Type.Optional(Text()),
    // 项目自己的 Dockerfile（相对项目根）；构建上下文缺省为其所在目录
    dockerfile: Type.Optional(Text()),
    context: Type.Optional(Text()),
    // 通用镜像的构建参数（压过环境变量）
    build: Type.Optional(SandboxBuildSchema),
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
  return problems;
}
