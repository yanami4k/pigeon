# 正式跑与校准的统计分析

按正式跑分析计划（主判据、次要判据、设计灵敏度、校准取值规则、报告措辞）计算，输入为跑批器的输出目录：

- results.jsonl：每格、每题、每遍一行；缺了该有的字段即报错并指明文件、行与字段；
- identity.json（与 results.jsonl 同目录）：报告的设置一节、难度关的题面格式、压缩触发点取自这里；
- streams/tasks-<条件>-<遍次>/：会话清单 sessions-<步序>.json、.pigeon/sessions 下的会话文件与开工记忆快照
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
  [--classes-summary 两类用例预计算汇总.json] [--minimal-reserve 元]

# 校准
python -m pigeon_analysis calibration --results <results.jsonl> [...] --out <输出目录> \
  [--formal-valid-tasks N] [--compaction-trigger token 数] [--eligible 要做到的不为零的题的步序.json]

# 接口不可猜的测试文件清单（决策 316；静态规则，只读人的仓库、流清单与两类用例预计算结果，不读任何运行结果）
python -m pigeon_analysis unguessable --manifest <流清单 strands.json> --repo <人的仓库> \
  --classes-dir <两类用例预计算目录> --out data/unguessable-interfaces.json
```

入库的清单为 data/unguessable-interfaces.json，在看到正式结果之前生成。

--tasks 与 --eligible 给的是结果行的步序（seq，即该题在全流中的位置），不是清单里从 1 起的题号；结果行里有步序不在所给列表里即报错。

输出目录下为 report.md（报告）与 result.json（机器可读结果）。随机种子写死在 pigeon_analysis/constants.py，同一输入两次运行结果逐字相同。

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
- pigeon_analysis/calibration.py：校准取值规则与抽题
- pigeon_analysis/wording.py：报告的固定措辞
- pigeon_analysis/reader.py：结果行 → 规整表、身份头 → 设置（跑批器字段变动只改这里）
- pigeon_analysis/sessions.py：会话文件 → 记忆使用与检索的计数
- pigeon_analysis/report.py、cli.py：输出与命令行
