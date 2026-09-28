import itertools

import numpy as np
import pytest

from pigeon_analysis.stats import (
    bootstrap_ci,
    ceil_to,
    holm_two_step,
    paired_dz,
    sign_flip_pvalue,
)


def exact_two_sided(d):
    """穷举全部 2^n 种符号，作为随机翻转的对照。"""
    d = np.asarray(d, dtype=float)
    obs = abs(d.mean())
    hits = 0
    total = 0
    for signs in itertools.product((-1, 1), repeat=d.size):
        hits += abs((np.array(signs) * d).mean()) >= obs - 1e-12
        total += 1
    return hits / total


class TestSignFlip:
    def test_matches_exact_enumeration(self):
        # 各题差全为正、幅度不同：精确双侧 p 值可穷举
        d = [0.3, 0.1, 0.2, 0.05, 0.4, 0.15]
        p = sign_flip_pvalue(d)
        assert p == pytest.approx(exact_two_sided(d), abs=0.003)

    def test_two_sided_is_symmetric_in_sign(self):
        d = np.array([0.3, 0.1, 0.2, -0.05, 0.4, 0.15, 0.02])
        assert sign_flip_pvalue(d) == sign_flip_pvalue(-d)

    def test_all_positive_three_tasks(self):
        # 3 道题全为 +1：只有全正与全负两种翻转的 |平均| 不小于实测，精确 p = 2/8
        assert sign_flip_pvalue([1.0, 1.0, 1.0]) == pytest.approx(0.25, abs=0.005)

    def test_plus_one_correction(self):
        # 30 道题全为正且幅度相同：十万次翻转里几乎不可能出现全同号，超过次数为 0，p = 1 / (100000 + 1)
        assert sign_flip_pvalue(np.full(30, 0.1)) == pytest.approx(1 / 100_001)
        # 小翻转数时同样按 (次数 + 1) / (翻转数 + 1)
        assert sign_flip_pvalue(np.full(30, 0.1), flips=99) == pytest.approx(1 / 100)

    def test_zero_differences_give_one(self):
        assert sign_flip_pvalue([0.0, 0.0, 0.0]) == 1.0

    def test_empty_is_none(self):
        assert sign_flip_pvalue([]) is None

    def test_deterministic(self):
        d = np.random.default_rng(3).normal(0.02, 0.1, 40)
        assert sign_flip_pvalue(d) == sign_flip_pvalue(d)

    def test_uses_mean_not_sum_denominator_invariant(self):
        # 同一组差整体放大，p 值不变（检验只依赖相对大小）
        d = np.random.default_rng(5).normal(0.03, 0.1, 25)
        assert sign_flip_pvalue(d) == sign_flip_pvalue(d * 7)


class TestHolm:
    def test_both_at_boundaries_significant(self):
        r = holm_two_step((0.025, 0.05))
        assert r.significant == (True, True)
        assert r.thresholds == (0.025, 0.05)

    def test_order_does_not_matter(self):
        r = holm_two_step((0.05, 0.025))
        assert r.significant == (True, True)
        assert r.thresholds == (0.05, 0.025)

    def test_first_step_fails_stops(self):
        # p(1) 刚过 0.025：两个都不显著，即使 p(2) 本身 < 0.05
        r = holm_two_step((0.0251, 0.03))
        assert r.significant == (False, False)
        assert r.thresholds == (0.025, None)

    def test_second_step_just_over(self):
        r = holm_two_step((0.01, 0.0501))
        assert r.significant == (True, False)

    def test_example_from_plan(self):
        # 199 的例子：推 0.02、拉 0.04，Holm 两个都显著（Bonferroni 只推显著）
        assert holm_two_step((0.02, 0.04)).significant == (True, True)

    def test_ties_take_first_as_p1(self):
        r = holm_two_step((0.03, 0.03))
        assert r.significant == (False, False)
        assert r.thresholds == (0.025, None)

    def test_missing_p_counts_as_not_significant(self):
        r = holm_two_step((None, 0.02))
        assert r.significant == (False, True)
        r = holm_two_step((None, 0.03))
        assert r.significant == (False, False)


class TestBootstrap:
    def test_constant_differences_degenerate_interval(self):
        assert bootstrap_ci(np.full(20, 0.05)) == pytest.approx((0.05, 0.05))

    def test_single_task(self):
        assert bootstrap_ci(np.array([0.2])) == pytest.approx((0.2, 0.2))

    def test_two_values_extreme_resamples(self):
        # 2 道题 {0, 1}：重抽平均只能是 0、0.5、1（概率 1/4、1/2、1/4），2.5% 分位为 0、97.5% 分位为 1
        assert bootstrap_ci(np.array([0.0, 1.0])) == (0.0, 1.0)

    def test_interval_contains_mean_and_is_ordered(self):
        d = np.random.default_rng(1).normal(0.05, 0.1, 60)
        lo, hi = bootstrap_ci(d)
        assert lo < d.mean() < hi

    def test_width_close_to_normal_theory(self):
        d = np.random.default_rng(2).normal(0.0, 0.1, 400)
        lo, hi = bootstrap_ci(d)
        se = d.std(ddof=1) / np.sqrt(d.size)
        assert (hi - lo) == pytest.approx(2 * 1.96 * se, rel=0.08)

    def test_deterministic(self):
        d = np.random.default_rng(4).normal(0.0, 0.1, 30)
        assert bootstrap_ci(d) == bootstrap_ci(d)

    def test_empty(self):
        assert bootstrap_ci(np.array([])) is None


def test_paired_dz():
    assert paired_dz(np.array([1.0, 2.0, 3.0])) == pytest.approx(2.0)
    assert paired_dz(np.array([1.0])) is None
    assert paired_dz(np.array([1.0, 1.0])) is None


@pytest.mark.parametrize(
    "x,step,want",
    [(0.0, 10, 0), (1, 10, 10), (10, 10, 10), (10.0000000001, 10, 10), (10.01, 10, 20), (4.5 * 1.5, 5, 10), (-3, 1000, 0)],
)
def test_ceil_to(x, step, want):
    assert ceil_to(x, step) == want
