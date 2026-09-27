import json
import random
from pathlib import Path

import pytest

from pigeon_analysis.calibration import (
    _budget_cap,
    context_peak,
    cost_rule,
    memory_cap_rule,
    review_cap_rule,
    sample_order,
    sample_tasks,
    solved_rate_rule,
    step_budget_rule,
)
from pigeon_analysis.table import make_table
from sim import rec

TASKS = list(range(101, 116))


def solved_rows(solved_pass1: int, solved_pass2: int):
    recs = []
    for r, k in ((1, solved_pass1), (2, solved_pass2)):
        for j, t in enumerate(TASKS):
            recs.append(rec("01", t, r, 0.5, solved=1.0 if j < k else 0.0))
    return make_table(recs)


class TestSolvedRate:
    @pytest.mark.parametrize(
        "p1,p2,decision",
        [(5, 4, "stay"), (4, 4, "below-threshold"), (11, 10, "stay"), (11, 11, "switch-repo"), (0, 0, "below-threshold")],
    )
    def test_threshold_endpoints_inclusive(self, p1, p2, decision):
        # 9/30 = 30%、21/30 = 70% 都留下；8/30 与 22/30 越界
        assert solved_rate_rule(solved_rows(p1, p2))["decision"] == decision

    def test_rate_pools_both_passes(self):
        r = solved_rate_rule(solved_rows(6, 3))
        assert r["rate"] == pytest.approx(9 / 30)
        assert r["steps"] == 30
        assert r["byPass"] == {"1": pytest.approx(0.4), "2": pytest.approx(0.2)}

    def test_large_rerun_gap(self):
        # 相差正好 20 个点不算大；超过才注明
        assert solved_rate_rule(solved_rows(6, 3))["largeRerunGap"] is False
        assert solved_rate_rule(solved_rows(7, 3))["largeRerunGap"] is True

    def test_only_01_cell_counts(self):
        df = make_table(
            [rec("01", t, 1, 0.5, solved=1.0) for t in TASKS[:10]]
            + [rec("11", t, 1, 0.5, solved=0.0) for t in TASKS]
        )
        assert solved_rate_rule(df)["rate"] == 1.0


def cost_rows(c01, c11, cm, review=0.0):
    recs = []
    for t in TASKS:
        for r in (1, 2):
            recs.append(rec("01", t, r, 0.5, cost=c01))
            recs.append(rec("11", t, r, 0.5, cost=c11 - review, review_cost=review))
        recs.append(rec("M", t, 1, 0.5, cost=cm))
    return make_table(recs)


class TestCost:
    def test_formula(self):
        r = cost_rule(cost_rows(0.5, 0.7, 0.2, review=0.1))
        assert r["c11"] == pytest.approx(0.7)
        assert r["cPass"] == pytest.approx(89 * (2 * 0.5 + 2 * 0.7) * 1.1)
        assert r["cM_total"] == pytest.approx(89 * 0.2 * 1.1)
        assert r["cBase"] == pytest.approx(2 * r["cPass"] + r["cM_total"])

    @pytest.mark.parametrize(
        "base,decision",
        [(519.9, "go"), (520.0, "go"), (520.1, "go-third-pass-unlikely"), (650.0, "go-third-pass-unlikely"), (650.1, "owner-decides")],
    )
    def test_decision_boundaries(self, base, decision):
        # 只让最简 agent 有花费，C_base = 89 × cM × 1.1
        cm = base / (89 * 1.1)
        assert cost_rule(cost_rows(0.0, 0.0, cm))["decision"] == decision

    def test_offpeak_column_preferred(self):
        df = cost_rows(1.0, 1.0, 1.0)
        df["cost_offpeak"] = 0.5
        r = cost_rule(df)
        assert r["offpeakAdjusted"] is True
        assert r["c01"] == pytest.approx(0.5)


def test_context_peak():
    df = make_table([rec("01", t, 1, 0.5, peak_input=1000 * k) for k, t in enumerate(TASKS, start=1)]
                    + [rec("M", 1, 1, 0.5, peak_input=10**9)])
    r = context_peak(df, compaction_trigger=15000)
    assert r["max"] == 15000  # 最简 agent 不计入
    assert r["stepsOverWarn"] == 3  # 超过 12,000 的：13k、14k、15k
    assert context_peak(df, None).get("warn") is None


