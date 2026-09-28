# 分析脚本按预注册计划与合并后的结果行对齐（决策 222–226、243、255–261，基线 06de8fc）

范围：把 eval/analysis/ 下的分析脚本逐条对齐正式跑分析计划（docs/roadmap/formal-run-analysis-plan.md，入库提交 5807347）与合并推送记忆、每日沙箱之后 formal-v2 上跑批器的结果行、身份头与会话文件。不改 src/。分支 analysis-a2，基线为 analysis-a1 的 06de8fc。

## 一、提交

| 提交 | 内容 |
|---|---|
| 0f141e9 | 难度关、两种上限、花费两档、触顶注明、效率分列、记忆使用、读入层与身份头、会话文件计数，以及对应用例 |
| 042ef07 | 补用例：校准 v 用 01、11 两格，第 3 遍 v 用四格；复盘会话里的检索调用不计；步末字符数与字节数取值不同（变异 V1、V2、S4、F1 起初存活） |

## 二、改动与计划节号、决策号

| 计划节 | 决策 | 改动 | 位置 |
|---|---|---|---|
| 5.1 难度关 | 257 | 原按做成率 30%–70% 判，改为 01 格两遍、15 道题的平均部分得分（要做到的为零的步得分为空、不计入）。30% ≤ 平均 ≤ 80% 留下，> 80% 换仓，< 30% 输出"切为给用例名，01 格在同 15 道题上再跑两遍复测"；端点算在区间内。身份头题面格式为用例名（test-cases）时这批结果即复测：落进区间以用例名题面开跑，仍低于 30% 交项目负责人另定，高于 80% 计划未规定、同样交项目负责人。两遍平均相差超过 20 个百分点注明重跑波动大、仍按合计判；做成率照常计算、只作描述 | calibration.py difficulty_gate |
| 第 4 节 基线触顶 | 256 | 推送效应看 00、01，检索效应看 00、10，对照组平均部分得分 ≥ 90% 即在该效应的结论后加"（基线触顶）"。原只挂在"未测出"句后，现按计划原文挂在该效应的结论后，测出为正、为负同样挂 | primary.py analyze_primary（对照两格）；wording.py conclusion_sentences |
| 5.4 每步宽上限 | 259、171 | 原按实测最大 × 1.5 取整、不低于 150 轮 / 30 分钟推算，改为只看结果行 hitStepBudget：校准全部步都没撞即维持 300 轮、60 分钟，有一步撞了取 600 轮、120 分钟；只上调不下调，实测轮数与墙钟只作记录。最简 agent 与 Pigeon 共用同一个每步上限，结果行同样记撞上限，校准的全部步都看，分格列出撞的步数 | calibration.py _raise_only、step_budget_rule |
| 5.6 复盘上限 | 243 | 同一逻辑，只看结果行 hitReviewBudget（收尾与压缩前的复盘都算）：没撞维持 40 轮、15 分钟，撞了取 80 轮、30 分钟。临时墙钟原为 10 分钟，改为 15 分钟 | calibration.py review_cap_rule；constants.py |
| 5.2 花费 | 258、200 | ¥520 一档改为显式常数（原为 650 × 0.8）；C_base > ¥650 时输出"不自动删减条件或改跑法，交项目负责人裁决"并列出候选：加预算、只在非高峰时段跑、最简 agent 不跑；复盘每步平均花费另单列 | calibration.py cost_rule |
| 2.3 效应量 | 260 ⑤ | 相对提升 = 主效应 ÷ 对应对照两格的平均得分（推送除以 00、01，检索除以 00、10），a1 已实现，本次补变异 R1、R2 | primary.py _baseline 与 analyze_primary |
| 5.7 v、τ² 与降低比例 | 260 ⑦、224、219 | 校准的 v 为 01、11 两格各自按题算两遍差的方差的一半、再取简单平均；第 3 遍推算的 v 为四格各自算、再取简单平均，a1 已实现，本次补用例区分格子（042ef07）。公式与计划一致：校准 τ² = max(0, s² − v)，s² 为 ȳ(11, i) − ȳ(01, i) 的样本方差；MDE = 3.08 × √((τ² + v/R) ÷ n) × 1.3；第 3 遍 τ² = max(0, 两遍平均 dP(i) 的样本方差 − v/2)，降低比例 = 1 − √((τ² + v/3) ÷ (τ² + v/2))，检索差同法，取降低较多者 | sensitivity.py rerun_variance、calibration_design_sensitivity、third_pass_decision |
| 第 3 节 记忆使用 | 261 | 按计划逐项列出，不含"复盘记为反面教训的条数"：推送两格每步复盘后的条数与字符数（平均、中位、最大，另给每遍最后一步即一遍结束值）；干活与复盘各自的新增、改写、删除次数（只数写成功的）；干活与复盘各自的写满被拒次数；干活的 agent 在回复正文里标出记忆编号的次数与涉及的条目数；读取记忆所引文件的次数（旁证）；收尾与压缩前复盘次数、复盘花费。检索两格每步 search_sessions 与 read_session_entry 的调用次数、命中会话数。某项没有来源时记"无来源" | secondary.py memory_usage；sessions.py；report.py memory_usage_lines |
| 第 3 节 效率 | 199 | 干活与复盘分开报：干活为轮数、输入 token（未命中 / 命中）、输出 token、墙钟、花费（gateway.costCny，已减去复盘）；复盘为轮数、输入 token（未命中 / 命中）、输出 token、token 合计、墙钟、花费（gateway.reviewCostCny）。各格中位数与 90 分位；干活部分推、拉效应按题配对取差的中位数；复盘只在推送两格有，推送效应无从配对记空，检索效应取 ȳ(11) − ȳ(10) 的中位数 | secondary.py efficiency |
| 读入层 | — | 按合并后的字段对齐（见第三节）；每条题步结果行的必需字段与父对象不为 null 时的子字段缺失即报错，报错写明文件名、行号、条件、遍次、步序与缺的字段；identity.json 缺文件或缺字段同样报错；结果行的 runIdentity 与身份头摘要不一致报错；多个输出目录的设置不一致报错。值为 null 照常读成空，不补默认值 | reader.py |
| 设置一节 | 218、223、243、191 | 两份报告新增"设置（身份头）"：仓库、条件、题面格式、每步上限、模型设定、压缩配置（窗口、预留、保留最近、触发点）、记忆上限、复盘模板与复盘上限。校准报告另核对身份头里的临时值是否与计划一致（每步 300 轮 / 60 分钟、复盘 40 轮 / 15 分钟、记忆 12,000 字符）；5.3 未给压缩触发点时取身份头里的触发点 | report.py settings_lines；calibration.py temporary_settings_check、analyze_calibration |
| 输入一节 | 170 ③ | 正式报告列出各格验证工具故障次数合计（verifyToolFaults）与会话文件读取情况 | cli.py run_formal；report.py input_lines |

