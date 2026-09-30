"""正式跑分析计划里事先写定的常数（分析计划第 1–5 节；决策 199、200、201、202、219、222–226、243、255–261）。

这些数值在看到正式结果之前写定，之后不改；随机种子一律写死，同一输入两次运行结果逐字相同。
"""

# 四格：(推, 拉)，00 = 都没有，01 = 只能检索，10 = 只推送，11 = 推加拉；M 为最简 agent
CELLS = ("00", "01", "10", "11")
MINIMAL = "M"

# 主判据（1.5、1.6）：双侧，总误报率 5%，Holm 两步
ALPHA = 0.05
PERMUTATIONS = 100_000
BOOTSTRAPS = 10_000
PERMUTATION_SEED = 202609271
BOOTSTRAP_SEED = 202609272
CI_LEVEL = 0.95

# 缺失题超过有效题的这一比例，结论降格为探索性（1.4）
MISSING_EXPLORATORY_RATIO = 0.10

# 接口不可猜的敏感性分析（316）：剔除用例结果定不了而去掉的行超过该分析所用行数的这一比例，报告里醒目注明
INTERFACE_DROPPED_WARN_RATIO = 0.05

# 基线触顶（第 4 节、256）：各效应的对照两格平均得分达到这一值及以上
CEILING_SCORE = 0.90

# 学习曲线的描述用滑动平均窗口（第 2 节）
SMOOTHING_WINDOW = 9

# 设计灵敏度（2.4、5.7）：2.24 对应 Holm 第一步的双侧 2.5%，0.84 对应 80% 把握；k 为 219 的余量
MDE_Z_SUM = 2.24 + 0.84
MDE_MARGIN_K = 1.3

# 正式跑（200、258）：保底计划不超过 ¥520 按计划开跑，¥520 到 ¥650 开跑但第 3 遍基本无望，超过 ¥650 交项目负责人裁决
BUDGET_YUAN = 650.0
BUDGET_COMFORT_YUAN = 520.0
FORMAL_TASKS = 89
COST_MARGIN = 1.1

# 第 3 遍（224）：能把最小可分辨效果降低至少一成
THIRD_PASS_MIN_REDUCTION = 0.10

# 校准抽题（219，226 按默认处理）
SAMPLE_SEED = 20260927
CALIBRATION_TASKS = 15

# 难度关（5.1、257）：01 格两遍的平均部分得分，端点算在区间内
DIFFICULTY_LOW = 0.30
DIFFICULTY_HIGH = 0.80
DIFFICULTY_PASS_GAP = 0.20

# 上下文峰值（5.3、218）：超过压缩触发点的这一比例即报告
CONTEXT_WARN_RATIO = 0.80

# 每步宽上限（5.4、259）：校准时的临时值；校准中有一步撞了即正式取两倍，只上调不下调
STEP_TEMP_TURNS = 300
STEP_TEMP_WALL_MIN = 60
# 复盘上限（5.6、243）：同一逻辑
REVIEW_TEMP_TURNS = 40
REVIEW_TEMP_WALL_MIN = 15
CAP_RAISE_FACTOR = 2

# 记忆总量硬上限（5.5、223）；校准时的临时上限即 MEMORY_MAX_CHARS
MEMORY_GROWTH_STEPS = 30
MEMORY_ROUND = 1000
MEMORY_MIN_CHARS = 2200
MEMORY_MAX_CHARS = 12000
