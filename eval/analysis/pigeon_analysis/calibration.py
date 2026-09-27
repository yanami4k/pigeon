"""校准六项的取值规则与抽题（分析计划第 3 节；决策 198、200、202、218、219、223、225）。

校准结果不进正式结论；每条规则在校准开始前写定。
"""

from __future__ import annotations

import math
import random
from typing import Any, Iterable

import numpy as np
import pandas as pd

from . import constants as K
from .sensitivity import calibration_design_sensitivity, step_costs
from .stats import above, at_least, ceil_to

PIGEON_CALIBRATION_CELLS = ("01", "11")
MINUTE_MS = 60_000


def sample_order(eligible: Iterable[int], seed: int = K.SAMPLE_SEED, k: int = K.CALIBRATION_TASKS) -> list[int]:
    """random.Random(seed).sample 的抽取次序（排序之前），与跑批器二的 PythonRandom.sample 逐位比对用。
    总体按时间顺序（题号升序）排列：跑批器用流中的序号、这里用步序，两者随时间单调对应，抽中的位置相同。"""
    population = sorted(set(int(x) for x in eligible))
    if k > len(population):
        raise ValueError(f"只有 {len(population)} 道可抽的题，不足 {k} 道")
    return random.Random(seed).sample(population, k)


def sample_tasks(eligible: Iterable[int], seed: int = K.SAMPLE_SEED, k: int = K.CALIBRATION_TASKS) -> list[int]:
    """抽题（219）：只在要做到的用例不为零的题中，以 random.Random(seed).sample 抽 k 道，再按时间排序。"""
    return sorted(sample_order(eligible, seed, k))


def solved_rate_rule(df: pd.DataFrame) -> dict[str, Any]:
    """做成率门槛（3.1）：01 格两遍的步结果里 solved 的比例（两遍合计），端点都算在区间内。"""
    g = df[(df["cell"] == "01") & df["pass_no"].isin([1, 2]) & df["solved"].notna()]
    if g.empty:
        return {"rate": None, "decision": None}
    rate = float(g["solved"].mean())
    by_pass = {str(int(p)): float(x["solved"].mean()) for p, x in g.groupby("pass_no")}
    gap = (max(by_pass.values()) - min(by_pass.values())) if len(by_pass) == 2 else None
    if above(rate, K.SOLVED_RATE_HIGH):
        decision = "switch-repo"
    elif not at_least(rate, K.SOLVED_RATE_LOW):
        decision = "below-threshold"
    else:
        decision = "stay"
    return {
        "rate": rate,
        "steps": int(len(g)),
        "byPass": by_pass,
        "passGap": gap,
        "largeRerunGap": (gap is not None and above(gap, K.SOLVED_RATE_PASS_GAP)),
        "decision": decision,
    }


def _mean_step_cost(df: pd.DataFrame, cell: str, offpeak: bool) -> tuple[float | None, int]:
    g = df[df["cell"] == cell]
    if g.empty:
        return None, 0
    if offpeak:
        costs = g["cost_offpeak"] + g["review_cost_offpeak"].fillna(0.0)
    else:
        costs = step_costs(g)
    costs = costs.dropna()
    return (float(costs.mean()) if not costs.empty else None), int(costs.size)


def cost_rule(df: pd.DataFrame, formal_tasks: int = K.FORMAL_TASKS, budget: float = K.BUDGET_YUAN) -> dict[str, Any]:
    """每遍花费与能跑几遍（3.2）：C_pass = n × (2 c01 + 2 c11) × 1.1，C_M = n × cM × 1.1，C_base = 2 C_pass + C_M。
    有折回非高峰价的花费列（cost_offpeak）时用它，否则用实测花费并注明。"""
    offpeak = bool("cost_offpeak" in df.columns and df["cost_offpeak"].notna().any())
    if offpeak and "review_cost_offpeak" not in df.columns:
        df = df.assign(review_cost_offpeak=np.nan)
    c01, n01 = _mean_step_cost(df, "01", offpeak)
    c11, n11 = _mean_step_cost(df, "11", offpeak)
    cm, nm = _mean_step_cost(df, K.MINIMAL, offpeak)
    out: dict[str, Any] = {"c01": c01, "c11": c11, "cM": cm, "steps": {"01": n01, "11": n11, "M": nm},
                           "offpeakAdjusted": offpeak, "formalTasks": formal_tasks}
    if c01 is None or c11 is None or cm is None:
        out["decision"] = None
        return out
    c_pass = formal_tasks * (2 * c01 + 2 * c11) * K.COST_MARGIN
    c_m = formal_tasks * cm * K.COST_MARGIN
    c_base = 2 * c_pass + c_m
    if not above(c_base, budget * K.BUDGET_COMFORT_RATIO):
        decision = "go"
    elif not above(c_base, budget):
        decision = "go-third-pass-unlikely"
    else:
        decision = "owner-decides"
    out.update({"cPass": c_pass, "cM_total": c_m, "cBase": c_base, "decision": decision})
    return out