## 三、读入层字段对照

### 结果行（src/eval/stream-results.ts）

| 规整表列 | 结果行字段 | 说明 |
|---|---|---|
| task、pass_no | seq、attempt | |
| f_passed、f_total | judging.failToPass.passed、judging.failToPass.total | |
| score、solved | judging.score、judging.solved | 要做到的为零时为 null |
| p_failed、p_total | judging.passToPass.failed、judging.passToPass.total | |
| flaky_excluded | judging.excludedFlaky | |
| turns、wall_ms | turns、agentWallMs | 干活部分，含验证门与回炉，已减去复盘 |
| input_miss、input_hit、output_tokens | usage.input、usage.cacheRead、usage.output | 干活部分 |
| cost | gateway.costCny | 干活部分，已减去复盘 |
| review_cost | gateway.reviewCostCny | 不推送的条件为 null |
| peak_input | gateway.peakInputTokens | |
| review_closing、review_pre_compaction | review.closing、review.preCompaction | 新增 |
| review_turns、review_tokens、review_wall_ms | review.turns、review.tokens、review.wallMs | review_tokens 新增 |
| memory_chars、memory_bytes、memory_entries | memoryAtStart.entryChars、memoryAtStart.bytes、memoryAtStart.entries | |
| memory_chars_after、memory_entries_after | memoryAtEnd.entryChars、memoryAtEnd.entries | memory_entries_after 新增 |
| hit_step_budget、hit_review_budget | hitStepBudget、hitReviewBudget | |
| verify_tool_faults | verifyToolFaults | 新增 |
| baseline_unavailable | baselineUnavailable | string \| null，非空即无法建立基线 |

必需的顶层字段：condition、attempt、seq、kind、judging、baselineUnavailable、turns、usage、agentWallMs、memoryAtStart、memoryAtEnd、hitStepBudget、hitReviewBudget、review、gateway、verifyToolFaults、runIdentity。父对象不为 null 时必需的子字段：usage 的 input、cacheRead、output；judging 的 failToPass.passed、failToPass.total、score、solved、passToPass.failed、passToPass.total、excludedFlaky；gateway 的 costCny、reviewCostCny、peakInputTokens；review 的 closing、preCompaction、turns、tokens、wallMs、hitLimit；memoryAtStart 与 memoryAtEnd 的 bytes、entries、entryChars。a1 暂留的 memoryUsage、searchUsage 两个对象跑批器没有提供，映射删去，改由会话文件取数。

### 身份头（src/eval/stream-identity.ts，与 results.jsonl 同目录的 identity.json）

| 设置项 | 字段 |
|---|---|
| 身份摘要 | digest（与各结果行 runIdentity 核对） |
| 仓库、条件、选题 | core.repo、core.conditions、core.taskSelection |
| 题面格式与版式 | core.promptFormat、core.promptLayout |
| 每步上限 | core.budget.maxTurns、core.budget.wallClockMs |
| 模型设定 | core.agents.pigeon.provider、modelId、temperature、thinking、maxOutputTokens |
| 压缩配置 | core.agents.pigeon.compaction.contextWindow、reserveTokens、keepRecentTokens、thresholdTokens |
| 记忆上限 | core.agents.pigeon.memoryLimitChars |
| 复盘模板 | core.agents.pigeon.reviewTemplate |
| 复盘上限 | core.agents.pigeon.reviewBudget.maxTurns、reviewBudget.wallClockMs |

有 Pigeon 条件的输出目录必须带 core.agents.pigeon 下的全部上列字段；只有最简 agent 的目录不要求。

### 会话文件（结果行里没有、从现成来源读取的项）

结果行不记记忆写入、引用、检索与复盘 token 细分。跑批器在输出目录里保留了现成来源，读取方式如下：

- 作业目录 streams/tasks-<条件>-<遍次>/ 即该作业的治理根。每步完成时跑批器写 sessions-<步序>.json：当时 .pigeon/sessions 下全部会话文件的清单（相对会话根、分隔符 /、逐步累积）。某步的会话 = 该步清单减去同一作业上一个完成步的清单；作废尝试的会话已被跑批器移出治理根，不在清单里。
- 会话文件为 pi v4 JSONL：首行文件头，其余为条目（type 为 message 或 custom）。复盘会话由干活的会话分叉而来，开头带着干活会话的历史副本；复盘自己的部分从带 memoryReview 的 pigeon.run-start 条目开始，只数这之后的条目。没有这种条目的会话即干活的会话，回炉各轮是同一会话里的后续 Run。
- 每步开工时的记忆为 learned-snapshots/step-<步序>/learned/MEMORY.md。