def budget_rows(turns, wall_min, cell="01", **kw):
    return make_table([rec(cell, 1 + k, 1, 0.5, turns=t, wall_ms=w * 60_000, **kw) for k, (t, w) in enumerate(zip(turns, wall_min))])


class TestStepBudget:
    @pytest.mark.parametrize(
        "max_turns,want",
        [(90, 150), (100, 150), (101, 160), (120, 180), (299, 450)],
    )
    def test_turns(self, max_turns, want):
        assert step_budget_rule(budget_rows([10, max_turns], [5, 5]))["turns"] == want

    @pytest.mark.parametrize("max_wall,want", [(15, 30), (20, 30), (20.5, 35), (25, 40), (59, 90)])
    def test_wall(self, max_wall, want):
        assert step_budget_rule(budget_rows([10, 10], [1, max_wall]))["wallMinutes"] == want

    def test_hit_temporary_cap_doubles(self):
        r = step_budget_rule(budget_rows([300, 10], [5, 5]))
        assert (r["turns"], r["wallMinutes"], r["hitTemporaryCap"]) == (600, 120, True)
        r = step_budget_rule(budget_rows([10, 10], [60, 5]))
        assert (r["turns"], r["wallMinutes"]) == (600, 120)
        r = step_budget_rule(budget_rows([10, 10], [5, 5], hit_step_budget=1.0))
        assert r["hitTemporaryCap"] is True

    def test_minimal_ignored(self):
        df = make_table([rec("01", 1, 1, 0.5, turns=50, wall_ms=60_000), rec("M", 1, 1, 0.5, turns=999, wall_ms=10**9)])
        assert step_budget_rule(df)["turns"] == 150

    def test_upper_cap(self):
        assert _budget_cap(500, 1.5, 10, 150, 600) == (600, True)
        assert _budget_cap(400, 1.5, 10, 150, 600) == (600, False)


def memory_rows(pass_sizes: dict[int, list[float]], column="memory_chars"):
    recs = []
    for r, sizes in pass_sizes.items():
        for t, s in zip(TASKS, sizes):
            recs.append(rec("11", t, r, 0.5, **{column: s}))
            recs.append(rec("01", t, r, 0.5))
    return make_table(recs)


def linear(step, n=15):
    return [step * k for k in range(n)]


class TestMemoryCap:
    @pytest.mark.parametrize(
        "g1,g2,want",
        [
            (300, 300, 9000),
            (300, 200, 8000),  # 平均 250 × 30 = 7,500 → 8,000
            (300, 100, 9000),  # 相差超过一倍取较快的一遍
            (200, 100, 5000),  # 正好一倍不算超过：平均 150 × 30 = 4,500 → 5,000
            (101, 101, 4000),  # 3,030 → 4,000
            (50, 50, 2200),  # 1,500 → 2,000，夹到 2,200
            (500, 500, 12000),  # 15,000，夹到 12,000
            (0, 0, 2200),
        ],
    )
    def test_rule(self, g1, g2, want):
        assert memory_cap_rule(memory_rows({1: linear(g1), 2: linear(g2)}))["capChars"] == want

    def test_exact_thousand_not_bumped(self):
        # 100 × 30 = 3,000 正好整千，不再上抬
        assert memory_cap_rule(memory_rows({1: linear(100), 2: linear(100)}))["rounded"] == 3000

    def test_growth_uses_start_sizes_and_gaps(self):
        sizes = linear(300)
        rows = memory_rows({1: sizes})
        # 中间缺一步：增长仍按首尾相隔的步数算
        rows = rows[~((rows.cell == "11") & (rows.task == TASKS[7]))]
        assert memory_cap_rule(rows)["growthByPass"]["1"] == pytest.approx(300)

    def test_bytes_only_gives_no_cap(self):
        # 只按字符算：结果行只有字节数时不给上限，不拿字节近似
        r = memory_cap_rule(memory_rows({1: linear(300)}, column="memory_bytes"))
        assert r["capChars"] is None
        assert r["reason"] == "memory-chars-missing"

    def test_end_of_step_sizes_include_last_step(self):
        # 开工时 0、300、…、4,200；最后一步复盘后涨到 6,000：增长 = (6,000 − 0) / 15 = 400 → 12,000
        rows = memory_rows({1: linear(300)})
        last = (rows.cell == "11") & (rows.task == TASKS[-1])
        rows.loc[last, "memory_chars_after"] = 6000.0
        r = memory_cap_rule(rows)
        assert r["usedEndOfStepSizes"] == {"1": True}
        assert r["growthByPass"]["1"] == pytest.approx(400)
        # 没有复盘后的大小时退回开工时首尾差：4,200 / 14 = 300
        assert memory_cap_rule(memory_rows({1: linear(300)}))["growthByPass"]["1"] == pytest.approx(300)


