import numpy as np
import pytest

from pigeon_analysis.primary import analyze_primary
from pigeon_analysis.secondary import (
    analyze_secondary,
    half_difference,
    keep_failures,
    time_positions,
    versus_minimal,
)
from pigeon_analysis.table import make_table
from sim import grid, rec, simulate

FAST = dict(flips=2000, boots=500)


def both(df):
    p = analyze_primary(df, with_mixed=False, **FAST)
    return p, analyze_secondary(df, p, **FAST)


def test_all_secondary_marked_exploratory():
    p, s = both(simulate(n_tasks=12, passes=2, seed=1, minimal=True))
    for key in ("solved", "keepFailures", "interaction", "learningCurve", "efficiency", "versusMinimal", "memoryUsage"):
        assert s[key]["exploratory"] is True


def test_solved_effects_use_solved_not_score():
    recs = grid({"00": 0.5, "01": 0.5, "10": 0.5, "11": 0.5}, tasks=(1, 2, 3, 4))
    for r in recs:
        r["solved"] = 1.0 if r["cell"][0] == "1" else 0.0
    p, s = both(make_table(recs))
    assert p["effects"]["push"]["estimate"] == pytest.approx(0.0)
    assert s["solved"]["push"]["estimate"] == pytest.approx(1.0)
    assert s["solved"]["search"]["estimate"] == pytest.approx(0.0)
    assert s["solved"]["rateByCell"] == {"00": 0.0, "01": 0.0, "10": 1.0, "11": 1.0}


def test_keep_failures_counts():
    recs = grid({"00": 0.5, "01": 0.5, "10": 0.5, "11": 0.5}, tasks=(1, 2))
    for r in recs:
        r["p_failed"] = 3.0 if (r["cell"] == "10" and r["task"] == 1) else 0.0
    df = make_table(recs)
    k = keep_failures(df, [1, 2], **FAST)
    assert k["byCell"]["10"] == {"steps": 2, "total": 3.0, "meanPerStep": 1.5, "stepsWithFailures": 1}
    # 推送差：第 1 题 (3+0)/2 − 0 = 1.5，第 2 题 0 → 平均 0.75
    assert k["push"]["estimate"] == pytest.approx(0.75)


class TestLearningCurve:
    def test_time_positions(self):
        assert time_positions([30, 10, 20]) == {10: 0.0, 20: 0.5, 30: 1.0}
        assert time_positions([5]) == {5: 0.0}

    def test_slope_recovers_linear_trend(self):
        # dP(i) = 0.1·t(i)：斜率 0.1，后半段差为正
        tasks = list(range(1, 12))
        recs = grid({"00": 0.3, "01": 0.3, "10": lambda t, r: 0.3 + 0.1 * (t - 1) / 10, "11": lambda t, r: 0.3 + 0.1 * (t - 1) / 10}, tasks=tasks)
        p, s = both(make_table(recs))
        lc = s["learningCurve"]["push"]
        assert lc["slope"] == pytest.approx(0.1)
        assert lc["halfDifference"] > 0
        assert lc["slopeCi"][0] <= 0.1 + 1e-9 and lc["slopeCi"][1] >= 0.1 - 1e-9
        assert s["learningCurve"]["search"]["slope"] == pytest.approx(0.0)

    def test_positions_over_all_tasks_including_f_empty(self):
        # F 为空的第 2 题不进回归，但时间位置仍按全部题排：第 3 题的 t 为 1
        recs = grid({"00": 0.3, "01": 0.3, "10": lambda t, r: 0.3 + 0.1 * (t - 1) / 2, "11": lambda t, r: 0.3 + 0.1 * (t - 1) / 2}, tasks=(1, 3))
        recs += [rec(c, 2, 1, None, f_total=0) for c in ("00", "01", "10", "11")]
        p, s = both(make_table(recs))
        assert p["validTasks"] == [1, 3]
        assert s["learningCurve"]["push"]["slope"] == pytest.approx(0.1)

    def test_positions_include_tasks_without_rows(self):
        # 全部题为 1–5，第 5 题没有任何结果行：它仍占时间位置，第 3 题的 t 为 0.5 而不是 1
        recs = grid({"00": 0.3, "01": 0.3, "10": lambda t, r: 0.3 + 0.1 * (t - 1) / 4, "11": lambda t, r: 0.3 + 0.1 * (t - 1) / 4},
                    tasks=(1, 2, 3))
        df = make_table(recs)
        p = analyze_primary(df, expected_tasks=[1, 2, 3, 4, 5], with_mixed=False, **FAST)
        s = analyze_secondary(df, p, **FAST)
        assert s["learningCurve"]["push"]["slope"] == pytest.approx(0.1)

    @pytest.mark.parametrize(
        "d,want",
        [([1, 2, 3, 4], 2.0), ([1, 2, 100, 3, 4], 2.0), ([5], None), ([], None)],
    )
    def test_half_difference(self, d, want):
        assert half_difference(np.array(d, dtype=float)) == (pytest.approx(want) if want is not None else None)