| 项 | 来源与取法 |
|---|---|
| 干活 / 复盘的新增、改写、删除次数 | update_memory 工具结果的 details：written 为真时按 details.action 计 |
| 写满被拒次数 | 同上，details.rejected 为 full |
| 标出记忆编号的次数与涉及的条目数 | 干活会话里 assistant 消息的 text 块中 [L编号] 的出现次数与去重后的编号数；思考块不计 |
| 读取记忆所引文件的次数 | 干活会话里 read_file 调用的 path 与开工记忆各条目"引用："行的文件（去掉 ::符号，用户要求一类不计）比对：相同，或以 /引用路径 结尾 |
| 检索调用次数与命中会话数 | 干活会话里 search_sessions、read_session_entry 的调用次数；search_sessions 未出错的结果 details.hits 的 sessionId 去重计数 |
| 复盘的输入（未命中 / 命中）与输出 token | 复盘会话自己部分的 assistant 消息 usage.input、usage.cacheRead、usage.output 之和 |

有 streams/ 目录而某步的会话清单或会话文件缺失即报错；推送格开工时记忆有条目而缺开工记忆快照即报错；输出目录没有 streams/ 时这些计数整体记为"无来源"并在报告注明。最简 agent 没有会话文件，这些计数对它为空。

## 四、缺来源的项

计划第 3 节"记忆使用"与"效率"的各项都已找到现成来源，没有需要往跑批器里加字段的项。取法上有三处近似，报告里写明：

- 标出记忆编号按回复正文里所有 [L编号] 计，不要求前面紧跟"依据"二字（推送提示给的写法是"依据 [L3]"，模型也可能写成"依据 [L3]、[L5]"）。
- 读取记忆所引文件只看 read_file；经 run_command 用 cat、sed 等读取的不计（命令文本只能启发式解析）。
- 复盘花费以 gateway.reviewCostCny 为准；会话文件里的 usage.cost 为 0（模型占位价），不从会话文件重算花费。

## 五、原审计第九节与 260 的 11 条口径核对

| # | 口径 | 状态与位置 |
|---|---|---|
| 1 | 置换检验 p 值加 1 修正 | 已实现：stats.py sign_flip_pvalue，(次数 + 1) ÷ (翻转次数 + 1) |
| 2 | 学习曲线按全部 89 道题的时间顺序取位置 | 已实现：secondary.py time_positions；正式命令 --tasks 必填（cli.py） |
| 3 | 有效题为奇数时后半段差去掉正中一题 | 已实现：secondary.py half_difference |
| 4 | 检索效果同判触顶 | 已实现：primary.py analyze_primary 的 00、10 对照；本次按计划第 4 节改为挂在该效应的结论后（wording.py conclusion_sentences） |
| 5 | 直观换算改报相对提升 | 已实现：primary.py _baseline（分母为对应对照两格）；wording.py rel_clause |
| 6 | 混合模型不收敛时不做稳健性比较 | 已实现：primary.py sensitivity |
| 7 | 重跑波动按格求后简单平均 | 已实现：sensitivity.py rerun_variance；校准用 01、11，第 3 遍用四格 |
| 8 | 记忆上限按字符 | 已实现：calibration.py memory_cap_rule（memoryAtStart.entryChars、memoryAtEnd.entryChars） |
| 9 | 每步复盘后记记忆大小 | 已实现：reader.py 读 memoryAtEnd.entryChars 与 memoryAtEnd.entries；memory_cap_rule 用步末大小使最后一步的增长计入；记忆使用给每步复盘后大小与一遍结束值 |
| 10 | 推算最小可分辨效果用正式跑的有效题数 | 已实现：calibration 命令 --formal-valid-tasks，未给时不算 MDE（calibration.py analyze_calibration） |
| 11 | 结果行记撞宽上限与撞复盘上限两个标记 | 已实现并收紧：reader.py 读 hitStepBudget、hitReviewBudget；5.4、5.6 只以这两个标记判，去掉 a1 保留的"轮数或墙钟达到临时值"兜底 |

## 六、测试

在 Windows 开发机上（Python 3.13，依赖按 requirements.txt）实测：除模拟检验外 207 个用例全部通过，约 14 秒；模拟检验 5 个全部通过，168 秒。

新增与改写的用例：

- 难度关：三个出口；30%、80% 端点留下，按两遍合计的端点；看部分得分不看做成率；要做到的为零的步不计入；只看 01 格第 1、2 遍；两遍相差正好 20 个点不注明、超过注明且仍按合计判；用例名复测的三种出口；无数据。
- 每步与复盘上限：没撞维持临时值；撞了取两倍；轮数、墙钟达到临时值而标记为否不算撞；最简 agent 撞上限也算；没有标记不判。
- 花费：超出 ¥650 列出三个候选、其余两档不列；复盘花费单列。
- 触顶：测出为正、为负时同样挂在该效应的结论后，另一效应不挂。
- 效率：干活与复盘两组指标、干活花费与复盘花费分开、复盘的检索差为 11 − 10。
- 记忆使用：项目清单与计划逐项一致、不含反面教训一项；每遍结束值；没有来源的项记 None。
- v：校准用 01、11 两格（两格波动不同，只用一格可区分）；第 3 遍用四格。
- 读入层：字段对照；null 读成空；9 个顶层字段与 9 个子字段逐个缺失即报错并写明位置；身份头缺文件、缺 Pigeon 设置、只有最简 agent 时不要求、摘要不一致、多目录设置不一致。
- 会话文件：第 1 步的各项计数（复盘只数自己的部分、被拒的写入不算写成功、重复被拒不算写满、思考块与复盘副本里的编号不算、复盘里被拒的检索调用不算）；第 2 步只数新增的会话；不推送的格没有记忆计数；缺会话清单、缺开工记忆快照报错；没有 streams/ 记为不可用；引用文件的解析与路径比对。
- 命令行：两个命令对同一输入各跑两次逐字节相同；报告有设置一节与效率两表；撞上限时两种上限翻倍；用例名复测；缺字段时命令报错。

