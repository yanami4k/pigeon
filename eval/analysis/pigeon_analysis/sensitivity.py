"""设计灵敏度与第 3 遍补跑规则（分析计划 3.7；决策 200、201、219、224）。

只用方差，不用任何差值的均值做决定：均值即效果，看了就等于看效果。
"""

from __future__ import annotations

import math
from typing import Any, Iterable

import numpy as np
import pandas as pd

from . import constants as K
from .primary import cell_task_means, paired_differences, select_tasks
from .stats import at_least, sample_var


def rerun_variance(df: pd.DataFrame, cells: Iterable[str]) -> dict[str, Any]:
    """单遍单格的重跑方差 v：各格同题两遍之差 e = y(·, 1) − y(·, 2) 的方差的一半，多格合并。
    合并为各格各自按题算两遍差的样本方差的一半，再对格子取简单平均（各格题目相同，等权）；
    只用两遍都有有效得分的题，不足两题的格不参与平均。"""
    halves: list[float] = []
    per_cell: dict[str, Any] = {}
    for c in cells:
        g = df[(df["cell"] == c) & df["pass_no"].isin([1, 2]) & df["score"].notna()]
        wide = g.pivot_table(index="task", columns="pass_no", values="score", aggfunc="mean")
        if 1 not in wide.columns or 2 not in wide.columns:
            per_cell[c] = {"n": 0}
            continue
        e = (wide[1] - wide[2]).dropna().to_numpy(dtype=float)
        var_e = sample_var(e)
        per_cell[c] = {"n": int(e.size), "varE": var_e}
        if var_e is not None:
            halves.append(var_e / 2)
    v = sum(halves) / len(halves) if halves else None
    return {"v": v, "cellsPooled": len(halves), "byCell": per_cell}


def mde(tau2: float, v: float, passes: int, n: int, k: float = K.MDE_MARGIN_K) -> float:
    """能以 80% 把握分辨的最小效果：MDE = (2.24 + 0.84) × √((τ² + v / R) / n) × k。"""
    return K.MDE_Z_SUM * math.sqrt((tau2 + v / passes) / n) * k


def calibration_design_sensitivity(df: pd.DataFrame, formal_tasks: int | None) -> dict[str, Any]:
    """由校准的 01、11 两格估 v 与 τ²，按正式跑 n 道有效题（要做到的不为零）、R = 2、3 各算 MDE（3.7）；
    n 未给时不算 MDE。
    τ² = max(0, s² − v)，s² 为各题 d(i) = ȳ(11, i) − ȳ(01, i)（各两遍平均）的样本方差；只用方差。"""
    var = rerun_variance(df, ("01", "11"))
    both = df[df["cell"].isin(["01", "11"]) & df["pass_no"].isin([1, 2]) & df["score"].notna()]
    counts = both.groupby("task").size()
    # 只用两格两遍都齐的题，噪声才是 2v/2 = v
    full = [int(t) for t, n in counts.items() if n == 4]
    means = cell_task_means(both[both["task"].isin(full)], "score", cells=("01", "11"))
    d = (means["11"] - means["01"]).to_numpy(dtype=float)
    s2 = sample_var(d)
    v = var["v"]
    out: dict[str, Any] = {"v": v, "rerun": var, "nPaired": len(full), "s2": s2, "formalTasks": formal_tasks, "k": K.MDE_MARGIN_K}
    if v is None or s2 is None:
        out.update({"tau2": None, "mde": None})
        return out
    tau2 = max(0.0, s2 - v)
    out["tau2"] = tau2
    out["mde"] = {str(r): mde(tau2, v, r, formal_tasks) for r in (2, 3)} if formal_tasks else None
    return out


def third_pass_reduction(tau2: float, v: float) -> float:
    """第 3 遍能把 MDE 降低的比例：1 − √((τ² + v/3) / (τ² + v/2))；两者都为零时为 0。"""
    denom = tau2 + v / 2
    if denom <= 0:
        return 0.0
    return 1 - math.sqrt((tau2 + v / 3) / denom)


def step_costs(df: pd.DataFrame) -> pd.Series:
    """每步花费含复盘（复盘未记为 0）。"""
    return df["cost"] + df["review_cost"].fillna(0.0)


def third_pass_decision(
    df: pd.DataFrame,
    minimal_reserve: float | None = None,
    budget: float = K.BUDGET_YUAN,
) -> dict[str, Any]:
    """第 3 遍补跑规则（224）：B ≥ C3，且以两遍数据推算第 3 遍能把 MDE 降低至少一成，才补。
    B = 预算 − 已花（含最简 agent；它尚未跑时按 C_M 预留，由 minimal_reserve 给出）；
    C3 = 前两遍四格实际平均每遍花费 × 1.1。v 取四格合并，τ² = max(0, 两遍平均 dP(i) 的样本方差 − v/2)，
    检索差同法推算，取降低较多者。"""
    two = df[df["pass_no"].isin([1, 2])]
    four = two[two["cell"].isin(K.CELLS)]
    var = rerun_variance(four, K.CELLS)
    v = var["v"]
    out: dict[str, Any] = {"v": v, "rerun": var}
    sel = select_tasks(four)
    means = cell_task_means(four, "score").reindex(sel["validTasks"])
    diffs = paired_differences(means)
    reductions: dict[str, Any] = {}
    for name in ("push", "search"):
        s2 = sample_var(diffs[name].to_numpy(dtype=float))
        if v is None or s2 is None:
            reductions[name] = None
            continue
        tau2 = max(0.0, s2 - v / 2)
        reductions[name] = {"s2": s2, "tau2": tau2, "reduction": third_pass_reduction(tau2, v)}
    out["byEffect"] = reductions
    got = [r["reduction"] for r in reductions.values() if r is not None]
    best = max(got) if got else None
    out["bestReduction"] = best

    costs = step_costs(four)
    missing_cost = int(costs.isna().sum())
    four_spent = float(costs.sum(skipna=True))
    passes = sorted(int(p) for p in four["pass_no"].unique())
    c3 = (four_spent / len(passes)) * K.COST_MARGIN if passes else None
    minimal = df[df["cell"] == K.MINIMAL]
    if not minimal.empty:
        m_spent = float(step_costs(minimal).sum(skipna=True))
        reserve = 0.0
        missing_cost += int(step_costs(minimal).isna().sum())
    else:
        m_spent = 0.0
        reserve = minimal_reserve
    out.update(
        {
            "fourCellSpent": four_spent,
            "minimalSpent": m_spent,
            "minimalReserve": reserve,
            "stepsWithoutCost": missing_cost,
            "c3": c3,
        }
    )
    if reserve is None:
        out.update({"remaining": None, "decision": None, "reason": "minimal-reserve-required"})
        return out
    remaining = budget - four_spent - m_spent - reserve
    out["remaining"] = remaining
    if best is None or c3 is None:
        out.update({"decision": None, "reason": "variance-unavailable"})
        return out
    enough_money = at_least(remaining, c3)
    enough_gain = at_least(best, K.THIRD_PASS_MIN_REDUCTION)
    out.update(
        {
            "budgetOk": enough_money,
            "reductionOk": enough_gain,
            "decision": bool(enough_money and enough_gain),
        }
    )
    return out
