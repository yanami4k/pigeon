# candidate-evidence

- 测什么能力：在版本化 typebox schema 上做加法式字段扩展，正确使用数组约束（`minItems`、`uniqueItems`、元素 `minLength`），并保持旧文档兼容。
- 任务来源：依据本仓库 `src/state/candidate.ts` 源码自编。
- 许可：随本仓库。
- 参考改法要点：导出 `CandidateEvidenceRefsSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })`，在 `CandidateSchema` 里加 `evidenceRefs: Type.Optional(CandidateEvidenceRefsSchema)`。
