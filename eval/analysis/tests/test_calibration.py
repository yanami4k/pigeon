import json
import random
from pathlib import Path

import pytest

from pigeon_analysis.calibration import (
    context_peak,
    cost_rule,
    difficulty_gate,
    memory_cap_rule,
    review_cap_rule,
    sample_order,
    sample_tasks,
    step_budget_rule,
)
from pigeon_analysis.table import make_table
from sim import rec

TASKS = list(range(101, 116))


def gate_rows(pass1: list[float], pass2: list[float], solved=0.0, cell="01"):
    """01 格两遍、15 道题的部分得分；f_total = 20，得分为 1/20 的整数倍。"""
    recs = []
    for r, scores in ((1, pass1), (2, pass2)):
        for t, y in zip(TASKS, scores):
            recs.append(rec(cell, t, r, y, f_total=20, solved=solved))
    return make_table(recs)


def flat(y, n=15):
    return [y] * n


class TestDifficultyGate:
    @pytest.mark.parametrize(
        "y,decision",
        [
            (0.30, "stay"),  # 端点算在区间内
            (0.80, "stay"),
            (0.55, "stay"),
            (0.25, "retest-with-test-cases"),
            (0.85, "switch-repo"),
        ],
    )
    def test_three_exits_and_endpoints(self, y, decision):
        assert difficulty_gate(gate_rows(flat(y), flat(y)))["decision"] == decision

    def test_endpoints_by_pooled_mean(self):
        # 两遍 0.25 与 0.35：合计平均正好 0.30，留下；0.20 与 0.35 合计 0.275 低于 30%
        assert difficulty_gate(gate_rows(flat(0.25), flat(0.35)))["decision"] == "stay"
        assert difficulty_gate(gate_rows(flat(0.20), flat(0.35)))["decision"] == "retest-with-test-cases"
        # 0.75 与 0.85 合计 0.80 留下；0.75 与 0.90 合计 0.825 换仓
        assert difficulty_gate(gate_rows(flat(0.75), flat(0.85)))["decision"] == "stay"
        assert difficulty_gate(gate_rows(flat(0.75), flat(0.90)))["decision"] == "switch-repo"

    def test_mean_of_partial_scores_not_solved_rate(self):
        # 部分得分平均 0.5 留下；做成率为 0 也不影响去留，只作描述
        r = difficulty_gate(gate_rows(flat(0.5), flat(0.5), solved=0.0))
        assert r["meanScore"] == pytest.approx(0.5)
        assert r["solvedRate"] == 0.0
        assert r["decision"] == "stay"
        r = difficulty_gate(gate_rows(flat(0.1), flat(0.1), solved=1.0))
        assert r["solvedRate"] == 1.0
        assert r["decision"] == "retest-with-test-cases"

    def test_f_empty_steps_not_counted(self):
        df = gate_rows(flat(0.5), flat(0.5))
        # 再加一道要做到的为零的题：得分为空，不进平均、不计步数
        df = make_table(df.to_dict("records") + [rec("01", 999, r, None, f_total=0) for r in (1, 2)])
        r = difficulty_gate(df)
        assert r["steps"] == 30
        assert r["meanScore"] == pytest.approx(0.5)

    def test_only_01_cell_two_passes(self):
        recs = gate_rows(flat(0.5), flat(0.5)).to_dict("records")
        recs += [rec("11", t, r, 1.0, f_total=20) for t in TASKS for r in (1, 2)]
        recs += [rec("M", t, 1, 1.0, f_total=20) for t in TASKS]
        recs += [rec("01", t, 3, 1.0, f_total=20) for t in TASKS]
        assert difficulty_gate(make_table(recs))["meanScore"] == pytest.approx(0.5)

    def test_rerun_gap_noted_but_pooled(self):
        # 相差正好 20 个点不注明；超过才注明；去留照合计判
        r = difficulty_gate(gate_rows(flat(0.4), flat(0.6)))
        assert r["passGap"] == pytest.approx(0.2)
        assert r["largeRerunGap"] is False
        r = difficulty_gate(gate_rows(flat(0.35), flat(0.6)))
        assert r["largeRerunGap"] is True
        assert r["decision"] == "stay"
        assert r["byPass"] == {"1": pytest.approx(0.35), "2": pytest.approx(0.6)}

    def test_retest_with_test_cases(self):
        # 用例名题面的复测：落进区间即以用例名题面开跑，仍低于 30% 交项目负责人另定
        assert difficulty_gate(gate_rows(flat(0.5), flat(0.5)), prompt_format="test-cases")["decision"] == "start-with-test-cases"
        assert difficulty_gate(gate_rows(flat(0.2), flat(0.2)), prompt_format="test-cases")["decision"] == "owner-decides"
        assert difficulty_gate(gate_rows(flat(0.9), flat(0.9)), prompt_format="test-cases")["decision"] == "retest-above-range"
        assert difficulty_gate(gate_rows(flat(0.2), flat(0.2)), prompt_format="test-files")["decision"] == "retest-with-test-cases"

    def test_no_data(self):
        assert difficulty_gate(make_table([rec("11", 1, 1, 0.5)]))["decision"] is None


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

    def test_owner_decides_lists_candidates(self):
        # 超过 ¥650 不自动删减，列出候选交项目负责人裁决；其余两档不列
        r = cost_rule(cost_rows(0.0, 0.0, 650.1 / (89 * 1.1)))
        assert r["candidates"] == ["raise-budget", "off-peak-only", "skip-minimal"]
        assert cost_rule(cost_rows(0.0, 0.0, 600 / (89 * 1.1)))["candidates"] == []

    def test_review_cost_listed_separately(self):
        r = cost_rule(cost_rows(0.5, 0.7, 0.2, review=0.1))
        assert r["reviewPerStep"]["11"] == pytest.approx(0.1)
        assert r["reviewPerStep"]["01"] == pytest.approx(0.0)

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


