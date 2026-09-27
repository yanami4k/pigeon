"""统计原语：按题配对的符号翻转置换检验、Holm 两步、按题自助法置信区间、配对标准化效应（分析计划 1.5、1.6）。

所有随机过程都由调用方给定的种子新建生成器，调用顺序不影响结果。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from . import constants as K

# 分块生成随机符号，控制内存
_CHUNK = 10_000


def sign_flip_pvalue(
    d: np.ndarray,
    flips: int = K.PERMUTATIONS,
    seed: int = K.PERMUTATION_SEED,
) -> float | None:
    """双侧 p 值：零假设下每个 d(i) 的正负号可以互换，随机翻转 flips 次，
    翻转后平均差的绝对值不小于实测平均差绝对值的比例（1.5 甲）。没有有效题时为 None。"""
    d = np.asarray(d, dtype=float)
    n = d.size
    if n == 0:
        return None
    observed = abs(d.mean())
    # 浮点比较留一点容差，避免与实测完全相同的翻转因舍入被漏计
    tol = 1e-12 * max(1.0, observed)
    rng = np.random.default_rng(seed)
    hits = 0
    done = 0
    while done < flips:
        m = min(_CHUNK, flips - done)
        signs = rng.integers(0, 2, size=(m, n), dtype=np.int8) * 2 - 1
        means = np.abs(signs @ d) / n
        hits += int(np.count_nonzero(means >= observed - tol))
        done += m
    return hits / flips


@dataclass(frozen=True)
class HolmResult:
    significant: tuple[bool, ...]
    # 各自比较时用的门槛；第 2 步没走到时为 None
    thresholds: tuple[float | None, ...]


def holm_two_step(p: tuple[float | None, float | None], alpha: float = K.ALPHA) -> HolmResult:
    """Holm 两步（1.6、199）：较小的 p(1) ≤ alpha/2 才判显著并进入第 2 步；第 2 步 p(2) ≤ alpha。
    p 值为 None（没有有效题）按不显著处理，且不占用第 1 步。"""
    idx = [i for i in range(2) if p[i] is not None]
    sig = [False, False]
    thr: list[float | None] = [None, None]
    if not idx:
        return HolmResult(tuple(sig), tuple(thr))
    # 相等时按给定顺序取前者为 p(1)
    order = sorted(idx, key=lambda i: (p[i], i))
    first = order[0]
    # 只有一个可检验时仍按两个假设的 Holm 第一步门槛判，保持总误报率口径不变
    thr[first] = alpha / 2
    if p[first] <= alpha / 2:
        sig[first] = True
        if len(order) == 2:
            second = order[1]
            thr[second] = alpha
            sig[second] = p[second] <= alpha
    return HolmResult(tuple(sig), tuple(thr))


def bootstrap_ci(
    d: np.ndarray,
    resamples: int = K.BOOTSTRAPS,
    seed: int = K.BOOTSTRAP_SEED,
    level: float = K.CI_LEVEL,
) -> tuple[float, float] | None:
    """按题自助法：把题目有放回地重抽 resamples 次，每次重算平均，取两端分位数（1.6）。"""
    d = np.asarray(d, dtype=float)
    n = d.size
    if n == 0:
        return None
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, n, size=(resamples, n))
    means = d[idx].mean(axis=1)
    lo, hi = np.quantile(means, [(1 - level) / 2, 1 - (1 - level) / 2])
    return float(lo), float(hi)


def bootstrap_stat_ci(
    columns: list[np.ndarray],
    stat,
    resamples: int = K.BOOTSTRAPS,
    seed: int = K.BOOTSTRAP_SEED,
    level: float = K.CI_LEVEL,
) -> tuple[float, float] | None:
    """按题自助法的通用版：columns 为按题对齐的若干列，stat 接收重抽后的各列（形状 resamples × n）
    返回长度 resamples 的统计量；不可算的重抽（NaN）不计入分位数。"""
    n = columns[0].size
    if n == 0:
        return None
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, n, size=(resamples, n))
    values = np.asarray(stat(*[np.asarray(c, dtype=float)[idx] for c in columns]), dtype=float)
    values = values[~np.isnan(values)]
    if values.size == 0:
        return None
    lo, hi = np.quantile(values, [(1 - level) / 2, 1 - (1 - level) / 2])
    return float(lo), float(hi)


def paired_dz(d: np.ndarray) -> float | None:
    """配对标准化效应 dz = mean(d) / sd(d)，sd 取样本标准差；不足两题或 sd 为零时为 None。"""
    d = np.asarray(d, dtype=float)
    if d.size < 2:
        return None
    sd = float(d.std(ddof=1))
    if sd == 0:
        return None
    return float(d.mean()) / sd


def sample_var(x: np.ndarray) -> float | None:
    x = np.asarray(x, dtype=float)
    if x.size < 2:
        return None
    return float(x.var(ddof=1))


# 门槛比较的容差：得分是有理数的平均，0.9 这类端点常被浮点误差挤到 0.8999999…；端点按规则算在哪边就在哪边
EPS = 1e-9


def at_least(x: float, threshold: float) -> bool:
    return x >= threshold - EPS


def above(x: float, threshold: float) -> bool:
    return x > threshold + EPS


def ceil_to(x: float, step: float) -> float:
    """向上取整到 step 的整数倍；先按 1e-9 相对容差吸收浮点误差，避免 3.0000000001 被抬一档。"""
    q = x / step
    r = round(q)
    if abs(q - r) <= 1e-9 * max(1.0, abs(q)):
        return r * step
    return math.ceil(q) * step
