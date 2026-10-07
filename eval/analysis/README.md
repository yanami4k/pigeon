# 正式跑与校准的统计分析

按正式跑分析计划（主判据、次要判据、设计灵敏度、校准取值规则、报告措辞）计算，输入为跑批器的输出目录：

- results.jsonl：每格、每题、每遍一行；缺了该有的字段即报错并指明文件、行与字段；
  外部 agent 条件（跑批器的实验设施，条件名 ext-<名字>）读成以条件名为格的行：不是 Pigeon，不要求身份头里的 Pigeon 段、不读会话文件；四格与最简 agent 的分析不受影响；
- identity.json（与 results.jsonl 同目录）：报告的设置一节、难度关的题面格式、压缩触发点取自这里；
- streams/tasks-<条件>-<遍次>/：会话清单 sessions-<步序>.json、.pigeon/state/sessions（旧布局为 .pigeon/sessions，两种都能读）下的会话文件与开工记忆快照
  learned-snapshots/step-<步序>/，记忆使用与检索的计数、复盘的 token 细分取自这里；没有这个目录时这些计数记为无来源。

## 安装

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt   # Windows 为 .venv\Scripts\pip
```

## 运行

在本目录下：

```sh
# 正式跑：四格与最简 agent 的结果文件可一并给出，也可分多个文件
python -m pigeon_analysis formal --results <results.jsonl> [...] --out <输出目录> --tasks 全部题的步序.json \
  [--classes-summary 两类用例预计算汇总.json] [--minimal-reserve 元] \
  [--unguessable data/unguessable-interfaces.json [--case-results <输出目录>/rejudge/cases.jsonl ...]]

# 校准
python -m pigeon_analysis calibration --results <results.jsonl> [...] --out <输出目录> \
  [--formal-valid-tasks N] [--compaction-trigger token 数] [--eligible 要做到的不为零的题的步序.json]

# 接口不可猜的测试文件清单（决策 316；静态规则，只读人的仓库、流清单与两类用例预计算结果，不读任何运行结果）
python -m pigeon_analysis unguessable --manifest <流清单 strands.json> --repo <人的仓库> \
  --classes-dir <两类用例预计算目录> --out data/unguessable-interfaces.json

# 题面的接口说明数据（决策 374；同样只读人的仓库、流清单与两类用例预计算结果）；--coverage 另出覆盖检查
python -m pigeon_analysis task-interfaces --manifest <流清单 strands.json> --repo <人的仓库>   --classes-dir <两类用例预计算目录> --out data/task-interfaces.json [--coverage <覆盖检查.json>]
```

入库的清单为 data/unguessable-interfaces.json，在看到正式结果之前生成；入库前以仓库的 biome 排版（只改空白，内容不变）。formal 给了 --unguessable 即另做剔除这些用例的
敏感性分析（与主判据同一检验、置信区间与 Holm 校正），报告与主判据并列。剔除用例在各行是否通过，优先取跑批器
eval stream-rejudge 按保存的改动重判、与原结果行逐项一致的逐用例结果（--case-results），其次取结果行的失败用例列表；
都定不了的行从该分析中去掉并在报告里逐行列出原因；去掉的行超过该分析所用行数的 5% 时，报告在结论一节与敏感性
分析一节醒目注明，并写明对结论的可能影响。

接口说明数据为 data/task-interfaces.json，同样在开跑前生成、以 biome 排版后入库。它记清单摘要（与跑批器身份头的
manifestDigest 同一算法）与按步序的接口说明：名单两段里的测试文件（人在该步的最终版本）导入的、或以字符串补丁目标
引用的项目内模块与名字，开工代码里没有的逐个附人的代码里的签名（抽取规则与局限见 pigeon_analysis/task_interface.py
的模块说明）。跑批器 eval stream 给 --task-interfaces 即在题面名单之后渲染这一节，清单摘要不符即拒绝开跑。
覆盖检查用 316 的规则、把题面换成带接口说明的新题面重判，列出仍判为接口不可猜的文件与用例。

--tasks 与 --eligible 给的是结果行的步序（seq，即该题在全流中的位置），不是清单里从 1 起的题号；结果行里有步序不在所给列表里即报错。

输出目录下为 report.md（报告）与 result.json（机器可读结果）。随机种子写死在 pigeon_analysis/constants.py，同一输入两次运行结果逐字相同。

## 对比评测（两组）

按 docs/roadmap/comparative-eval-analysis-plan.md 计算 Pigeon 组（P）与对照组（D）的比较。两组的条件名由命令行给：
--group-a 为 Pigeon 组（例如 pigeon-docker），--group-b 为对照组（外部 agent 条件，ext-<名字>）；结果文件里其余条件的行跳过。

```sh
# 正式结果：主判据（部分得分按题配对差、符号翻转检验、自助法区间、混合模型对照、dz、相对差、最小可分辨差距 M）、
# 次要判据（做成与否、不许挂一类、随题推进、花费与效率、撞上限与作废、Pigeon 的机制使用）与固定措辞
python -m pigeon_analysis comparative --results <results.jsonl> [...] --out <输出目录> \
  --group-a pigeon-docker --group-b ext-<名字> [--tasks 全部题的步序.json] [--classes-summary 两类用例预计算汇总.json]

