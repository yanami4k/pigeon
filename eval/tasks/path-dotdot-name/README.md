# path-dotdot-name

- 测什么能力：修复路径包含判定的前缀比较缺陷，跨平台分隔符处理，且不放宽安全围栏。
- 任务来源：依据本仓库 `src/tools/paths.ts` 源码自编。
- 许可：随本仓库。
- 参考改法要点：抽一个判越界的助手 `rel === ".." || rel.startsWith(\`..${path.sep}\`) || path.isAbsolute(rel)`，`resolveWorkspacePath` 与 `isPathInsideDir` 共用。