测试夹具 tests/runner_fixture.py 按合并后的结果行、身份头与会话文件字段造输出目录，两个命令的试跑也用它构造输入。

## 七、变异反向验证

在 042ef07 上逐个植入，每次只改一处，跑除模拟检验外的全部用例（207 个），记下变红的用例后写回原字节；41 次写回后各文件哈希与植入前一致，结束时工作区干净。41 处全部变红。

在 0f141e9 上第一次植入时 V1、V2、S4、F1 四处存活：原用例里两格的重跑波动相同、复盘会话自己的部分没有检索调用、步末字节数与字符数取值相同，区分不开。042ef07 补用例后四处变红。

| 变异 | 位置 | 结果 | 变红的用例 |
|---|---|---|---|
| G1 难度关用做成率而非部分得分 | calibration.py | 10 败 | TestDifficultyGate::test_endpoints_by_pooled_mean；TestDifficultyGate::test_f_empty_steps_not_counted；TestDifficultyGate::test_mean_of_partial_scores_not_solved_rate；TestDifficultyGate::test_only_01_cell_two_passes；TestDifficultyGate::test_rerun_gap_noted_but_pooled；TestDifficultyGate::test_retest_with_test_cases；TestDifficultyGate::test_three_exits_and_endpoints[0.3-stay]；TestDifficultyGate::test_three_exits_and_endpoints[0.55-stay]；TestDifficultyGate::test_three_exits_and_endpoints[0.8-stay]；TestDifficultyGate::test_three_exits_and_endpoints[0.85-switch-repo] |
| G2 难度关 80% 端点算作越界 | calibration.py | 2 败 | TestDifficultyGate::test_endpoints_by_pooled_mean；TestDifficultyGate::test_three_exits_and_endpoints[0.8-stay] |
| G3 难度关 30% 端点算作越界 | calibration.py | 2 败 | TestDifficultyGate::test_endpoints_by_pooled_mean；TestDifficultyGate::test_three_exits_and_endpoints[0.3-stay] |
| G4 低于 30% 的出口改为留下 | calibration.py | 4 败 | TestDifficultyGate::test_endpoints_by_pooled_mean；TestDifficultyGate::test_mean_of_partial_scores_not_solved_rate；TestDifficultyGate::test_retest_with_test_cases；TestDifficultyGate::test_three_exits_and_endpoints[0.25-retest-with-test-cases] |
| G5 高于 80% 的出口改为留下 | calibration.py | 2 败 | TestDifficultyGate::test_endpoints_by_pooled_mean；TestDifficultyGate::test_three_exits_and_endpoints[0.85-switch-repo] |
| G6 要做到的为零的步计入难度关 | calibration.py | 1 败 | TestDifficultyGate::test_f_empty_steps_not_counted |
| G7 难度关不限 01 格 | calibration.py | 3 败 | TestDifficultyGate::test_no_data；TestDifficultyGate::test_only_01_cell_two_passes；test_cli_calibration |
| G8 复测结果不按用例名题面分出口 | calibration.py | 2 败 | TestDifficultyGate::test_retest_with_test_cases；test_cli_calibration_retest_prompt_format |
| C1 推送效应的触顶对照改用 00、10 | primary.py | 3 败 | TestAnalyze::test_ceiling_definition；TestAnalyze::test_relative_lift_over_matching_baseline；TestAnalyze::test_search_ceiling_uses_no_search_cells |
| C2 检索效应的触顶对照改用 00、01 | primary.py | 2 败 | TestAnalyze::test_relative_lift_over_matching_baseline；TestAnalyze::test_search_ceiling_uses_no_search_cells |
| C3 触顶注明只挂在未测出句后 | wording.py | 1 败 | test_ceiling_appended_per_effect |
| K1 没撞上限时按临时值的一半下调 | calibration.py | 5 败 | TestReviewCap::test_flag_is_the_only_criterion；TestReviewCap::test_no_hit_keeps_temporary；TestStepBudget::test_flag_is_the_only_criterion；TestStepBudget::test_no_hit_keeps_temporary；test_cli_calibration |
| K2 每步撞上限另按轮数达到临时值判 | calibration.py | 2 败 | TestStepBudget::test_flag_is_the_only_criterion；TestStepBudget::test_no_flags |
| K3 复盘撞上限另按轮数达到临时值判 | calibration.py | 3 败 | TestReviewCap::test_flag_is_the_only_criterion；TestReviewCap::test_no_reviews；test_cli_calibration |
| K4 复盘临时墙钟仍为 10 分钟 | constants.py | 5 败 | TestReviewCap::test_flag_is_the_only_criterion；TestReviewCap::test_hit_doubles；TestReviewCap::test_no_hit_keeps_temporary；test_cli_calibration；test_cli_calibration_hits_double_caps |
| K5 复盘上限读每步的撞上限标记 | calibration.py | 3 败 | TestReviewCap::test_flag_is_the_only_criterion；TestReviewCap::test_hit_doubles；TestReviewCap::test_no_hit_keeps_temporary |
| K6 每步上限只看 Pigeon 两格 | calibration.py | 1 败 | TestStepBudget::test_any_calibration_step_counts |
| R1 推送的相对提升以 00 一格为底 | primary.py | 1 败 | TestAnalyze::test_relative_lift_over_matching_baseline |
| R2 检索的相对提升以 00 一格为底 | primary.py | 1 败 | TestAnalyze::test_relative_lift_over_matching_baseline |
| V1 校准的 v 只用 11 格 | sensitivity.py | 1 败 | TestVCells::test_calibration_uses_both_01_and_11 |
| V2 第 3 遍推算的 v 只用 01、11 两格 | sensitivity.py | 1 败 | TestVCells::test_third_pass_uses_all_four_cells |
| V3 v 不取一半 | sensitivity.py | 4 败 | TestRerunVariance::test_simple_average_of_cell_halves；TestThirdPassDecision::test_tau2_subtracts_half_v；TestVCells::test_calibration_uses_both_01_and_11；TestVCells::test_third_pass_uses_all_four_cells |
| V4 v 取最大格而非简单平均 | sensitivity.py | 3 败 | TestRerunVariance::test_simple_average_of_cell_halves；TestVCells::test_calibration_uses_both_01_and_11；TestVCells::test_third_pass_uses_all_four_cells |
| U1 记忆使用加回复盘反面教训条数 | secondary.py | 4 败 | test_cli_formal_baseline_unavailable_from_summary；test_cli_formal_deterministic；test_cli_formal_single_pass_no_third_pass；test_memory_usage_items_follow_plan |
| S1 复盘会话连同干活历史副本一起数 | sessions.py | 1 败 | TestSessions::test_counts_step1 |
| S2 写入次数把被拒的也算上 | sessions.py | 1 败 | TestSessions::test_counts_step1 |
| S3 某步的会话不减上一步的清单 | sessions.py | 2 败 | TestSessions::test_counts_step1；TestSessions::test_step2_counts_only_new_sessions |
| S4 检索计数把复盘会话也算上 | sessions.py | 1 败 | TestSessions::test_counts_step1 |
| S5 写满被拒按任何拒绝计 | sessions.py | 1 败 | TestSessions::test_counts_step1 |
| F1 步末字符数读成字节数 | reader.py | 1 败 | TestReader::test_mapping |
| F2 干活花费读成复盘花费 | reader.py | 1 败 | TestReader::test_mapping |
| F3 复盘撞上限读成每步撞上限 | reader.py | 1 败 | TestReader::test_nulls_read_as_empty |
| F4 步末条数读成开工时条数 | reader.py | 1 败 | TestReader::test_mapping |
| F5 复盘 token 读成复盘轮数 | reader.py | 1 败 | TestReader::test_mapping |
| F6 不查顶层缺字段 | reader.py | 10 败 | TestReader::test_missing_top_field_raises[baselineUnavailable]；TestReader::test_missing_top_field_raises[gateway]；TestReader::test_missing_top_field_raises[hitReviewBudget]；TestReader::test_missing_top_field_raises[hitStepBudget]；TestReader::test_missing_top_field_raises[kind]；TestReader::test_missing_top_field_raises[memoryAtEnd]；TestReader::test_missing_top_field_raises[review]；TestReader::test_missing_top_field_raises[runIdentity]；TestReader::test_missing_top_field_raises[verifyToolFaults]；test_cli_rejects_missing_field |
| F7 不查子字段 | reader.py | 9 败 | TestReader::test_missing_judging_subfield_raises；TestReader::test_missing_nested_field_raises[gateway-costCny]；TestReader::test_missing_nested_field_raises[gateway-peakInputTokens]；TestReader::test_missing_nested_field_raises[gateway-reviewCostCny]；TestReader::test_missing_nested_field_raises[memoryAtEnd-entryChars]；TestReader::test_missing_nested_field_raises[memoryAtStart-entries]；TestReader::test_missing_nested_field_raises[review-preCompaction]；TestReader::test_missing_nested_field_raises[review-tokens]；TestReader::test_missing_nested_field_raises[usage-cacheRead] |
| F8 身份头不查 Pigeon 设置 | reader.py | 4 败 | TestIdentity::test_missing_pigeon_setting[compaction]；TestIdentity::test_missing_pigeon_setting[memoryLimitChars]；TestIdentity::test_missing_pigeon_setting[reviewBudget]；TestIdentity::test_missing_pigeon_setting[reviewTemplate] |
| F9 不核对结果行的身份摘要 | reader.py | 1 败 | TestIdentity::test_row_digest_must_match |
| F10 验证工具故障读错字段 | reader.py | 1 败 | TestReader::test_mapping |
| P1 ¥520 端点算作越档 | calibration.py | 1 败 | TestCost::test_decision_boundaries[520.0-go] |
| P2 超出 ¥650 不列候选 | calibration.py | 1 败 | TestCost::test_owner_decides_lists_candidates |