def context_peak(df: pd.DataFrame, compaction_trigger: float | None) -> dict[str, Any]:
    """上下文峰值（3.3、218）：只报分布；任何一步超过压缩触发点的 80% 即报告。"""
    v = df[df["cell"].isin(PIGEON_CALIBRATION_CELLS)]["peak_input"].dropna()
    if v.empty:
        return {"n": 0}
    out: dict[str, Any] = {
        "n": int(v.size),
        "median": float(np.median(v)),
        "p90": float(np.quantile(v, 0.9)),
        "max": float(v.max()),
        "compactionTrigger": compaction_trigger,
    }
    if compaction_trigger is not None:
        limit = K.CONTEXT_WARN_RATIO * compaction_trigger
        out["stepsOverWarn"] = int((v > limit).sum())
        out["warn"] = bool((v > limit).any())
    return out


def _budget_cap(
    values_max: float,
    factor: float,
    round_to: float,
    floor: float,
    cap: float | None,
) -> tuple[float, bool]:
    raw = max(ceil_to(values_max * factor, round_to), floor)
    if cap is not None and raw > cap:
        return cap, True
    return raw, False


def step_budget_rule(df: pd.DataFrame) -> dict[str, Any]:
    """每步预算上限（3.4 甲，226 按默认处理）：轮数 = 最大 × 1.5 向上取整到 10，墙钟 = 最大 × 1.5 向上取整到 5 分钟；
    不低于 150 轮、30 分钟；有步撞了临时上限（300 轮、60 分钟）则取 600 轮、120 分钟；超过 600 轮或 120 分钟封顶。
    只看 Pigeon 两格（60 个结果）。"""
    g = df[df["cell"].isin(PIGEON_CALIBRATION_CELLS)]
    turns = g["turns"].dropna()
    wall_min = (g["wall_ms"] / MINUTE_MS).dropna()
    if turns.empty or wall_min.empty:
        return {"turns": None, "wallMinutes": None}
    hit = bool(
        (g["hit_step_budget"] == 1).any()
        or (turns >= K.STEP_TEMP_TURNS).any()
        or (wall_min >= K.STEP_TEMP_WALL_MIN).any()
    )
    out: dict[str, Any] = {"maxTurns": float(turns.max()), "maxWallMinutes": float(wall_min.max()), "hitTemporaryCap": hit}
    if hit:
        out.update({"turns": 2 * K.STEP_TEMP_TURNS, "wallMinutes": 2 * K.STEP_TEMP_WALL_MIN, "capApplied": False})
        return out
    t, t_capped = _budget_cap(turns.max(), K.STEP_FACTOR, K.STEP_TURNS_ROUND, K.STEP_FLOOR_TURNS, K.STEP_CAP_TURNS)
    w, w_capped = _budget_cap(wall_min.max(), K.STEP_FACTOR, K.STEP_WALL_ROUND_MIN, K.STEP_FLOOR_WALL_MIN, K.STEP_CAP_WALL_MIN)
    out.update({"turns": t, "wallMinutes": w, "capApplied": t_capped or w_capped})
    return out


def pass_memory_growth(g: pd.DataFrame, order: list[int]) -> tuple[float | None, bool]:
    """一遍里每步平均增长（字符）。有每步复盘结束后的大小时：(最后一步复盘后 − 第一步开工时) / 两者之间的步数，
    最后一步的增长也算在内；没有时退回只用开工时大小：(最后一个 − 第一个) / 两者相隔的步数。
    返回 (增长, 是否用了复盘后的大小)。"""
    pos = {t: k for k, t in enumerate(order)}
    starts = g[["task", "memory_chars"]].dropna().sort_values("task")
    ends = g[["task", "memory_chars_after"]].dropna().sort_values("task")
    if not starts.empty and not ends.empty:
        first, last = starts.iloc[0], ends.iloc[-1]
        steps = pos[int(last["task"])] - pos[int(first["task"])] + 1
        if steps > 0:
            return float(last["memory_chars_after"] - first["memory_chars"]) / steps, True
    if len(starts) < 2:
        return None, False
    first, last = starts.iloc[0], starts.iloc[-1]
    steps = pos[int(last["task"])] - pos[int(first["task"])]
    if steps <= 0:
        return None, False
    return float(last["memory_chars"] - first["memory_chars"]) / steps, False


