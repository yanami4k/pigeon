# 分析脚本：session 汇总按目录记录、题号列表限定为步序（基于 24f5cba）

范围：校准审计（2026-09-28-calibration-f69af5d.md 第八节第 1、2 条）记下的两个分析脚本问题的修复。分支 analysis-display-fix 从 formal-v2 的 24f5cba 开出，只改 `eval/analysis`，`src/` 无改动。两处都不改变 agent 所见所为，也不改变任何统计量。时间均为 UTC。

## 一、问题

1. **session 汇总被同摘要目录覆盖**：`reader.load_table` 以身份摘要为键记 session 文件的汇总（`sessions_info[digest] = info`）。身份摘要按设计不含条件与各 agent 参数，Pigeon 各格一个目录、最简 agent 另一个目录时两者摘要相同，后读的覆盖先读的。校准报告"输入"一节因此显示为 0 个作业、0 个 session 文件，只读两格目录时为 4 个作业、90 个 session 文件。各步的 session 计数按目录分别合并，不受影响。
2. **`--eligible` 与 `--tasks` 的编号空间**：规整表的"题"是结果行的步序（`seq`，该题在全流中的位置），参数说明却写"题号"。给清单里从 1 起的题号时，抽题核对只显示"否"，不说明原因；`formal --tasks` 给错编号空间时，不在列表里的步序被静默并入全部题。

## 二、修复

- `pigeon_analysis/reader.py`：
  - session 汇总改为按输出目录各记一条的列表，每条带目录名（`dir`，只取目录名，不含上级路径）与身份摘要（`digest`），按读入顺序排列，不再以摘要为键。
  - 新增 `require_step_space(values, tasks, flag)`：结果行里有步序不在所给列表里即报 `ValueError`，写明"<参数> 应给步序（结果行的 seq），不是题号"，并列出不在列表里的步序（最多 10 个）。
- `pigeon_analysis/cli.py`：`formal` 读入 `--tasks`、`calibration` 读入 `--eligible` 后即做上述核对；两个参数的说明改为"步序（结果行的 seq，不是从 1 起的题号）"。
- `pigeon_analysis/report.py`：
  - "输入"一节每个目录一行，写明目录名、摘要、作业数与 session 文件数。
  - 多于一个目录时另列一行合计，口径为各可用目录的作业数与 session 文件数直接相加。
  - "记忆使用"一节的可用性判断改读列表，规则不变：任一目录不可用即注明。
- `README.md`：用法里两个参数改为步序，并加一句说明。

## 三、测试

`tests/test_reader_cli.py`：

- 原有两例改为按目录的列表断言（有 session 文件的目录为 2 个作业、5 个 session 文件；没有 `streams/` 的目录为不可用）。
- `TestSplitDirs.test_sessions_kept_per_dir_with_same_digest`：
  - 两格目录（1 个作业、2 个 session 文件）与最简 agent 目录（0 个）摘要相同，一次读入后两条都在。
  - 校准报告里两行分目录与合计行的文字逐字核对。
- `TestStepSpace`：
  - `--eligible` 给步序通过。
  - 给 1 至 20 的题号即报错，并列出步序 46、59。
  - `formal --tasks` 缺一个结果行里的步序即报错。

## 四、验证（pigeon-run，分析用 Python 3.13 虚拟环境）

- analysis 的 pytest 全量（含 slow）：223 通过，0 失败（原 219 条加新增 4 条）。
- 变异反向验证，每次只改一处，跑全量后还原：
  - session 汇总改回同摘要覆盖：1 失败、222 通过，失败的恰为 `test_sessions_kept_per_dir_with_same_digest`。
  - 去掉 `calibration` 的步序核对：1 失败，恰为 `test_eligible_as_task_numbers_raises`。
  - 去掉 `formal` 的步序核对：1 失败，恰为 `test_formal_tasks_missing_a_result_step_raises`。
  - 三次还原后 `reader.py`、`cli.py` 的 sha256 与改前逐字一致（9f3e04db…、614682cf…）；全量再跑 223 通过。
- 用校准的两个输出目录重出校准报告（参数同校准审计第六节）：
  - `result.json` 的 `calibration` 部分与修复前的报告完全相同；`input` 除 session 汇总外完全相同。
  - `report.md` 只有"输入"一节的 session 文件行改变：两格目录 4 个作业、90 个 session 文件；最简 agent 目录 0 个作业、0 个 session 文件；合计 4 个作业、90 个 session 文件。5.1 至 5.7 的数值不变。
- 同一数据改给 1 至 89 的题号作 `--eligible`：报错"--eligible 应给步序（结果行的 seq），不是题号：结果行里的步序 97, 112, 117, …不在 --eligible 里"。

## 五、附记

- `result.json` 的 `input.sessions` 由以摘要为键的对象改为列表，读 `result.json` 的下游若按旧结构取值需相应调整；目前库内没有这类读取方。