承重改动与变异的对应：难度关的计量与三个出口、端点为 G1–G8；两个效应的触顶对照组为 C1–C3；两种上限只上调为 K1–K6；相对提升的分母为 R1、R2；v 的求法为 V1–V4；记忆使用去掉的一项为 U1；会话来源为 S1–S5；读入层的字段对齐为 F1–F10；花费两档为 P1、P2。

## 八、模拟检验（改动后重跑）

| 检验 | 结果 | 期望 |
|---|---|---|
| 零效果误报率（89 题、2 遍，1000 次） | 0.047；Holm 下任一显著 0.053 | 约 0.05 |
| 零效果误报率（有界离散得分，600 次） | 0.043 | 约 0.05 |
| 检出率，真实效果 5 个点（400 次） | 0.780 | 公式 0.800 |
| 检出率，真实效果 3 个点（400 次） | 0.335 | 公式 0.348 |
| 区间覆盖率（400 次） | 0.945 | 0.95 |

与 a1 审计第十节的结果逐项相同，误报率与检验力没有变坏（本次未改主判据与检验的计算）。

## 九、两个命令的试跑

输入由 tests/runner_fixture.py 按合并后的字段构造，含结果行、identity.json、各作业的会话清单、会话文件与开工记忆快照：

- 校准：按种子 20260927 在 1–89 中抽出的 15 道题，01、11 两格各两遍，最简 agent 一遍；75 条结果行、4 个作业、96 个会话文件。命令带 --eligible 与 --formal-valid-tasks 80，压缩触发点取自身份头。
- 正式跑：12 道题，四格各两遍，最简 agent 一遍；第 5 题要做到的为零，第 11 题在两类用例汇总里记为无法建立基线；108 条结果行、8 个作业、152 个会话文件。命令带 --tasks 与 --classes-summary。

