import math

import numpy as np
import pytest

from pigeon_analysis.primary import (
    analyze_primary,
    cell_task_means,
    paired_differences,
    select_tasks,
    sensitivity,
)
from pigeon_analysis.table import make_table
from sim import grid, rec, simulate

FAST = dict(flips=2000, boots=500)


class TestDifferences:
    def test_direction_and_denominator(self):
        # 00 = 0.2、01 = 0.4、10 = 0.6、11 = 0.8：推送差 = (0.6+0.8)/2 − (0.2+0.4)/2 = 0.4；检索差 0.2；交互 0
        df = make_table(grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}))
        d = paired_differences(cell_task_means(df, "score"))
        assert d["push"].tolist() == pytest.approx([0.4] * 3)
        assert d["search"].tolist() == pytest.approx([0.2] * 3)
        assert d["interaction"].tolist() == pytest.approx([0.0] * 3)

    def test_interaction_sign(self):
        # 推送只在能检索时有用：11 − 10 = 0.5，01 − 00 = 0 → 交互 0.5
        df = make_table(grid({"00": 0.2, "01": 0.2, "10": 0.2, "11": 0.7}))
        d = paired_differences(cell_task_means(df, "score"))
        assert d["interaction"].tolist() == pytest.approx([0.5] * 3)
        assert d["push"].tolist() == pytest.approx([0.25] * 3)

    def test_score_is_share_of_target_cases(self):
        df = make_table([{"cell": "00", "task": 1, "pass_no": 1, "f_total": 4, "f_passed": 3}])
        assert df["score"].tolist() == [0.75]

    def test_passes_averaged_equally(self):
        recs = grid({"00": 0.0, "01": 0.0, "10": lambda t, r: 0.2 if r == 1 else 0.6, "11": 0.4}, passes=(1, 2))
        means = cell_task_means(make_table(recs), "score")
        assert means["10"].tolist() == pytest.approx([0.4] * 3)


