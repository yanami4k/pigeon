import math

import pytest

from pigeon_analysis.sensitivity import (
    calibration_design_sensitivity,
    mde,
    rerun_variance,
    step_costs,
    third_pass_decision,
    third_pass_reduction,
)
from pigeon_analysis.table import make_table
from sim import rec


def spent_of(df, extra=0.0):
    """已花的汇总：网关累计 = 结果行合计 + extra（作废的步与探测只记在网关）。"""
    rows = float(step_costs(df).sum(skipna=True))
    return {"gatewayCny": rows + extra, "rowsCny": rows, "difference": extra, "byDir": []}


def decide(df, extra=0.0, **kw):
    return third_pass_decision(df, spent=spent_of(df, extra), **kw)


def two_pass(cell, task, y1, y2, **kw):
    return [rec(cell, task, 1, y1, **kw), rec(cell, task, 2, y2, **kw)]


class TestRerunVariance:
    def test_simple_average_of_cell_halves(self):
        # 01：e = 0.2、0、−0.2，样本方差 0.04，一半 0.02；11：e = 0.1、0.3，样本方差 0.02，一半 0.01；
        # 对格子简单平均 0.015（按自由度加权合并则为 0.01667，两者不同）
        recs = two_pass("01", 1, 0.5, 0.3) + two_pass("01", 2, 0.4, 0.4) + two_pass("01", 3, 0.3, 0.5)
        recs += two_pass("11", 1, 0.6, 0.5) + two_pass("11", 2, 0.8, 0.5)
        r = rerun_variance(make_table(recs), ("01", "11"))
        assert r["cellsPooled"] == 2
        assert r["v"] == pytest.approx((0.04 / 2 + 0.02 / 2) / 2)

    def test_f_empty_and_single_pass_tasks_ignored(self):
        recs = two_pass("01", 1, 0.5, 0.3) + two_pass("01", 2, 0.4, 0.2)
        recs += [rec("01", 3, 1, None, f_total=0), rec("01", 3, 2, None, f_total=0)]
        recs += [rec("01", 4, 1, 0.9)]
        r = rerun_variance(make_table(recs), ("01",))
        assert r["byCell"]["01"]["n"] == 2

    def test_only_one_pass_has_no_variance(self):
        r = rerun_variance(make_table([rec("01", 1, 1, 0.5), rec("01", 2, 1, 0.4)]), ("01",))
        assert r["v"] is None


class TestVCells:
    """v 的求法（5.7、260 第⑦条）：校准用 01、11 两格，第 3 遍推算用四格，各格按题算两遍差的方差的一半再简单平均。"""

    @staticmethod
    def cell_rows(cell, spread, tasks=(1, 2, 3), base=0.5):
        # 两遍之差 e = 0、spread、2·spread：样本方差 spread²，一半 spread²/2
        recs = []
        for k, t in enumerate(tasks):
            recs += two_pass(cell, t, base + k * spread / 2, base - k * spread / 2)
        return recs

    def test_calibration_uses_both_01_and_11(self):
        df = make_table(self.cell_rows("01", 0.2) + self.cell_rows("11", 0.1))
        r = calibration_design_sensitivity(df, 80)
        assert r["v"] == pytest.approx((0.2 ** 2 / 2 + 0.1 ** 2 / 2) / 2)

    def test_third_pass_uses_all_four_cells(self):
        recs = []
        for c, sp in (("00", 0.3), ("01", 0.1), ("10", 0.2), ("11", 0.1)):
            recs += self.cell_rows(c, sp)
        res = decide(make_table(recs), minimal_reserve=0.0)
        assert res["v"] == pytest.approx(sum(x ** 2 / 2 for x in (0.3, 0.1, 0.2, 0.1)) / 4)


class TestMde:
    def test_formula(self):
        assert mde(0.01, 0.02, 2, 89) == pytest.approx((2.24 + 0.84) * math.sqrt((0.01 + 0.02 / 2) / 89) * 1.3)
        assert mde(0.0, 0.02, 3, 50, k=1.0) == pytest.approx(3.08 * math.sqrt(0.02 / 3 / 50))

    def test_more_passes_never_worse(self):
        assert mde(0.01, 0.02, 3, 89) < mde(0.01, 0.02, 2, 89)