两份报告的得分、花费与计数都是构造值，只用来检查两个命令走通全部分支与报告格式，不含任何实测结论。

### 校准报告

````markdown
# 校准分析报告

校准结果不进正式结论。

## 设置（身份头）

- 身份摘要 0123456789abcdef：仓库 strands；条件 ['search-only', 'search-push', 'minimal']；题面格式 test-files
  - 每步上限 300 轮、60 分钟
  - 模型 deepseek/deepseek-flash，温度 0，思考 off，单次输出上限 16384
  - 压缩：窗口 1000000、预留 16384、保留最近 20000、触发点 983616 token
  - 记忆上限 12000 字符；复盘模板 v1；复盘上限 40 轮、15 分钟

## 5.1 难度关

- 题面格式：test-files
- 01 格两遍平均部分得分 48.8%（30 个步结果、15 道题；要做到的为零的步不计入），各遍 第 1 遍 45.0%、第 2 遍 52.5%
- 判定：留在 strands（以测试文件路径题面开跑）
- 做成率（描述，不参与去留）：3.3%

## 5.2 花费与能跑几遍

- 每步平均花费（含复盘）：01 0.3700、11 0.3844、M 0.0800 元；其中复盘每步平均：01 0.0000、11 0.0144 元；已折回非高峰价：否
- C_pass = 147.71，C_M = 7.83，C_base = 303.26 元（≤ ¥520 按计划开跑；≤ ¥650 开跑但第 3 遍基本无望）
- 判定：按计划开跑

## 5.3 上下文峰值（只记录）

- 中位 36300、90 分位 41700、最大 42600（60 步）；压缩触发点 983616，超过其 80% 的步 0

## 5.4 每步宽上限

- 临时上限 300 轮、60 分钟；以结果行的撞上限标记为准，只上调不下调
- 撞上限的步：{}；实测最大 40 轮、10.0 分钟（只作记录）
- 判定：没有撞临时上限，正式维持 300 轮、60 分钟

## 5.5 记忆总量硬上限

- 按字符计；各遍每步平均增长 {'1': 180.0, '2': 180.0}（是否用了每步复盘后的大小：{'1': True, '2': True}）；两遍相差超过一倍：否
- 取用增长 180.0 × 30 → 取整 6000 → 上限 6000 字符

## 5.6 复盘上限

- 临时上限 40 轮、15 分钟；以结果行的撞上限标记为准，只上调不下调
- 撞上限的步：0；实测最大 11 轮、1.5 分钟（只作记录）
- 判定：没有撞临时上限，正式维持 40 轮、15 分钟

## 5.7 设计灵敏度

- 重跑波动 v = 0.047768（01、11 两格各自按题算两遍差的方差的一半，再取简单平均），因题而异 τ² = 0.000000（配对题 15 道；只用方差）
- 正式跑有效题 n = 80，k = 1.3：R = 2 时最小可分辨效果约 6.9 个百分点；R = 3 时最小可分辨效果约 5.6 个百分点
- 校准的记忆轨迹只有 15 道题，可能低估波动。

## 临时值核对

- 身份头与计划的临时值一致：每步上限 是，复盘上限 是，记忆上限 是

## 抽题核对

- 按种子 20260927 应抽 [10, 14, 16, 24, 31, 38, 40, 41, 47, 52, 60, 63, 64, 86, 88]；与结果中的题一致：是

## 输入

- 读入结果行 75 条，规整表记录 75 条
- 结果行里整列为空的字段：['baselineUnavailable']
- 会话文件（0123456789abcdef）：4 个作业、96 个会话文件
````

### 正式跑报告

````markdown
# 正式跑分析报告

## 结论（主判据）

- 在 10 道题、2 遍下，推送记忆使每步要做到的用例通过比例平均提高 15.3 个百分点，相对提升约 35.5%（95% 置信区间 [7.8, 22.2]；按题配对的符号翻转检验，Holm 校正后显著，p = 0.0074）。
- 在 10 道题、2 遍下，未测出可检索历史会话的改善：估计差 0.9 个百分点，相对提升约 1.9%（95% 置信区间 [-6.6, 8.4]）。本设计能以 80% 把握分辨的最小效果约为 12.5 个百分点，因此不能排除小于约 12.5 个百分点的效果。