# 试跑：正式跑预算、撞上限的步、工作树占盘推算、网关留存与思考块签名核对、高峰暂停、作废与缺失；不算两组得分之差
python -m pigeon_analysis comparative-pilot --results <results.jsonl> [...] --out <输出目录> \
  --group-a pigeon-docker --group-b ext-<名字> [--tasks 步序.json] [--free-gb 服务器剩余空间] [--eligible 要做到的不为空的题的步序.json]
```

- 题一律用步序（结果行的 seq）；跑批命令的 --tasks 用的是清单里从 1 起的题号，两者不同。不给 --tasks 即按结果行里出现的步序。
- 两组都不限轮数（决策 398）：撞每步上限只看墙钟（终态 wall-clock-limit 或 agent 用时达到身份头的墙钟上限）。结果行的
  hitStepBudget 还把"请求数达到身份头的 maxTurns"算作撞上限，报告里只并列、不用它判。
- 花费按非高峰价折算：网关逐请求计价、高峰整条翻倍，非高峰价对用量是线性的，每步的折算花费由结果行的用量合计按
  constants.py 的非高峰价目算出；实付不在折算的 1–2 倍之间的步列为价目对不上。
- 作业目录里另读的：agent 每次运行的尝试目录（pigeon-docker/ 或 external/ 下的 step-<步序>/try-<n>，尝试数减一即作废重做次数）；
  Pigeon 组治理根里的会话文件（检索调用与命中会话、派出的 worker 与角色、裁剪、压缩、截断续跑；没有会话根即记为未记录）；
  试跑另读网关留存 gateway/（每题体积、存全量与截断的请求、回复状态、多轮请求的 400、思考块签名）与输出目录的 peak-pauses.jsonl。
  只数计数与体积，不把会话或请求的内容写进报告。
- 主检验与自助法的随机种子另设（COMPARATIVE_PERMUTATION_SEED、COMPARATIVE_BOOTSTRAP_SEED），与上一轮的种子分开。

## 测试

```sh
python -m pytest            # 全部，含几分钟的模拟检验
python -m pytest -m "not slow"   # 跳过模拟检验
```

测试不在 npm run verify 内。

## 结构

- pigeon_analysis/table.py：规整表（计算核心的唯一输入）
- pigeon_analysis/stats.py：符号翻转、Holm、自助法、标准化效应
- pigeon_analysis/primary.py：主判据与混合模型对照
- pigeon_analysis/secondary.py：次要判据
- pigeon_analysis/sensitivity.py：设计灵敏度与第 3 遍规则
- pigeon_analysis/unguessable.py：接口不可猜的测试文件清单（316）
- pigeon_analysis/task_interface.py：题面的接口说明数据与覆盖检查（374）
- pigeon_analysis/interface.py：剔除接口不可猜用例的敏感性分析（316）
- pigeon_analysis/calibration.py：校准取值规则与抽题
- pigeon_analysis/wording.py：报告的固定措辞
- pigeon_analysis/reader.py：结果行 → 规整表、身份头 → 设置（跑批器字段变动只改这里）
- pigeon_analysis/sessions.py：会话文件 → 记忆使用与检索的计数
- pigeon_analysis/comparative.py：对比评测的读入、主判据与次要判据
- pigeon_analysis/comparative_sources.py：对比评测从作业目录读的计量（尝试目录、会话文件里的机制计数、网关留存、高峰暂停）
- pigeon_analysis/comparative_pilot.py：对比评测试跑的取值规则
- pigeon_analysis/comparative_report.py：对比评测的固定措辞与报告
- pigeon_analysis/report.py、cli.py：输出与命令行
