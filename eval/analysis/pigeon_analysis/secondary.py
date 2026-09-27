"""次要判据（分析计划第 2 节；决策 199）：只作佐证，p 值不做多重校正，一律标探索性。"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from . import constants as K
from .primary import EFFECTS, cell_task_means, four_cell_rows, paired_differences
from .stats import bootstrap_ci, bootstrap_stat_ci, sign_flip_pvalue
from .table import extra_usage_columns

EFFICIENCY_METRICS = ("turns", "input_miss", "input_hit", "output_tokens", "wall_ms", "cost")
REVIEW_METRICS = ("review_turns", "review_wall_ms", "review_cost")


def _ci(c):
    return list(c) if c else None


def _paired_effects(df: pd.DataFrame, metric: str, tasks: list[int], flips: int, boots: int) -> dict[str, Any]:
    means = cell_task_means(four_cell_rows(df), metric).reindex(tasks).dropna()
    diffs = paired_differences(means)
    out: dict[str, Any] = {"n": int(len(means))}
    for name in EFFECTS:
        d = diffs[name].to_numpy()
        out[name] = {
            "estimate": float(d.mean()) if d.size else None,
            "ci": _ci(bootstrap_ci(d, resamples=boots)),
            "p": sign_flip_pvalue(d, flips=flips),
        }
    return out


def solved_effects(df, tasks, flips=K.PERMUTATIONS, boots=K.BOOTSTRAPS) -> dict[str, Any]:
    """做成与否：y 换成 solved，按 1.3 的方法算推、拉效应并给置信区间。"""
    rows = four_cell_rows(df)
    rows = rows[rows["task"].isin(tasks)]
    rate = {c: (float(g["solved"].mean()) if g["solved"].notna().any() else None) for c, g in rows.groupby("cell")}
    return {"rateByCell": rate, **_paired_effects(df, "solved", tasks, flips, boots), "exploratory": True}


def keep_failures(df, tasks, flips=K.PERMUTATIONS, boots=K.BOOTSTRAPS) -> dict[str, Any]:
    """不许挂一类的失败：每格合计、每步平均、有失败的步数（全部有结果的步）；推、拉效应按 1.3（有效题）。"""
    by: dict[str, Any] = {}
    for cell, g in df[df["p_failed"].notna()].groupby("cell"):
        by[str(cell)] = {
            "steps": int(len(g)),
            "total": float(g["p_failed"].sum()),
            "meanPerStep": float(g["p_failed"].mean()),
            "stepsWithFailures": int((g["p_failed"] > 0).sum()),
        }
    return {"byCell": by, **_paired_effects(df, "p_failed", tasks, flips, boots), "exploratory": True}


def time_positions(all_tasks: list[int]) -> dict[int, float]:
    """题的时间位置 t(i)：按时间顺序第 1 题记 0、最后一题记 1（在全部题上取位置）。"""
    n = len(all_tasks)
    if n == 1:
        return {all_tasks[0]: 0.0}
    return {t: k / (n - 1) for k, t in enumerate(sorted(all_tasks))}


def _slope(t: np.ndarray, d: np.ndarray) -> np.ndarray:
    """按行的最小二乘斜率；t 没有变化的行为 NaN。t、d 可为一维或二维（行 = 重抽）。"""
    tc = t - t.mean(axis=-1, keepdims=True)
    dc = d - d.mean(axis=-1, keepdims=True)
    sxx = (tc * tc).sum(axis=-1)
    sxy = (tc * dc).sum(axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(sxx > 0, sxy / np.where(sxx > 0, sxx, 1), np.nan)


def half_difference(d_in_time_order: np.ndarray) -> float | None:
    """后半段差：后一半题的平均 − 前一半题的平均；题数为奇数时中间一题两边都不计。"""
    n = d_in_time_order.size
    h = n // 2
    if h == 0:
        return None
    return float(d_in_time_order[n - h:].mean() - d_in_time_order[:h].mean())


def learning_curve(primary: dict[str, Any], df: pd.DataFrame, boots=K.BOOTSTRAPS) -> dict[str, Any]:
    tasks = primary["perTask"]["tasks"]
    pos = time_positions(primary["allTasks"]) if primary["allTasks"] else {}
    t = np.array([pos[x] for x in tasks], dtype=float)
    out: dict[str, Any] = {"exploratory": True}
    for name in EFFECTS:
        d = np.array(primary["perTask"][name], dtype=float)
        slope = float(_slope(t, d)) if d.size >= 2 else None
        if slope is not None and math.isnan(slope):
            slope = None
        out[name] = {
            "slope": slope,
            "slopeCi": _ci(bootstrap_stat_ci([t, d], _slope, resamples=boots)) if d.size >= 2 else None,
            "halfDifference": half_difference(d),
        }
    # 四格各自原始得分的滑动平均（窗口 9 题，居中），只作描述
    means = cell_task_means(four_cell_rows(df), "score")
    means = means[means.index.isin([x for x in primary["allTasks"] if x not in set(primary["fEmptyTasks"])])]
    curves = {}
    for c in K.CELLS:
        s = means[c].dropna()
        roll = s.rolling(K.SMOOTHING_WINDOW, center=True, min_periods=1).mean()
        curves[c] = {"tasks": [int(x) for x in roll.index], "values": [float(v) for v in roll.values]}
    out["smoothedScores"] = curves
    return out


def efficiency(df: pd.DataFrame, tasks: list[int]) -> dict[str, Any]:
    """效率：各格中位数与 90 分位；推、拉效应按题配对取差的中位数。复盘单列。"""
    out: dict[str, Any] = {"byCell": {}, "pairedMedian": {}, "exploratory": True}
    for metric in EFFICIENCY_METRICS + REVIEW_METRICS:
        per_cell = {}
        for cell, g in df.groupby("cell"):
            v = g[metric].dropna()
            if v.empty:
                continue
            per_cell[str(cell)] = {
                "median": float(np.median(v)),
                "p90": float(np.quantile(v, 0.9)),
                "n": int(v.size),
            }
        out["byCell"][metric] = per_cell
        means = cell_task_means(four_cell_rows(df), metric).reindex(tasks).dropna()
        diffs = paired_differences(means)
        out["pairedMedian"][metric] = {
            name: (float(np.median(diffs[name])) if len(diffs) else None) for name in EFFECTS
        }
    return out


def versus_minimal(df: pd.DataFrame, tasks: list[int], boots=K.BOOTSTRAPS) -> dict[str, Any]:
    """各格对最简 agent：ȳ(c, i) − y(M, i, 1) 在有效题上的平均，按题自助法给区间。M 只有一遍，区间偏宽。"""
    m = df[(df["cell"] == K.MINIMAL) & (df["pass_no"] == 1) & df["score"].notna()].set_index("task")["score"]
    means = cell_task_means(four_cell_rows(df), "score").reindex(tasks)
    common = [t for t in tasks if t in m.index]
    out: dict[str, Any] = {"n": len(common), "minimalMean": (float(m.reindex(common).mean()) if common else None),
                           "exploratory": True, "minimalPasses": 1}
    for c in K.CELLS:
        d = (means.loc[common, c] - m.reindex(common)).to_numpy(dtype=float) if common else np.array([])
        out[c] = {"estimate": float(d.mean()) if d.size else None, "ci": _ci(bootstrap_ci(d, resamples=boots))}
    return out


def memory_usage(df: pd.DataFrame) -> dict[str, Any]:
    """记忆使用：推送两格的记忆大小与各项计数；检索两格的检索计数。字段不全时只报已有的。"""
    out: dict[str, Any] = {"push": {}, "search": {}, "exploratory": True}
    extras = extra_usage_columns(df)
    for cell in ("10", "11"):
        g = df[df["cell"] == cell]
        if g.empty:
            continue
        item: dict[str, Any] = {}
        for col in ("memory_chars", "memory_bytes", "memory_entries"):
            v = g[col].dropna()
            if not v.empty:
                item[col] = {"mean": float(v.mean()), "median": float(np.median(v)), "max": float(v.max())}
        for col in extras:
            if col.startswith("mem_") and g[col].notna().any():
                item[col] = {"total": float(g[col].sum()), "meanPerStep": float(g[col].mean())}
        out["push"][cell] = item
    for cell in ("01", "11"):
        g = df[df["cell"] == cell]
        if g.empty:
            continue
        out["search"][cell] = {
            col: {"total": float(g[col].sum()), "meanPerStep": float(g[col].mean())}
            for col in extras
            if col.startswith("search_") and g[col].notna().any()
        }
    return out


def analyze_secondary(df: pd.DataFrame, primary: dict[str, Any], flips=K.PERMUTATIONS, boots=K.BOOTSTRAPS) -> dict[str, Any]:
    tasks = primary["validTasks"]
    return {
        "solved": solved_effects(df, tasks, flips, boots),
        "keepFailures": keep_failures(df, tasks, flips, boots),
        "interaction": primary["interaction"],
        "learningCurve": learning_curve(primary, df, boots),
        "efficiency": efficiency(df, tasks),
        "versusMinimal": versus_minimal(df, tasks, boots),
        "memoryUsage": memory_usage(df),
    }
