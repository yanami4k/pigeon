# 为 Candidate schema 增加证据引用字段

`src/state/candidate.ts` 定义了学习产物暂存形态 `CandidateSchema`（typebox）。激活决策需要回查证据，但现在只有一个 `sourceRef`。请增加一个可选的证据引用列表。

## 对外接口

1. 新增并导出 schema 常量 `CandidateEvidenceRefsSchema`：非空字符串组成的数组，并且
   - 至少 1 项（`minItems: 1`）；
   - 每项是长度至少为 1 的字符串；
   - 不允许重复项（`uniqueItems: true`）。
2. `CandidateSchema` 增加**可选**属性 `evidenceRefs`，其 schema 就是 `CandidateEvidenceRefsSchema`。`Candidate` 类型随之带上可选的 `evidenceRefs?: string[]`。

## 行为（以 `Value.Check` 判定）

- 不带 `evidenceRefs` 的既有 Candidate 仍然合法（加法式字段，`CANDIDATE_VERSION` 保持为 1，不做版本升级）。
- `evidenceRefs: ["run_...", "sess_..."]` 这类合法值通过，并能经 JSON 往返。
- 下列取值使整个 Candidate 校验失败：空数组 `[]`、含空串 `[""]`、含重复项 `["a", "a"]`、非数组（如字符串 `"a"`）、含非字符串元素（如 `[1]`）。

## 约束

- 只改 `src/state/candidate.ts`，其余字段与状态机不变。
- 可以用 `node --test <测试文件>` 自测。