class TestSelection:
    def test_f_empty_excluded_from_denominator(self):
        recs = grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}, tasks=(1, 2))
        # 第 3 题 F 为空：照跑但不进分母；这里给它极端得分，若被计入会拉偏估计
        recs += [rec(c, 3, 1, None, f_total=0) for c in ("00", "01", "10", "11")]
        res = analyze_primary(make_table(recs), with_mixed=False, **FAST)
        assert res["fEmptyTasks"] == [3]
        assert res["validTasks"] == [1, 2]
        # F 为空的题单列，不算缺失题，也不因此把结论降格
        assert res["missingTasks"] == []
        assert res["exploratory"] is False
        assert res["effects"]["push"]["estimate"] == pytest.approx(0.4)

    def test_f_empty_row_score_is_nan_even_if_given(self):
        df = make_table([{"cell": "00", "task": 1, "pass_no": 1, "f_total": 0, "score": 1.0}])
        assert math.isnan(df["score"].iloc[0])

    def test_missing_pass_uses_other_passes(self):
        recs = grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}, passes=(1, 2))
        # 删掉 10 格第 2 遍第 1 题，并把第 1 遍改成 1.0：该格该题只按第 1 遍计
        recs = [r for r in recs if not (r["cell"] == "10" and r["task"] == 1 and r["pass_no"] == 2)]
        for r in recs:
            if r["cell"] == "10" and r["task"] == 1:
                r["f_passed"] = 10
        res = analyze_primary(make_table(recs), with_mixed=False, **FAST)
        assert res["validTasks"] == [1, 2, 3]
        assert res["perTask"]["push"][0] == pytest.approx((1.0 + 0.8) / 2 - 0.3)

    def test_cell_without_any_result_drops_task(self):
        recs = grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}, tasks=(1, 2, 3))
        recs = [r for r in recs if not (r["cell"] == "01" and r["task"] == 2)]
        sel = select_tasks(make_table(recs))
        assert sel["validTasks"] == [1, 3]
        assert sel["missingTasks"] == [{"task": 2, "cellsWithoutResult": ["01"], "reason": "cell-missing"}]

    def test_expected_task_without_rows_listed_missing(self):
        sel = select_tasks(make_table(grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}, tasks=(1, 2))), expected_tasks=[1, 2, 3])
        assert sel["missingTasks"] == [{"task": 3, "cellsWithoutResult": ["00", "01", "10", "11"], "reason": "no-rows"}]

    def test_missing_over_ten_percent_is_exploratory(self):
        tasks = tuple(range(1, 12))
        recs = grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}, tasks=tasks)
        # 11 道题缺 1 道：有效 10，缺失 1 = 10%，不降格
        recs1 = [r for r in recs if not (r["cell"] == "00" and r["task"] == 11)]
        assert analyze_primary(make_table(recs1), with_mixed=False, **FAST)["exploratory"] is False
        # 缺 2 道：有效 9，缺失 2 > 10%，降格
        recs2 = [r for r in recs1 if not (r["cell"] == "00" and r["task"] == 10)]
        res = analyze_primary(make_table(recs2), with_mixed=False, **FAST)
        assert res["exploratory"] is True
        assert res["missingRatio"] == pytest.approx(2 / 9)

    def test_baseline_unavailable_excluded_and_counted(self):
        # 第 2 题无法建立基线：结果行带标记、没有得分；排除在主判据之外、单独计数，不算缺失题、不降格
        recs = grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}, tasks=(1, 2, 3))
        for r in recs:
            if r["task"] == 2:
                r.pop("f_passed")
                r["f_total"] = None
                r["baseline_unavailable"] = 1.0
        res = analyze_primary(make_table(recs), with_mixed=False, **FAST)
        assert res["baselineUnavailableTasks"] == [2]
        assert res["validTasks"] == [1, 3]
        assert res["missingTasks"] == []
        assert res["exploratory"] is False
        # 由参数给出（汇总文件）时同样处理，即使结果行里没有这道题
        res = analyze_primary(make_table(grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}, tasks=(1, 3))),
                              expected_tasks=[1, 2, 3], baseline_unavailable=[2], with_mixed=False, **FAST)
        assert res["baselineUnavailableTasks"] == [2]
        assert res["missingTasks"] == []

    def test_invalid_pass_score_nan_counts_as_missing(self):
        # 行在但得分缺（例如判题故障记为缺失）：按缺失处理
        recs = grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}, tasks=(1, 2))
        for r in recs:
            if r["cell"] == "11" and r["task"] == 2:
                r.pop("f_passed")
        assert select_tasks(make_table(recs))["validTasks"] == [1]

    def test_duplicate_rows_keep_last(self):
        recs = grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}, tasks=(1,))
        recs.append(rec("11", 1, 1, 0.0))
        df = make_table(recs)
        assert df[(df.cell == "11")]["score"].tolist() == [0.0]


