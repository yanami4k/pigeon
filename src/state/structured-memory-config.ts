// .pigeon/structured-memory.json（决策 134 / 139）：结构化记忆的项目级开关——人配一次，本项目的 pigeon run 继承；
// 关闭时开局与回炉都不推送（"去掉记忆"条件）。启动参数 --no-structured-memory 压过本文件；两者都没有即开启。
// 本模块只放 schema；读取在 persistence/structured-memory-config.ts。
import { type Static, Type } from "typebox";

export const STRUCTURED_MEMORY_CONFIG_VERSION = 1;

export const StructuredMemoryConfigFileSchema = Type.Object({
  version: Type.Literal(STRUCTURED_MEMORY_CONFIG_VERSION),
  enabled: Type.Boolean(),
});
export type StructuredMemoryConfigFile = Static<typeof StructuredMemoryConfigFileSchema>;
