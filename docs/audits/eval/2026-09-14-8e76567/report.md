# Eval 冒烟报告

- 运行：72 次；任务 8 个（其中 holdout 3 个）；每任务每条件最多 3 次
- 条件：none = 无 Skill，candidate = 候选 Skill，approved = 已批准 Skill；三者只有 skillRoots 不同，memoryRoots 一律为空
- 判决：确定性验证器的退出码三值（通过 / 失败 / 未判定）；误报 = agent 自报完成但验证失败
- 统计口径：per-task 三元结果与 pairwise delta；Wilson 区间与 McNemar exact 在 M9 补

## 成功率（非 holdout）

| 任务 | none | candidate | approved |
|---|---|---|---|
| args-summary-surrogate | 3/3（100%） | 3/3（100%） | 3/3（100%） |
| fmt-duration | 3/3（100%） | 3/3（100%） | 3/3（100%） |
| path-dotdot-name | 3/3（100%） | 3/3（100%） | 3/3（100%） |
| session-day-groups | 3/3（100%） | 2/3（67%） | 2/3（67%） |
| tool-error-codes | 3/3（100%） | 3/3（100%） | 2/3（67%） |
| 合计 | 15/15（100%） | 14/15（93%） | 13/15（87%） |

## 成功率（holdout）

| 任务 | none | candidate | approved |
|---|---|---|---|
| candidate-evidence | 3/3（100%） | 3/3（100%） | 3/3（100%） |
| insert-after-diff | 3/3（100%） | 3/3（100%） | 2/3（67%） |
| skill-block-scalar | 3/3（100%） | 3/3（100%） | 3/3（100%） |
| 合计 | 9/9（100%） | 9/9（100%） | 8/9（89%） |

## per-task 三元结果

| 任务 | 条件 | 通过 | 失败 | 未判定 | 误报 |
|---|---|---|---|---|---|
| args-summary-surrogate | none | 3 | 0 | 0 | 0 |
| args-summary-surrogate | candidate | 3 | 0 | 0 | 0 |
| args-summary-surrogate | approved | 3 | 0 | 0 | 0 |
| fmt-duration | none | 3 | 0 | 0 | 0 |
| fmt-duration | candidate | 3 | 0 | 0 | 0 |
| fmt-duration | approved | 3 | 0 | 0 | 0 |
| path-dotdot-name | none | 3 | 0 | 0 | 0 |
| path-dotdot-name | candidate | 3 | 0 | 0 | 0 |
| path-dotdot-name | approved | 3 | 0 | 0 | 0 |
| session-day-groups | none | 3 | 0 | 0 | 0 |
| session-day-groups | candidate | 2 | 1 | 0 | 1 |
| session-day-groups | approved | 2 | 1 | 0 | 1 |
| tool-error-codes | none | 3 | 0 | 0 | 0 |
| tool-error-codes | candidate | 3 | 0 | 0 | 0 |
| tool-error-codes | approved | 2 | 1 | 0 | 0 |
| candidate-evidence（holdout） | none | 3 | 0 | 0 | 0 |
| candidate-evidence（holdout） | candidate | 3 | 0 | 0 | 0 |
| candidate-evidence（holdout） | approved | 3 | 0 | 0 | 0 |
| insert-after-diff（holdout） | none | 3 | 0 | 0 | 0 |
| insert-after-diff（holdout） | candidate | 3 | 0 | 0 | 0 |
| insert-after-diff（holdout） | approved | 2 | 1 | 0 | 1 |
| skill-block-scalar（holdout） | none | 3 | 0 | 0 | 0 |
| skill-block-scalar（holdout） | candidate | 3 | 0 | 0 | 0 |
| skill-block-scalar（holdout） | approved | 3 | 0 | 0 | 0 |

## pairwise delta（成功率百分点）

| 任务 | candidate − none | approved − none | approved − candidate |
|---|---|---|---|
| args-summary-surrogate | 0.0 | 0.0 | 0.0 |
| fmt-duration | 0.0 | 0.0 | 0.0 |
| path-dotdot-name | 0.0 | 0.0 | 0.0 |
| session-day-groups | -33.3 | -33.3 | 0.0 |
| tool-error-codes | 0.0 | -33.3 | -33.3 |
| candidate-evidence（holdout） | 0.0 | 0.0 | 0.0 |
| insert-after-diff（holdout） | 0.0 | -33.3 | -33.3 |
| skill-block-scalar（holdout） | 0.0 | 0.0 | 0.0 |
| 合计（非 holdout） | -6.7 | -13.3 | -6.7 |
| 合计（holdout） | 0.0 | -11.1 | -11.1 |

## 成本与过程（按条件汇总，含 holdout）

| 条件 | 运行 | 误报 | 平均轮次 | 平均工具调用 | 平均需审批 | 总 token | 总成本 | 平均耗时（秒） |
|---|---|---|---|---|---|---|---|---|
| none | 24 | 0 | 12.8 | 12.0 | 8.5 | 2892200 | 1.1362 | 120.0 |
| candidate | 24 | 1 | 15.0 | 15.8 | 10.5 | 5062609 | 1.5876 | 107.6 |
| approved | 24 | 2 | 15.2 | 15.8 | 10.3 | 4249927 | 1.6890 | 176.9 |

## 运行异常

- session-day-groups / candidate / 第 1 次：Request aborted
- tool-error-codes / approved / 第 3 次：This operation was aborted