class TestAnalyze:
    def test_single_pass(self):
        df = simulate(n_tasks=20, passes=1, push=0.1, seed=1)
        res = analyze_primary(df, with_mixed=False, **FAST)
        assert res["passesPerCell"] == {"00": 1, "01": 1, "10": 1, "11": 1}
        assert res["nValid"] == 20
        assert res["effects"]["push"]["estimate"] is not None

    def test_deterministic_full(self):
        df = simulate(n_tasks=15, passes=2, push=0.05, seed=2)
        a = analyze_primary(df)
        b = analyze_primary(df)
        assert a == b

    def test_ceiling_definition(self):
        # 无推送两格 (00、01) 平均得分正好 0.90：推送触顶
        df = make_table(grid({"00": 0.85, "01": 0.95, "10": 0.9, "11": 0.9}))
        assert analyze_primary(df, with_mixed=False, **FAST)["baseline"]["push"]["ceiling"] is True
        df = make_table(grid({"00": 0.85, "01": 0.949, "10": 0.9, "11": 0.9}))
        assert analyze_primary(df, with_mixed=False, **FAST)["baseline"]["push"]["ceiling"] is False

    def test_search_ceiling_uses_no_search_cells(self):
        # 不能检索的两格 (00、10) 平均正好 0.90：检索触顶；无推送两格 (00、01) 只有 0.55，推送不触顶
        df = make_table(grid({"00": 0.85, "01": 0.25, "10": 0.95, "11": 0.3}))
        b = analyze_primary(df, with_mixed=False, **FAST)["baseline"]
        assert b["search"]["ceiling"] is True
        assert b["push"]["ceiling"] is False

    def test_relative_lift_over_matching_baseline(self):
        # 推送：0.4 ÷ 无推送两格 0.3 = 133%；检索：0.2 ÷ 不能检索两格 0.4 = 50%
        df = make_table(grid({"00": 0.2, "01": 0.4, "10": 0.6, "11": 0.8}))
        b = analyze_primary(df, with_mixed=False, **FAST)["baseline"]
        assert b["push"]["mean"] == pytest.approx(0.3)
        assert b["push"]["relative"] == pytest.approx(0.4 / 0.3)
        assert b["search"]["mean"] == pytest.approx(0.4)
        assert b["search"]["relative"] == pytest.approx(0.5)

    def test_mde_formal_formula(self):
        df = simulate(n_tasks=30, passes=2, seed=3)
        res = analyze_primary(df, with_mixed=False, **FAST)
        d = np.array(res["perTask"]["push"])
        assert res["effects"]["push"]["mdeFormal"] == pytest.approx(3.08 * d.std(ddof=1) / math.sqrt(30))

    def test_mixed_model_recovers_effect(self):
        df = simulate(n_tasks=40, passes=2, push=0.1, search=-0.05, v=0.005, seed=4)
        mm = analyze_primary(df, **FAST)["mixedModel"]
        assert mm["coef"]["push"] == pytest.approx(0.1, abs=0.03)
        assert mm["coef"]["search"] == pytest.approx(-0.05, abs=0.03)


class TestSensitivity:
    def eff(self, est, sig):
        return {"estimate": est, "holmSignificant": sig}

    def test_consistent(self):
        effects = {"push": self.eff(0.05, True), "search": self.eff(-0.01, False)}
        mixed = {"coef": {"push": 0.04, "search": -0.02}, "holmSignificant": {"push": True, "search": False}, "converged": True}
        assert sensitivity(effects, mixed) == {"sensitive": False, "byEffect": {"push": False, "search": False}}

    def test_significance_disagrees(self):
        effects = {"push": self.eff(0.05, True), "search": self.eff(-0.01, False)}
        mixed = {"coef": {"push": 0.04, "search": -0.02}, "holmSignificant": {"push": False, "search": False}, "converged": True}
        assert sensitivity(effects, mixed)["byEffect"] == {"push": True, "search": False}

    def test_direction_disagrees(self):
        effects = {"push": self.eff(0.01, False), "search": self.eff(0.01, False)}
        mixed = {"coef": {"push": 0.01, "search": -0.001}, "holmSignificant": {"push": False, "search": False}, "converged": True}
        assert sensitivity(effects, mixed)["byEffect"] == {"push": False, "search": True}

    def test_not_converged_not_compared(self):
        # 未收敛：即使方向与显著性都不一致也不比较，稳健性对照不可用
        effects = {"push": self.eff(0.05, True), "search": self.eff(0.01, False)}
        mixed = {"coef": {"push": -0.04, "search": -0.02}, "holmSignificant": {"push": False, "search": True}, "converged": False}
        assert sensitivity(effects, mixed) == {"sensitive": None, "byEffect": {}}

    def test_fit_failure(self):
        assert sensitivity({}, {"error": "x"})["sensitive"] is None