## 主判据明细

- 有效题 10 道；要做到的为零的题 1 道：[5]
- 无法建立两类用例基线的题 1 道（排除在主判据之外）：[11]
- 各格遍数：{'00': 2, '01': 2, '10': 2, '11': 2}

| 效应 | 估计（百分点） | 95% 置信区间 | 双侧 p | Holm 门槛 | Holm 显著 | dz |
|---|---|---|---|---|---|---|
| 推送记忆 | 15.3 | [7.8, 22.2] | p = 0.0074 | 0.025 | 是 | 1.28 |
| 可检索历史会话 | 0.9 | [-6.6, 8.4] | p = 0.8974 | 0.05 | 否 | 0.07 |

- 推送效果的基线（无推送的 00、01 两格）平均得分 43.1%，相对提升约 35.5%；达到 90% 及以上为基线触顶：否。
- 检索效果的基线（不能检索的 00、10 两格）平均得分 50.3%，相对提升约 1.9%；达到 90% 及以上为基线触顶：否。
- 各格各遍平均得分（描述用）：00：第 1 遍 47.5、第 2 遍 43.8；01：第 1 遍 40.0、第 2 遍 41.2；10：第 1 遍 57.5、第 2 遍 52.5；11：第 1 遍 62.5、第 2 遍 61.3

## 稳健性分析（混合模型）

- 混合模型未收敛，稳健性对照不可用，主结论照符号翻转检验。
- 拟合告警：ConvergenceWarning: Gradient optimization failed, |grad| = 7.190299；ConvergenceWarning: Maximum Likelihood optimization failed to converge. Check mle_retvals；ConvergenceWarning: MixedLM optimization failed, trying a different optimizer may help.；ConvergenceWarning: Retrying MixedLM optimization with cg；ConvergenceWarning: Retrying MixedLM optimization with lbfgs；ConvergenceWarning: The Hessian matrix at the estimated parameter values is not positive definite.；ConvergenceWarning: The MLE may be on the boundary of the parameter space.

## 设置（身份头）

- 身份摘要 0123456789abcdef：仓库 strands；条件 ['neither', 'search-only', 'push-only', 'search-push', 'minimal']；题面格式 test-files
  - 每步上限 300 轮、60 分钟
  - 模型 deepseek/deepseek-flash，温度 0，思考 off，单次输出上限 16384
  - 压缩：窗口 1000000、预留 16384、保留最近 20000、触发点 983616 token
  - 记忆上限 12000 字符；复盘模板 v1；复盘上限 40 轮、15 分钟

## 次要判据（探索性）

- 交互效应：11.9 个百分点，95% 置信区间 [-1.2, 26.2]（探索性）
- 做成率：00 0.0%；01 0.0%；10 0.0%；11 10.0%
  - 推送记忆对做成率：5.0 个百分点，95% 置信区间 [0.0, 12.5]（探索性）
  - 可检索历史会话对做成率：5.0 个百分点，95% 置信区间 [0.0, 12.5]（探索性）
- 不许挂一类的失败：00 合计 0、每步 0.00、有失败的步 0；01 合计 0、每步 0.00、有失败的步 0；10 合计 0、每步 0.00、有失败的步 0；11 合计 0、每步 0.00、有失败的步 0；M 合计 0、每步 0.00、有失败的步 0
  - 推送记忆对每步失败数：0.00，95% 置信区间 [0.00, 0.00]（探索性）
  - 可检索历史会话对每步失败数：0.00，95% 置信区间 [0.00, 0.00]（探索性）
- 学习曲线（推送记忆）：斜率为 -2.5（个百分点 / 从第 1 题到最后一题；95% 置信区间 [-29.6, 21.8]，探索性）；后半段差 -1.9 个百分点
- 学习曲线（可检索历史会话）：斜率为 -29.8（个百分点 / 从第 1 题到最后一题；95% 置信区间 [-41.0, -7.2]，探索性）；后半段差 -13.1 个百分点
- 各格对最简 agent（M 只有一遍，区间偏宽；共同题 10 道）：00 13.1，[4.4, 22.5]；01 8.1，[-2.5, 18.8]；10 22.5，[8.1, 35.6]；11 29.4，[13.1, 46.3]

### 效率：干活（各格中位数 / 90 分位）

| 指标 | 00 | 01 | 10 | 11 | M | 推送差中位数 | 检索差中位数 |
|---|---|---|---|---|---|---|---|
| 轮数 | 40.00 / 40.00 | 40.00 / 40.00 | 40.00 / 40.00 | 40.00 / 40.00 | 40.00 / 40.00 | 0.00 | 0.00 |
| 输入 token（未命中） | 1000.00 / 1000.00 | 1000.00 / 1000.00 | 1000.00 / 1000.00 | 1000.00 / 1000.00 | 1000.00 / 1000.00 | 0.00 | 0.00 |
| 输入 token（命中） | 9000.00 / 9000.00 | 9000.00 / 9000.00 | 9000.00 / 9000.00 | 9000.00 / 9000.00 | 9000.00 / 9000.00 | 0.00 | 0.00 |
| 输出 token | 500.00 / 500.00 | 500.00 / 500.00 | 500.00 / 500.00 | 500.00 / 500.00 | 500.00 / 500.00 | 0.00 | 0.00 |
| 墙钟（毫秒） | 600000.00 / 600000.00 | 600000.00 / 600000.00 | 600000.00 / 600000.00 | 600000.00 / 600000.00 | 600000.00 / 600000.00 | 0.00 | 0.00 |
| 花费（元） | 0.35 / 0.40 | 0.35 / 0.40 | 0.35 / 0.40 | 0.35 / 0.40 | 0.08 / 0.08 | 0.00 | 0.00 |