class TestCalibrationSensitivity:
    def make(self, d_values, e_values):
        """01 格两遍得分固定为 0.4 ± e/2；11 格为 0.4 + d ± e/2：各格两遍平均之差正好为 d。"""
        recs = []
        for i, (d, e) in enumerate(zip(d_values, e_values), start=1):
            recs += two_pass("01", i, 0.4 + e / 2, 0.4 - e / 2)
            recs += two_pass("11", i, 0.4 + d + e / 2, 0.4 + d - e / 2)
        return make_table(recs)

    def test_tau2_from_variance_only(self):
        d = [0.1, 0.3, -0.1, 0.2]
        e = [0.1, -0.1, 0.1, -0.1]
        res = calibration_design_sensitivity(self.make(d, e), formal_tasks=89)
        v = res["v"]
        s2 = sum((x - sum(d) / 4) ** 2 for x in d) / 3
        assert res["s2"] == pytest.approx(s2)
        assert res["tau2"] == pytest.approx(max(0.0, s2 - v))
        assert res["mde"]["2"] == pytest.approx(mde(res["tau2"], v, 2, 89))
        assert res["mde"]["3"] == pytest.approx(mde(res["tau2"], v, 3, 89))

    def test_mean_of_d_does_not_matter(self):
        # 只用方差：把每题的 d 整体平移，结果不变
        e = [0.1, -0.1, 0.1, -0.1]
        a = calibration_design_sensitivity(self.make([0.1, 0.3, -0.1, 0.2], e), formal_tasks=89)
        b = calibration_design_sensitivity(self.make([0.6, 0.8, 0.4, 0.7], e), formal_tasks=89)
        assert a["tau2"] == pytest.approx(b["tau2"])
        assert a["mde"] == pytest.approx(b["mde"])

    def test_tau2_clamped_at_zero(self):
        res = calibration_design_sensitivity(self.make([0.1, 0.1, 0.1, 0.1], [0.3, -0.3, 0.2, -0.2]), formal_tasks=89)
        assert res["tau2"] == 0.0


class TestThirdPassReduction:
    def test_no_heterogeneity(self):
        assert third_pass_reduction(0.0, 0.02) == pytest.approx(1 - math.sqrt(2 / 3))

    def test_half_v(self):
        assert third_pass_reduction(0.01, 0.02) == pytest.approx(1 - math.sqrt(5 / 6))

    def test_boundary_ten_percent(self):
        # τ² = x·v 时降低比例为 1 − √((x + 1/3)/(x + 1/2))；x = (0.405 − 1/3)/0.19 时正好一成
        x = (0.81 * 0.5 - 1 / 3) / (1 - 0.81)
        assert third_pass_reduction(x * 0.02, 0.02) == pytest.approx(0.10)

    def test_zero_everything(self):
        assert third_pass_reduction(0.0, 0.0) == 0.0


def formal_two_pass(delta, dp_spread=0.0, cost=1.0, review=0.5, minimal=True):
    """四格两遍、3 道题：各格第 1、2 遍分别为 m ± δ_i（重跑噪声），推送格额外加 dp_spread·(i−2)（推送效果因题而异）。"""
    base = {"00": 0.3, "01": 0.35, "10": 0.4, "11": 0.45}
    recs = []
    for i, dl in enumerate(delta, start=1):
        for c, m in base.items():
            if c[0] == "1":
                m += dp_spread * (i - 2)
            rc = review if c[0] == "1" else None
            for r, y in ((1, m + dl), (2, m - dl)):
                recs.append(rec(c, i, r, y, cost=cost, review_cost=rc))
        if minimal:
            recs.append(rec("M", i, 1, 0.2, cost=cost))
    return make_table(recs)