class TestVersusMinimal:
    def test_single_pass_minimal(self):
        recs = grid({"00": 0.4, "01": 0.5, "10": 0.6, "11": 0.7}, tasks=(1, 2, 3), passes=(1, 2))
        recs += [rec("M", t, 1, 0.3) for t in (1, 2, 3)]
        p, s = both(make_table(recs))
        vm = s["versusMinimal"]
        assert vm["n"] == 3
        assert vm["00"]["estimate"] == pytest.approx(0.1)
        assert vm["11"]["estimate"] == pytest.approx(0.4)

    def test_minimal_missing_tasks_excluded(self):
        recs = grid({"00": 0.4, "01": 0.5, "10": 0.6, "11": 0.7}, tasks=(1, 2, 3))
        recs += [rec("M", 1, 1, 0.3), rec("M", 3, 1, 0.1)]
        df = make_table(recs)
        vm = versus_minimal(df, [1, 2, 3], boots=500)
        assert vm["n"] == 2
        assert vm["00"]["estimate"] == pytest.approx(0.4 - 0.2)

    def test_minimal_absent(self):
        p, s = both(make_table(grid({"00": 0.4, "01": 0.5, "10": 0.6, "11": 0.7})))
        assert s["versusMinimal"]["n"] == 0
        assert s["versusMinimal"]["00"]["estimate"] is None


def test_efficiency_median_and_paired():
    recs = grid({"00": 0.5, "01": 0.5, "10": 0.5, "11": 0.5}, tasks=(1, 2, 3))
    for r in recs:
        r["turns"] = {"00": 10, "01": 20, "10": 30, "11": 40}[r["cell"]] + r["task"]
    p, s = both(make_table(recs))
    w = s["efficiency"]["worker"]
    assert w["byCell"]["turns"]["00"]["median"] == 12
    assert w["pairedMedian"]["turns"]["push"] == pytest.approx(20)
    assert w["pairedMedian"]["turns"]["search"] == pytest.approx(10)


def test_efficiency_worker_and_review_separate():
    # 干活与复盘分开报：干活的花费取 cost（已减去复盘），复盘取 review_cost；复盘的轮数、token、墙钟单列
    recs = grid({"00": 0.5, "01": 0.5, "10": 0.5, "11": 0.5}, tasks=(1, 2, 3))
    for r in recs:
        r["cost"] = 1.0
        r["turns"] = 30
        if r["cell"][0] == "1":
            r.update(review_cost=0.25 if r["cell"] == "11" else 0.1, review_turns=8, review_input_miss=100,
                     review_input_hit=900, review_output=50, review_tokens=1050, review_wall_ms=60_000)
    p, s = both(make_table(recs))
    eff = s["efficiency"]
    assert set(eff["worker"]["byCell"]) == {"turns", "input_miss", "input_hit", "output_tokens", "wall_ms", "cost"}
    assert set(eff["review"]["byCell"]) == {"review_turns", "review_input_miss", "review_input_hit", "review_output",
                                            "review_tokens", "review_wall_ms", "review_cost"}
    assert eff["worker"]["byCell"]["cost"]["11"]["median"] == 1.0
    assert eff["review"]["byCell"]["review_cost"]["11"]["median"] == 0.25
    assert set(eff["review"]["byCell"]["review_cost"]) == {"10", "11"}
    # 复盘只在推送两格：推送差无从配对，检索差为 11 − 10
    assert eff["review"]["pairedMedian"]["review_cost"] == {"push": None, "search": pytest.approx(0.15)}


PUSH_ITEMS = [
    "memory_entries_after", "memory_chars_after",
    "mem_worker_add", "mem_worker_replace", "mem_worker_remove",
    "mem_review_add", "mem_review_replace", "mem_review_remove",
    "mem_worker_rejected_full", "mem_review_rejected_full",
    "mem_citations", "mem_cited_entries", "mem_basis_citations", "mem_basis_cited_entries", "mem_ref_reads",
    "review_closing", "review_pre_compaction", "review_cost",
]


def test_memory_usage_items_follow_plan():
    # 计划第 3 节的各项（261 去掉了"复盘记为反面教训的条数"）：逐项列出，不多不少
    p, s = both(simulate(n_tasks=6, passes=1, seed=2))
    mu = s["memoryUsage"]
    assert mu["items"]["push"] == PUSH_ITEMS
    assert mu["items"]["search"] == ["search_calls_search_sessions", "search_calls_read_session_entry", "search_sessions_hit"]
    assert set(mu["push"]["11"]) == set(PUSH_ITEMS) | {"endOfPass"}
    assert not any("lesson" in k or "negative" in k for k in mu["push"]["11"])


def test_memory_usage_only_push_and_search_cells():
    recs = grid({"00": 0.5, "01": 0.5, "10": 0.5, "11": 0.5}, tasks=(1, 2), passes=(1, 2))
    for r in recs:
        if r["cell"][0] == "1":
            r["memory_chars_after"] = 100.0 * r["task"] + 10 * r["pass_no"]
            r["memory_entries_after"] = 1.0 * r["task"]
            r["mem_citations"] = 2.0
            r["mem_worker_add"] = 1.0
            r["review_closing"] = 1.0
        if r["cell"][1] == "1":
            r["search_calls_search_sessions"] = 1.0
            r["search_sessions_hit"] = 3.0
    p, s = both(make_table(recs))
    mu = s["memoryUsage"]
    assert set(mu["push"]) == {"10", "11"}
    assert set(mu["search"]) == {"01", "11"}
    assert mu["push"]["11"]["memory_chars_after"]["max"] == 220.0
    # 一遍结束值：每遍最后一步复盘后的大小
    assert mu["push"]["11"]["endOfPass"] == {"1": {"task": 2, "entries": 2.0, "chars": 210.0},
                                             "2": {"task": 2, "entries": 2.0, "chars": 220.0}}
    assert mu["push"]["10"]["mem_citations"] == {"total": 8.0, "meanPerStep": 2.0, "steps": 4}
    assert mu["push"]["10"]["mem_worker_add"]["total"] == 4.0
    # 没有来源的项记 None
    assert mu["push"]["10"]["mem_ref_reads"] is None
    assert mu["search"]["01"]["search_calls_search_sessions"]["total"] == 4.0
    assert mu["search"]["01"]["search_calls_read_session_entry"] is None