### 效率：复盘（各格中位数 / 90 分位）

| 指标 | 00 | 01 | 10 | 11 | M | 推送差中位数 | 检索差中位数 |
|---|---|---|---|---|---|---|---|
| 轮数 | — | — | 6.00 / 11.00 | 6.00 / 11.00 | — | — | 0.00 |
| 输入 token（未命中） | — | — | 300.00 / 600.00 | 300.00 / 600.00 | — | — | 0.00 |
| 输入 token（命中） | — | — | 2500.00 / 5000.00 | 2500.00 / 5000.00 | — | — | 0.00 |
| 输出 token | — | — | 80.00 / 160.00 | 80.00 / 160.00 | — | — | 0.00 |
| token 合计 | — | — | 2880.00 / 5760.00 | 2880.00 / 5760.00 | — | — | 0.00 |
| 墙钟（毫秒） | — | — | 50000.00 / 90000.00 | 50000.00 / 90000.00 | — | — | 0.00 |
| 花费（元） | — | — | 0.01 / 0.02 | 0.01 / 0.02 | — | — | 0.00 |

- 干活的花费为网关计量的 gateway.costCny（已减去复盘），复盘花费为 gateway.reviewCostCny；复盘只在推送两格有，其检索差中位数为 ȳ(11) − ȳ(10) 按题配对。

### 记忆使用（探索性）

推送两格（计数为合计 / 每步平均；每步复盘后的大小为平均 / 中位 / 最大）：

| 项 | 10 | 11 |
|---|---|---|
| 每步复盘后的条数 | 6 / 6 / 12 | 6 / 6 / 12 |
| 每步复盘后的字符数 | 1170 / 1170 / 2160 | 1170 / 1170 / 2160 |
| 干活写入：新增 | 24 / 1.00 | 24 / 1.00 |
| 干活写入：改写 | 0 / 0.00 | 0 / 0.00 |
| 干活写入：删除 | 0 / 0.00 | 0 / 0.00 |
| 复盘写入：新增 | 28 / 1.17 | 28 / 1.17 |
| 复盘写入：改写 | 0 / 0.00 | 0 / 0.00 |
| 复盘写入：删除 | 0 / 0.00 | 0 / 0.00 |
| 干活写满被拒 | 0 / 0.00 | 0 / 0.00 |
| 复盘写满被拒 | 4 / 0.17 | 4 / 0.17 |
| 回复里标出记忆编号的次数 | 22 / 0.92 | 22 / 0.92 |
| 标出的条目数（每步去重） | 22 / 0.92 | 22 / 0.92 |
| 读取记忆所引文件的次数（旁证） | 22 / 0.92 | 22 / 0.92 |
| 收尾复盘次数 | 24 / 1.00 | 24 / 1.00 |
| 压缩前复盘次数 | 4 / 0.17 | 4 / 0.17 |
| 复盘花费（元） | 0.34 / 0.01 | 0.34 / 0.01 |

- 10 各遍结束时的记忆：第 1 遍（第 12 题后）12 条、2160 字符；第 2 遍（第 12 题后）12 条、2160 字符
- 11 各遍结束时的记忆：第 1 遍（第 12 题后）12 条、2160 字符；第 2 遍（第 12 题后）12 条、2160 字符

检索两格（合计 / 每步平均）：

| 项 | 01 | 11 |
|---|---|---|
| search_sessions 调用次数 | 24 / 1.00 | 24 / 1.00 |
| read_session_entry 调用次数 | 0 / 0.00 | 0 / 0.00 |
| 命中会话数（每步去重） | 24 / 1.00 | 40 / 1.67 |

- 写入次数只数写成功的；标出记忆编号按干活的 agent 回复正文里的 [L编号] 计；读取所引文件按 read_file 的路径与开工时记忆各条目的引用文件比对；检索计数只数干活的会话。

## 第 3 遍补跑判定（只看预算与波动）

- v = 0.042330；剩余预算 B = 614.29 元；C3 = 19.11 元
- 推送记忆：τ² = 0.000000，第 3 遍可把最小可分辨效果降低 18.4%
- 可检索历史会话：τ² = 0.000000，第 3 遍可把最小可分辨效果降低 18.4%
- 判定：补第 3 遍

## 输入

- 读入结果行 108 条，规整表记录 108 条
- 结果行里整列为空的字段：['baselineUnavailable']
- 会话文件（0123456789abcdef）：8 个作业、152 个会话文件
- 验证工具故障次数（各格合计）：00 2；01 2；10 2；11 2
````

## 十、待裁决

1. 5.4 每步宽上限看哪些步。选项 A：校准的全部步（01、11 与最简 agent，现实现；最简 agent 与 Pigeon 共用同一个每步上限，结果行同样记撞上限）。选项 B：只看 Pigeon 两格（a1 的做法）。
2. 基线触顶的挂法。选项 A：挂在该效应的结论后，测出与未测出都挂（现实现，照计划第 4 节原文）。选项 B：只挂在"未测出"句后（a1 的做法，与计划开头"未测出改善（基线触顶）"的写法一致）。
3. 标出记忆编号的计法。选项 A：回复正文里所有 [L编号]（现实现）。选项 B：只计紧跟"依据"的 [L编号]。
4. 难度关的用例名复测高于 80%：计划未规定。现输出"计划未规定，交项目负责人裁决"。选项 A：维持。选项 B：按 197 换仓。
