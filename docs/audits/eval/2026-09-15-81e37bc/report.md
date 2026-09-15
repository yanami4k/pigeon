# Eval 冒烟报告

- 运行：24 次；任务 8 个（其中 holdout 3 个）；每任务每条件最多 3 次
- 条件：none = 无 Skill，candidate = 候选 Skill，approved = 已批准 Skill；三者只有 skillRoots 不同，memoryRoots 一律为空
- 编辑模式：replace
- 判决：确定性验证器的退出码三值（通过 / 失败 / 未判定）；误报 = agent 自报完成但验证失败
- 统计口径：per-task 三元结果与 pairwise delta；Wilson 区间与 McNemar exact 在 M9 补

## 成功率（非 holdout）

| 任务 | none | candidate | approved |
|---|---|---|---|
| args-summary-surrogate | 3/3（100%） | — | — |
| fmt-duration | 3/3（100%） | — | — |
| path-dotdot-name | 3/3（100%） | — | — |
| session-day-groups | 3/3（100%） | — | — |
| tool-error-codes | 3/3（100%） | — | — |
| 合计 | 15/15（100%） | — | — |

## 成功率（holdout）

| 任务 | none | candidate | approved |
|---|---|---|---|
| candidate-evidence | 3/3（100%） | — | — |
| insert-after-diff | 3/3（100%） | — | — |
| skill-block-scalar | 3/3（100%） | — | — |
| 合计 | 9/9（100%） | — | — |

## per-task 三元结果

| 任务 | 条件 | 通过 | 失败 | 未判定 | 误报 |
|---|---|---|---|---|---|
| args-summary-surrogate | none | 3 | 0 | 0 | 0 |
| fmt-duration | none | 3 | 0 | 0 | 0 |
| path-dotdot-name | none | 3 | 0 | 0 | 0 |
| session-day-groups | none | 3 | 0 | 0 | 0 |
| tool-error-codes | none | 3 | 0 | 0 | 0 |
| candidate-evidence（holdout） | none | 3 | 0 | 0 | 0 |
| insert-after-diff（holdout） | none | 3 | 0 | 0 | 0 |
| skill-block-scalar（holdout） | none | 3 | 0 | 0 | 0 |

## pairwise delta（成功率百分点）

| 任务 | candidate − none | approved − none | approved − candidate |
|---|---|---|---|
| args-summary-surrogate | — | — | — |
| fmt-duration | — | — | — |
| path-dotdot-name | — | — | — |
| session-day-groups | — | — | — |
| tool-error-codes | — | — | — |
| candidate-evidence（holdout） | — | — | — |
| insert-after-diff（holdout） | — | — | — |
| skill-block-scalar（holdout） | — | — | — |
| 合计（非 holdout） | — | — | — |
| 合计（holdout） | — | — | — |

## 成本与过程（按条件汇总，含 holdout）

| 条件 | 运行 | 误报 | 平均轮次 | 平均工具调用 | 平均需审批 | 总 token | 总成本 | 平均耗时（秒） |
|---|---|---|---|---|---|---|---|---|
| none | 24 | 0 | 14.3 | 13.8 | 11.2 | 3330607 | 1.2044 | 134.2 |

## 运行异常

- session-day-groups / none / 第 2 次：Request aborted
- session-day-groups / none / 第 3 次：Request aborted