class TestThirdPassDecision:
    def test_budget_and_costs(self):
        res = decide(formal_two_pass([0.05, -0.05, 0.1]))
        # 四格：24 步 × 1 元 + 推送两格 12 次复盘 × 0.5 元 = 30；C3 = 30 / 2 × 1.1
        assert res["fourCellSpent"] == pytest.approx(30.0)
        assert res["c3"] == pytest.approx(16.5)
        assert res["minimalSpent"] == pytest.approx(3.0)
        assert res["remaining"] == pytest.approx(650 - 33)
        assert res["byEffect"]["push"]["tau2"] == 0.0
        assert res["bestReduction"] == pytest.approx(1 - math.sqrt(2 / 3))
        assert res["decision"] is True

    def test_tau2_subtracts_half_v(self):
        # 各格同题两遍之差 e = 2δ = 0.1、−0.1、0.2：四格合并的方差 0.18667/8 = 0.023333，v = 0.011667；
        # 推送差因题而异 −0.1、0、0.1：s² = 0.01；τ² = s² − v/2 = 0.0041667（两遍平均后噪声为 v/2）
        res = decide(formal_two_pass([0.05, -0.05, 0.1], dp_spread=0.1))
        assert res["v"] == pytest.approx(0.18666667 / 8 / 2)
        push = res["byEffect"]["push"]
        assert push["s2"] == pytest.approx(0.01)
        assert push["tau2"] == pytest.approx(0.01 - res["v"] / 2)
        assert push["reduction"] == pytest.approx(third_pass_reduction(0.01 - res["v"] / 2, res["v"]))

    def test_budget_boundary_inclusive(self):
        df = formal_two_pass([0.05, -0.05, 0.1])
        assert decide(df, budget=33 + 16.5)["decision"] is True
        assert decide(df, budget=33 + 16.49)["decision"] is False

    def test_large_heterogeneity_blocks(self):
        # 推送效果因题差异大、重跑噪声小：第 3 遍几乎帮不上忙
        res = decide(formal_two_pass([0.01, -0.01, 0.01], dp_spread=0.3))
        assert res["byEffect"]["push"]["reduction"] < 0.10
        # 检索差不含因题差异，第 3 遍能降低 18%：取降低较多者
        assert res["byEffect"]["search"]["reduction"] == pytest.approx(1 - math.sqrt(2 / 3))
        assert res["decision"] is True

    def test_both_effects_heterogeneous_blocks(self):
        df = formal_two_pass([0.01, -0.01, 0.01], dp_spread=0.3)
        # 让检索格也随题大幅变化：01、11 两格再加一项
        df.loc[df.cell.isin(["01"]), "score"] += (df.loc[df.cell.isin(["01"]), "task"] - 2) * 0.3
        res = decide(df)
        assert res["bestReduction"] < 0.10
        assert res["reductionOk"] is False
        assert res["decision"] is False

    def test_spent_is_gateway_total_not_rows(self):
        """作废的步与开跑前探测只记在网关：已花取网关累计，结果行合计与差额并列给出；C3 仍按结果行。"""
        df = formal_two_pass([0.05, -0.05, 0.1])
        res = decide(df, extra=5.0)
        assert res["spentGateway"] == pytest.approx(38.0)
        assert res["spentRows"] == pytest.approx(33.0)
        assert res["spentDifference"] == pytest.approx(5.0)
        assert res["remaining"] == pytest.approx(650 - 38)
        assert res["c3"] == pytest.approx(16.5)
        # 按结果行算够、按网关算不够：以网关为准
        assert decide(df, budget=33 + 16.5)["decision"] is True
        assert decide(df, extra=5.0, budget=33 + 16.5)["decision"] is False

    def test_spent_is_required(self):
        with pytest.raises(TypeError):
            third_pass_decision(formal_two_pass([0.05, -0.05, 0.1]))

    def test_minimal_not_run_requires_reserve(self):
        df = formal_two_pass([0.05, -0.05, 0.1], minimal=False)
        assert decide(df)["decision"] is None
        res = decide(df, minimal_reserve=100.0)
        assert res["remaining"] == pytest.approx(650 - 30 - 100)
        assert res["decision"] is True

    def test_does_not_look_at_effect_mean(self):
        a = decide(formal_two_pass([0.05, -0.05, 0.1]))
        df = formal_two_pass([0.05, -0.05, 0.1])
        df.loc[df.cell.isin(["10", "11"]), "score"] += 0.2
        b = decide(df)
        assert a["bestReduction"] == pytest.approx(b["bestReduction"])
        assert a["decision"] == b["decision"]