def memory_cap_rule(df: pd.DataFrame) -> dict[str, Any]:
    """记忆总量硬上限（3.5、223）：上限 = 11 格每步平均增长字符数 × 30，向上取整到 1,000，限制在 2,200 到 12,000 之间。
    两遍增长速度相差超过一倍时取较快的一遍，否则取两遍平均。只按字符算，结果行没有字符数时不给上限。"""
    g = df[df["cell"] == "11"]
    order = sorted(int(t) for t in df["task"].unique())
    growth: dict[str, float | None] = {}
    end_of_pass: dict[str, bool] = {}
    for p, x in g.groupby("pass_no"):
        growth[str(int(p))], end_of_pass[str(int(p))] = pass_memory_growth(x, order)
    rates = [r for r in growth.values() if r is not None]
    out: dict[str, Any] = {"growthByPass": growth, "usedEndOfStepSizes": end_of_pass}
    if not rates:
        out["capChars"] = None
        out["reason"] = "memory-chars-missing"
        return out
    if len(rates) >= 2:
        lo, hi = min(rates), max(rates)
        diverged = above(hi, 2 * lo) if lo > 0 else (hi > 0 and hi != lo)
        rate = hi if diverged else sum(rates) / len(rates)
    else:
        diverged = False
        rate = rates[0]
    raw = ceil_to(rate * K.MEMORY_GROWTH_STEPS, K.MEMORY_ROUND)
    cap = min(max(raw, K.MEMORY_MIN_CHARS), K.MEMORY_MAX_CHARS)
    out.update({"growthUsed": rate, "passesDiverged": diverged, "rounded": raw, "capChars": cap,
                "clamped": cap != raw})
    return out


def review_cap_rule(df: pd.DataFrame) -> dict[str, Any]:
    """复盘上限（3.6）：轮数 = 最大 × 1.5 向上取整到 5、不低于 20；墙钟 = 最大 × 1.5 向上取整到 1 分钟、不低于 5 分钟；
    有复盘撞了临时上限（40 轮、10 分钟）就取临时上限的 2 倍。"""
    turns = df["review_turns"].dropna()
    wall_min = (df["review_wall_ms"] / MINUTE_MS).dropna()
    if turns.empty or wall_min.empty:
        return {"turns": None, "wallMinutes": None}
    hit = bool(
        (df["hit_review_budget"] == 1).any()
        or (turns >= K.REVIEW_TEMP_TURNS).any()
        or (wall_min >= K.REVIEW_TEMP_WALL_MIN).any()
    )
    out: dict[str, Any] = {"maxTurns": float(turns.max()), "maxWallMinutes": float(wall_min.max()), "hitTemporaryCap": hit}
    if hit:
        out.update({"turns": 2 * K.REVIEW_TEMP_TURNS, "wallMinutes": 2 * K.REVIEW_TEMP_WALL_MIN})
        return out
    t, _ = _budget_cap(turns.max(), K.REVIEW_FACTOR, K.REVIEW_TURNS_ROUND, K.REVIEW_FLOOR_TURNS, None)
    w, _ = _budget_cap(wall_min.max(), K.REVIEW_FACTOR, K.REVIEW_WALL_ROUND_MIN, K.REVIEW_FLOOR_WALL_MIN, None)
    out.update({"turns": t, "wallMinutes": w})
    return out


def analyze_calibration(
    df: pd.DataFrame,
    formal_tasks: int = K.FORMAL_TASKS,
    formal_valid_tasks: int | None = None,
    compaction_trigger: float | None = None,
    eligible: Iterable[int] | None = None,
) -> dict[str, Any]:
    """校准分析：六项取值与设计灵敏度。formal_valid_tasks 为正式跑的有效题数（89 道里要做到的不为零的题数，
    MDE 的 n），未给时只报 v 与 τ²、不算 MDE。eligible 给出时核对结果里的题是否正是按种子抽出的 15 道。"""
    out: dict[str, Any] = {
        "solvedRate": solved_rate_rule(df),
        "cost": cost_rule(df, formal_tasks),
        "contextPeak": context_peak(df, compaction_trigger),
        "stepBudget": step_budget_rule(df),
        "memoryCap": memory_cap_rule(df),
        "reviewCap": review_cap_rule(df),
        "designSensitivity": calibration_design_sensitivity(df, formal_valid_tasks),
        "tasks": sorted(int(t) for t in df["task"].unique()),
    }
    if eligible is not None:
        expected = sample_tasks(eligible)
        out["sampleCheck"] = {"expected": expected, "matches": expected == out["tasks"]}
    return out
