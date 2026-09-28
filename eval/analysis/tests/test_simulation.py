"""模拟检验：零效果时的误报率、给定效果时的检出率与 3.7 公式的对照、置信区间覆盖率。

为控制耗时，每次模拟的翻转与重抽次数取小于正式值（2,000 次翻转、500 次重抽）；
正式值只影响 p 值与区间的蒙特卡洛精度，不影响检验的误报率与检出率。
结果（实际比例）打印在测试输出里，审计照抄。
"""

import math

import numpy as np
import pytest
from scipy.stats import norm

from pigeon_analysis.primary import analyze_primary
from sim import simulate

FAST = dict(flips=2000, boots=500, with_mixed=False)


def run(sims, **kw):
    out = []
    for s in range(sims):
        res = analyze_primary(simulate(seed=10_000 + s, **kw), **FAST)
        out.append(res)
    return out


def predicted_power(effect, v, tau2, passes, n, z=2.24):
    """3.7 的模型：SE = √((τ² + v/R)/n)，第一步门槛为双侧 2.5%（z = 2.24）；不乘余量 k（模拟里没有流内连带）。"""
    se = math.sqrt((tau2 + v / passes) / n)
    return float(norm.cdf(effect / se - z))


@pytest.mark.slow
def test_null_false_positive_rate(capsys):
    # 零效果、89 道题、2 遍：p ≤ 0.05 的比例应接近 5%；Holm 下两个效应任一显著的比例不超过约 5%
    res = run(1000, n_tasks=89, passes=2, v=0.02, tau2=0.005)
    p_push = np.array([r["effects"]["push"]["p"] for r in res])
    any_sig = np.mean([r["effects"]["push"]["holmSignificant"] or r["effects"]["search"]["holmSignificant"] for r in res])
    rate = float(np.mean(p_push <= 0.05))
    with capsys.disabled():
        print(f"\n[零效果] 推送 p≤0.05 比例 {rate:.3f}；Holm 任一显著比例 {any_sig:.3f}（1000 次模拟）")
    # 1000 次模拟的标准误约 0.7 个百分点，容许 ±2.1
    assert abs(rate - 0.05) <= 0.021
    assert any_sig <= 0.05 + 0.021


@pytest.mark.slow
def test_null_false_positive_rate_bounded_discrete(capsys):
    # 得分有界且离散（每步 5 条用例）：检验仍应守住 5%
    res = run(600, n_tasks=60, passes=2, v=0.03, base=0.4, discrete=5)
    rate = float(np.mean([r["effects"]["push"]["p"] <= 0.05 for r in res]))
    with capsys.disabled():
        print(f"\n[零效果，有界离散得分] 推送 p≤0.05 比例 {rate:.3f}（600 次模拟）")
    assert abs(rate - 0.05) <= 0.027


@pytest.mark.slow
@pytest.mark.parametrize("effect", [0.05, 0.03])
def test_power_matches_formula(effect, capsys):
    # 选 v 与 τ² 使 5 个点正好是 3.7 公式（不乘 k）下的最小可分辨效果：预测检出率约 80%
    n, passes, tau2 = 89, 2, 0.01
    se = 0.05 / 3.08
    v = (se * se * n - tau2) * passes
    predicted = predicted_power(effect, v, tau2, passes, n)
    res = run(400, n_tasks=n, passes=passes, push=effect, v=v, tau2=tau2)
    detected = float(np.mean([r["effects"]["push"]["holmSignificant"] and r["effects"]["push"]["estimate"] > 0 for r in res]))
    with capsys.disabled():
        print(f"\n[真实效果 {effect * 100:.0f} 个点，v={v:.4f}，τ²={tau2}] 检出率 {detected:.3f}，公式预测 {predicted:.3f}（400 次模拟）")
    # 400 次模拟的标准误约 2 个百分点；公式是正态近似，容许 ±8 个百分点
    assert abs(detected - predicted) <= 0.08


@pytest.mark.slow
def test_bootstrap_coverage(capsys):
    effect = 0.04
    res = run(400, n_tasks=89, passes=2, push=effect, v=0.02, tau2=0.005)
    cover = float(np.mean([r["effects"]["push"]["ci"][0] <= effect <= r["effects"]["push"]["ci"][1] for r in res]))
    with capsys.disabled():
        print(f"\n[置信区间] 95% 区间覆盖真实效果的比例 {cover:.3f}（400 次模拟）")
    assert 0.91 <= cover <= 0.985
