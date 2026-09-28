# 分析脚本合读分目录的输出（基于 f69af5d）

范围：分析脚本 `eval/analysis` 一次读入"Pigeon 各格一个输出目录、最简 agent 另一个输出目录"时报设置不一致的缺陷及其修复。分支 analysis-multidir 从 formal-v2 的 f69af5d（标签 formal-run-v1）开出，只改 `eval/analysis`，`src/` 无改动。时间均为 UTC。

## 一、缺陷

- 跑批器的 `--attempts` 对一次调用里的全部条件统一生效（`src/eval/stream-runner.ts` 按"遍 × 条件"建作业），不能按条件分设遍数。校准与正式跑都是 Pigeon 各格两遍、最简 agent 一遍，只能分两次调用、两个输出目录。
- 只跑最简 agent 的输出目录，身份头 `core.agents` 里没有 `pigeon`（`src/eval/stream-experiment.ts` 在没有 Pigeon 条件时不写），读入层把 `model`、`compaction`、`memoryLimitChars`、`reviewTemplate`、`reviewBudget` 读成空。
- `reader.common_settings` 要求各输出目录的上述各项与第一个目录相同，两个目录一起读即报 `ResultFieldError：各输出目录的设置不一致：compaction、memoryLimitChars、model、reviewBudget、reviewTemplate`，`calibration` 与 `formal` 两条命令都受影响。
- 复现（f69af5d 的分析脚本与自带夹具 `tests/runner_fixture.py`）：两格一个目录（`identity(("search-only", "search-push"))`），最简 agent 一个目录（`identity(("minimal",), pigeon=False)`）；单读任一目录退出码 0，两个一起读即报上述错误。
- 性质：只涉及分析，不改变 agent 所见所为，也不涉及已跑数据。

## 二、修复

`eval/analysis/pigeon_analysis/reader.py`：

- 新增 `PIGEON_ONLY_SETTINGS = (compaction, memoryLimitChars, reviewTemplate, reviewBudget)`。
- `common_settings`：身份头里有 Pigeon 代理的目录之间照旧逐项比对全部共享设置；只跑最简 agent 的目录跳过上述四项与 `model`，其余共享项（题面格式、题面布局、每步上限）照旧比对。
- 模型设置仍跨目录核对：新增 `minimal_model`，把最简 agent 身份头记录的模型名、`modelKwargs` 的 `temperature`、`thinking`、`max_tokens` 换成与 Pigeon 的 `model` 同口径（`{"type": "disabled"}` 对应 `"off"`，其余原样），与 Pigeon 的模型名、温度、思考开关、单次输出上限逐项比较，不一致即报 `model` 不一致。`modelKwargs` 为空（跑批器读不到最简 agent 的参数）时无从核对，也按不一致报错。
- 返回值取有 Pigeon 代理的目录的设置，与目录的给出顺序无关（校准报告的压缩触发点、复盘上限从这里取）；全部目录都没有 Pigeon 代理时行为不变。

## 三、测试

`eval/analysis/tests/test_reader_cli.py` 新增 `TestSplitDirs`，夹具按实际身份头的形状写最简 agent 的 `modelKwargs`：

- 两格两遍一个目录、最简 agent 一遍另一个目录，按两种顺序读入都能通过，返回的压缩触发点与复盘上限为 Pigeon 的；`calibration` 命令一次读入两个目录，退出码 0，读入 10 条记录。
- 最简 agent 的温度、单次输出上限、思考开关（参数化三例）或模型名与 Pigeon 不同，仍报 `model` 不一致。
- 最简 agent 缺 `modelKwargs`，报 `model` 不一致。
- 最简 agent 目录的每步上限与 Pigeon 目录不同，仍报 `stepBudget` 不一致。

## 四、验证（pigeon-run，分析用 Python 3.13 虚拟环境）

- analysis 的 pytest 全量（含 slow）：219 通过，0 失败。
- 变异一：把只跑最简 agent 的目录的比对改回比对全部共享项（去掉豁免），全量 1 失败、218 通过，失败的恰为"两个目录一起读能通过"一条；还原后 `reader.py` 的 sha256 与改前逐字一致（a322842f…），全量 219 通过。
- 变异二：去掉最简 agent 模型设置的比对，`test_reader_cli.py` 5 失败，恰为模型设置不一致与缺 `modelKwargs` 的 5 例；还原后 sha256 同上。
- 以校准正在跑的两个输出目录的实际身份头核对：最简 agent 换算后为 `{modelId: deepseek-flash, temperature: 0, thinking: off, maxOutputTokens: 16384}`，与 Pigeon 一致，合读通过，压缩触发点 983616。

## 五、附记

- 两个目录身份头的摘要相同（4979902614f22792）。`src/eval/stream-identity.ts` 的 `identityDigest` 按设计不含 `conditions` 与 `agents`（按条件子集续跑时摘要不变），不是缺陷；结果行的 `runIdentity` 仍按各自目录的身份头核对。
- 预注册第 6 节写明分析脚本在正式跑开始前冻结；本修复在正式跑之前，并入 formal-v2 另行安排。