class TestReviewCap:
    def rows(self, turns, wall_min, **kw):
        return make_table([rec("11", 1 + k, 1, 0.5, review_turns=t, review_wall_ms=w * 60_000, **kw)
                           for k, (t, w) in enumerate(zip(turns, wall_min))])

    @pytest.mark.parametrize("max_turns,want", [(10, 20), (13, 20), (14, 25), (18, 30)])
    def test_turns(self, max_turns, want):
        assert review_cap_rule(self.rows([1, max_turns], [1, 1]))["turns"] == want

    @pytest.mark.parametrize("max_wall,want", [(2, 5), (3.3, 5), (3.4, 6), (4, 6), (6, 9)])
    def test_wall(self, max_wall, want):
        assert review_cap_rule(self.rows([1, 1], [1, max_wall]))["wallMinutes"] == want

    def test_hit_doubles(self):
        assert review_cap_rule(self.rows([40, 1], [1, 1]))["turns"] == 80
        assert review_cap_rule(self.rows([1, 1], [10, 1]))["wallMinutes"] == 20

    def test_no_reviews(self):
        assert review_cap_rule(make_table([rec("01", 1, 1, 0.5)]))["turns"] is None


class TestSample:
    def test_golden(self):
        assert sample_tasks(range(1, 90)) == [10, 14, 16, 24, 31, 38, 40, 41, 47, 52, 60, 63, 64, 86, 88]

    def test_same_as_python_random_on_time_ordered_population(self):
        eligible = [199, 3, 57, 12, 88, 140, 21, 33, 64, 71, 95, 102, 111, 120, 130, 150, 160, 170]
        want = sorted(random.Random(20260927).sample(sorted(eligible), 15))
        assert sample_tasks(eligible) == want

    def test_input_order_irrelevant(self):
        assert sample_tasks(range(1, 90)) == sample_tasks(reversed(range(1, 90)))

    def test_too_few(self):
        with pytest.raises(ValueError):
            sample_tasks(range(10))

    def test_cross_check_with_runner(self):
        """与跑批器二的抽题逐位一致。fixtures/runner-sample.json 由跑批器二（runner-r3 0f463bb）的
        src/eval/stream-sample.ts 原文件生成：经 sampleTasks（按要做到的条数筛总体）与直接调 PythonRandom.sample，
        覆盖 CPython 的池子与已选集合两种分支、不同种子与样本数；每组比对抽取次序与按时间排序后的题单。"""
        fixture = Path(__file__).parent / "fixtures" / "runner-sample.json"
        data = json.loads(fixture.read_text(encoding="utf-8"))
        assert len(data["cases"]) >= 6
        for case in data["cases"]:
            order = sample_order(case["eligible"], seed=case["seed"], k=case["k"])
            assert order == case["sampleOrder"], case["source"]
            assert sample_tasks(case["eligible"], seed=case["seed"], k=case["k"]) == case["selected"], case["source"]

    def test_runner_reference_list(self):
        # 跑批器二审计里由 CPython 3.13 算出的对照值：89 道里抽 15 道的抽取次序
        assert sample_order(range(1, 90)) == [31, 63, 41, 16, 10, 64, 52, 47, 88, 14, 40, 24, 86, 60, 38]