def budget_rows(hits, cell="01", **kw):
    """每步是否撞了宽上限（结果行 hitStepBudget）；轮数与墙钟另给，用来验证它们不参与判定。"""
    return make_table([rec(cell, 1 + k, 1, 0.5, hit_step_budget=h, **kw) for k, h in enumerate(hits)])


class TestStepBudget:
    def test_no_hit_keeps_temporary(self):
        # 没有撞：维持临时值 300 轮、60 分钟；不按实测下调
        r = step_budget_rule(budget_rows([0.0, 0.0], turns=12, wall_ms=60_000))
        assert (r["turns"], r["wallMinutes"], r["hitTemporaryCap"]) == (300, 60, False)

    def test_hit_doubles(self):
        r = step_budget_rule(budget_rows([0.0, 1.0]))
        assert (r["turns"], r["wallMinutes"], r["hitTemporaryCap"]) == (600, 120, True)
        assert r["hitSteps"] == {"01": 1}

    def test_flag_is_the_only_criterion(self):
        # 轮数与墙钟达到临时值而标记为否：不算撞（以结果行的撞上限标记为准）
        r = step_budget_rule(budget_rows([0.0], turns=300, wall_ms=60 * 60_000))
        assert (r["turns"], r["wallMinutes"]) == (300, 60)

    def test_any_calibration_step_counts(self):
        # 最简 agent 与 Pigeon 共用同一个每步上限：它撞了也算
        df = make_table([rec("01", 1, 1, 0.5, hit_step_budget=0.0), rec("M", 1, 1, 0.5, hit_step_budget=1.0)])
        r = step_budget_rule(df)
        assert r["turns"] == 600 and r["hitSteps"] == {"M": 1}

    def test_no_flags(self):
        assert step_budget_rule(make_table([rec("01", 1, 1, 0.5)]))["turns"] is None


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
    def rows(self, hits, **kw):
        return make_table([rec("11", 1 + k, 1, 0.5, hit_review_budget=h, **kw) for k, h in enumerate(hits)])

    def test_no_hit_keeps_temporary(self):
        r = review_cap_rule(self.rows([0.0, 0.0], review_turns=5, review_wall_ms=60_000))
        assert (r["turns"], r["wallMinutes"], r["hitTemporaryCap"]) == (40, 15, False)

    def test_hit_doubles(self):
        r = review_cap_rule(self.rows([0.0, 1.0]))
        assert (r["turns"], r["wallMinutes"], r["hitTemporaryCap"]) == (80, 30, True)
        assert r["hitSteps"] == 1

    def test_flag_is_the_only_criterion(self):
        r = review_cap_rule(self.rows([0.0], review_turns=40, review_wall_ms=15 * 60_000))
        assert (r["turns"], r["wallMinutes"]) == (40, 15)

    def test_no_reviews(self):
        # 不推送的条件复盘标记为空：没有复盘可判
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
