# 分析脚本："已花"取网关累计（基于 b37c37e）

范围：按预注册分析计划修订节 2026-09-28"花费口径的澄清"，把 5.2 与第 3 遍判断里的"已花"改为各输出目录网关花费记录之和。分支 analysis-spent-gateway 从 formal-v2 的 b37c37e 开出，只改 `eval/analysis`，`src/` 无改动。不改变 agent 所见所为；每步平均花费（c01、c11、cM、C3）仍按结果行。时间均为 UTC。

## 一、问题

- 预注册的澄清：已花取网关累计，即各输出目录 `gateway-spend.json` 的 `totalCny` 之和，含作废的步与开跑前探测的请求；这两类请求不写结果行。
- 现状：`sensitivity.third_pass_decision` 的剩余预算 B = 预算 − 四格结果行花费合计 − 最简 agent 结果行花费合计 − 预留，漏了作废的步与探测。集成冒烟中这部分为 ¥0.41。
- 校准报告的花费一节没有写出已花。

## 二、修复

- `pigeon_analysis/reader.py`：
  - `load_table` 按输出目录读 `gateway-spend.json`，记下网关累计（`gatewayCny`）、请求数与该目录结果行的花费合计（`rowsCny`，干活加复盘），放在 `info["spend"]`，每个目录一条。
  - 结果行合计与规整表取法一致：同一条件、遍、步只取最后出现的一行。
  - 缺文件或缺 `totalCny` 时该目录记为缺失。
  - 新增 `spent_summary`：各目录网关累计相加为已花，并列给出结果行合计与二者之差。任一目录缺网关花费记录即报 `ResultFieldError`，写明是哪个目录、缺文件还是缺 `totalCny`，不退回结果行求和。
- `pigeon_analysis/sensitivity.py`：`third_pass_decision` 增加必填的关键字参数 `spent`（`spent_summary` 的结果），B = 预算 − 已花（网关）− 预留。结果另记 `spentGateway`、`spentRows`、`spentDifference`；四格与最简 agent 的结果行合计照旧记录，C3 仍按结果行。
- `pigeon_analysis/calibration.py`：`analyze_calibration` 接收 `spent`，记入花费一节。
- `pigeon_analysis/cli.py`：`formal`（判第 3 遍时）与 `calibration` 都先由 `spent_summary(info["spend"])` 求已花，缺网关花费记录即报错。
- `pigeon_analysis/report.py`：校准报告 5.2 与正式报告第 3 遍一节并列写出三个数：已花（各输出目录网关累计之和，含作废的步与开跑前探测）、结果行合计、二者之差。

## 三、测试

- `tests/runner_fixture.py`：`write_run` 缺省写一份 `gateway-spend.json`，`totalCny` 为结果行合计，与跑批器没有作废步、没有探测时一致；可指定别的值，或不写这个文件。
- `tests/test_sensitivity.py`：
  - 原有第 3 遍判断各例经 `decide` 传入与结果行相等的网关累计，断言不变。
  - 新增：网关比结果行多 5 元（作废的步）时，已花 38、结果行 33、差 5，B = 650 − 38，C3 仍为 16.5；同一预算边界按结果行够、按网关不够时判"不补"。
  - 新增：不传 `spent` 即报错。
- `tests/test_reader_cli.py` 新增 `TestGatewaySpent`：
  - 两格目录网关比结果行多 0.5 元：两个目录分别记下网关与结果行合计；已花 4.58、结果行 4.08、差 0.5；校准的 `result.json` 与报告文字逐字核对。
  - 缺 `gateway-spend.json`、缺 `totalCny`：分别报错并写明目录与缺项。
  - 同一条件、遍、步有两行时，结果行合计只算最后一行。
  - `formal` 缺网关花费记录报错。

## 四、验证（pigeon-run，分析用 Python 3.13 虚拟环境）

- analysis 的 pytest 全量（含 slow）：230 通过，0 失败（原 223 条加新增 7 条）。
- 变异反向验证，每次只改一处，跑全量后还原：
  - B 改回按结果行求已花：1 失败，恰为 `test_spent_is_gateway_total_not_rows`。
  - 缺网关花费记录时静默退回结果行：3 失败，恰为缺文件、缺 `totalCny`、`formal` 缺记录三例。
  - 校准报告不写已花一行：1 失败，恰为 `test_gateway_total_counts_voided_steps`。
  - 结果行合计不去重：1 失败，恰为 `test_rows_cost_takes_last_row`。
  - 四次还原后 `pigeon_analysis` 各模块的 sha256 与改前逐一相同，全量再跑 230 通过。
- 用校准的两个输出目录重出校准报告（参数同校准审计第六节）：
  - 已花（网关累计之和）¥29.4059：两格 ¥25.8920、6645 个请求；最简 agent ¥3.5140、1240 个请求。结果行合计 ¥29.4059，二者之差 ¥0.00002，是结果行逐步记账的舍入；校准没有作废的步。
  - `report.md` 只多了 5.2 一节的已花一行；`result.json` 除花费一节新增的 `spent` 与输入一节新增的 `spend` 外，与上一版报告完全相同，5.1 至 5.7 其余数值不变。
