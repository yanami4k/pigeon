"""校准各项的取值规则与抽题（分析计划第 5 节；决策 200、202、218、219、223、225、243、257、258、259）。

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

CALIBRATION_PASSES = (1, 2)

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


# 难度关的出口
GATE_STAY = "stay"
GATE_SWITCH_REPO = "switch-repo"
GATE_RETEST = "retest-with-test-cases"
GATE_START_TEST_CASES = "start-with-test-cases"
GATE_OWNER = "owner-decides"
GATE_RETEST_ABOVE = "retest-above-range"
TEST_CASES_FORMAT = "test-cases"


def difficulty_gate(df: pd.DataFrame, prompt_format: str | None = None) -> dict[str, Any]:
    """难度关（5.1、257）：01 格两遍、15 道题的部分得分平均（要做到的为零的步得分为空、不计入），只看点估计。
    30% ≤ 平均 ≤ 80% 留下（端点算在区间内）；> 80% 换仓；< 30% 切为给用例名、01 格在同 15 道题上再跑两遍复测。
    prompt_format 为用例名（test-cases）时这批结果即复测：落进区间以用例名题面开跑，仍低于 30% 交项目负责人另定；
    复测高于 80% 计划未规定，同样交项目负责人。两遍相差超过 20 个百分点注明重跑波动大，仍按合计判。
    做成率照常计算，只作描述，不参与去留。"""
    g = df[(df["cell"] == "01") & df["pass_no"].isin(CALIBRATION_PASSES) & df["score"].notna()]
    if g.empty:
        return {"meanScore": None, "decision": None, "promptFormat": prompt_format}
    mean = float(g["score"].mean())
    by_pass = {str(int(p)): float(x["score"].mean()) for p, x in g.groupby("pass_no")}
    gap = (max(by_pass.values()) - min(by_pass.values())) if len(by_pass) == 2 else None
    retest = prompt_format == TEST_CASES_FORMAT
    if above(mean, K.DIFFICULTY_HIGH):
        decision = GATE_RETEST_ABOVE if retest else GATE_SWITCH_REPO
    elif not at_least(mean, K.DIFFICULTY_LOW):
        decision = GATE_OWNER if retest else GATE_RETEST
    else:
        decision = GATE_START_TEST_CASES if retest else GATE_STAY
    solved = df[(df["cell"] == "01") & df["pass_no"].isin(CALIBRATION_PASSES) & df["solved"].notna()]["solved"]
    return {
        "meanScore": mean,
        "steps": int(len(g)),
        "tasks": int(g["task"].nunique()),
        "byPass": by_pass,
        "passGap": gap,
        "largeRerunGap": (gap is not None and above(gap, K.DIFFICULTY_PASS_GAP)),
        "solvedRate": (float(solved.mean()) if not solved.empty else None),
        "promptFormat": prompt_format,
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


# 超出 ¥650 时交项目负责人裁决的候选（258）：加预算、只在非高峰跑、最简 agent 不跑
COST_CANDIDATES = ("raise-budget", "off-peak-only", "skip-minimal")


def cost_rule(
    df: pd.DataFrame,
    formal_tasks: int = K.FORMAL_TASKS,
    budget: float = K.BUDGET_YUAN,
    comfort: float = K.BUDGET_COMFORT_YUAN,
) -> dict[str, Any]:
    """每遍花费与能跑几遍（5.2、200、258）：C_pass = n × (2 c01 + 2 c11) × 1.1，C_M = n × cM × 1.1，C_base = 2 C_pass + C_M；
    c01、c11、cM 为每步平均花费（含复盘），复盘花费另单列。C_base ≤ ¥520 按计划开跑；¥520 < C_base ≤ ¥650 开跑、事先说明
    第 3 遍基本无望；> ¥650 不自动删减条件或改跑法，交项目负责人裁决并列出候选（加预算、只在非高峰跑、最简 agent 不跑）。
    有折回非高峰价的花费列（cost_offpeak）时用它，否则用实测花费并注明。"""
    offpeak = bool("cost_offpeak" in df.columns and df["cost_offpeak"].notna().any())
    if offpeak and "review_cost_offpeak" not in df.columns:
        df = df.assign(review_cost_offpeak=np.nan)
    c01, n01 = _mean_step_cost(df, "01", offpeak)
    c11, n11 = _mean_step_cost(df, "11", offpeak)
    cm, nm = _mean_step_cost(df, K.MINIMAL, offpeak)
    review = {c: (float(df[df["cell"] == c]["review_cost"].fillna(0.0).mean()) if (df["cell"] == c).any() else None)
              for c in PIGEON_CALIBRATION_CELLS}
    out: dict[str, Any] = {"c01": c01, "c11": c11, "cM": cm, "steps": {"01": n01, "11": n11, "M": nm},
                           "reviewPerStep": review, "offpeakAdjusted": offpeak, "formalTasks": formal_tasks,
                           "candidates": []}
    if c01 is None or c11 is None or cm is None:
        out["decision"] = None
        return out
    c_pass = formal_tasks * (2 * c01 + 2 * c11) * K.COST_MARGIN
    c_m = formal_tasks * cm * K.COST_MARGIN
    c_base = 2 * c_pass + c_m
    if not above(c_base, comfort):
        decision = "go"
    elif not above(c_base, budget):
        decision = "go-third-pass-unlikely"
    else:
        decision = "owner-decides"
        out["candidates"] = list(COST_CANDIDATES)
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


def _raise_only(hit_flags: pd.Series, temp_turns: int, temp_wall_min: int) -> dict[str, Any]:
    """只上调不下调（5.4、5.6）：以结果行的撞上限标记为准，校准中没有撞即维持临时值，有撞即取临时值的两倍。
    轮数与墙钟的实测值不参与判定。没有任何标记（全为空）时不判。"""
    flags = hit_flags.dropna()
    if flags.empty:
        return {"turns": None, "wallMinutes": None, "hitTemporaryCap": None,
                "temporary": {"turns": temp_turns, "wallMinutes": temp_wall_min}}
    hit = bool((flags == 1).any())
    factor = K.CAP_RAISE_FACTOR if hit else 1
    return {
        "turns": temp_turns * factor,
        "wallMinutes": temp_wall_min * factor,
        "hitTemporaryCap": hit,
        "temporary": {"turns": temp_turns, "wallMinutes": temp_wall_min},
        "flaggedSteps": int(flags.size),
    }


def step_budget_rule(df: pd.DataFrame) -> dict[str, Any]:
    """每步宽上限（5.4、171、259）：校准时临时取 300 轮、60 分钟；校准中没有一步撞上限即正式跑维持，
    有任何一步撞了（结果行 hitStepBudget）取 600 轮、120 分钟并在报告里注明。最简 agent 与 Pigeon 共用这一上限，
    校准的全部步都看；分格列出撞上限的步数。"""
    out = _raise_only(df["hit_step_budget"], K.STEP_TEMP_TURNS, K.STEP_TEMP_WALL_MIN)
    hits = df[df["hit_step_budget"] == 1]
    out["hitSteps"] = {str(c): int(len(g)) for c, g in hits.groupby("cell")}
    turns = df["turns"].dropna()
    wall = (df["wall_ms"] / MINUTE_MS).dropna()
    out["maxTurns"] = float(turns.max()) if not turns.empty else None
    out["maxWallMinutes"] = float(wall.max()) if not wall.empty else None
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
    """复盘上限（5.6、243）：校准时临时取 40 轮、15 分钟；校准中没有复盘撞上限即正式跑维持，
    有则取 80 轮、30 分钟并在报告里注明（结果行 hitReviewBudget，收尾与压缩前的复盘都算）。"""
    out = _raise_only(df["hit_review_budget"], K.REVIEW_TEMP_TURNS, K.REVIEW_TEMP_WALL_MIN)
    out["hitSteps"] = int((df["hit_review_budget"] == 1).sum())
    turns = df["review_turns"].dropna()
    wall = (df["review_wall_ms"] / MINUTE_MS).dropna()
    out["maxTurns"] = float(turns.max()) if not turns.empty else None
    out["maxWallMinutes"] = float(wall.max()) if not wall.empty else None
    return out


def temporary_settings_check(settings: dict[str, Any] | None) -> dict[str, Any] | None:
    """身份头里校准实际用的临时值是否与计划一致：每步 300 轮、60 分钟（5.4），复盘 40 轮、15 分钟（5.6），
    记忆上限 12,000 字符（5.5）。settings 为读入层从 identity.json 读出的设置。"""
    if settings is None:
        return None
    step = settings["stepBudget"]
    review = settings["reviewBudget"]
    want = {
        "stepBudget": {"maxTurns": K.STEP_TEMP_TURNS, "wallClockMs": K.STEP_TEMP_WALL_MIN * MINUTE_MS},
        "reviewBudget": {"maxTurns": K.REVIEW_TEMP_TURNS, "wallClockMs": K.REVIEW_TEMP_WALL_MIN * MINUTE_MS},
        "memoryLimitChars": K.MEMORY_MAX_CHARS,
    }
    got = {"stepBudget": step, "reviewBudget": review, "memoryLimitChars": settings["memoryLimitChars"]}
    return {"expected": want, "actual": got, "matches": {k: got[k] == want[k] for k in want}}


def analyze_calibration(
    df: pd.DataFrame,
    formal_tasks: int = K.FORMAL_TASKS,
    formal_valid_tasks: int | None = None,
    compaction_trigger: float | None = None,
    eligible: Iterable[int] | None = None,
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """校准分析：各项取值与设计灵敏度。formal_valid_tasks 为正式跑的有效题数（89 道里要做到的不为零的题数，
    MDE 的 n），未给时只报 v 与 τ²、不算 MDE。eligible 给出时核对结果里的题是否正是按种子抽出的 15 道。
    settings 为身份头里的设置：题面格式决定难度关是否为用例名复测；没给压缩触发点时取其中的压缩触发点。"""
    prompt_format = settings["promptFormat"] if settings else None
    if compaction_trigger is None and settings and settings.get("compaction"):
        compaction_trigger = float(settings["compaction"]["thresholdTokens"])
    out: dict[str, Any] = {
        "difficultyGate": difficulty_gate(df, prompt_format),
        "cost": cost_rule(df, formal_tasks),
        "contextPeak": context_peak(df, compaction_trigger),
        "stepBudget": step_budget_rule(df),
        "memoryCap": memory_cap_rule(df),
        "reviewCap": review_cap_rule(df),
        "designSensitivity": calibration_design_sensitivity(df, formal_valid_tasks),
        "temporarySettings": temporary_settings_check(settings),
        "tasks": sorted(int(t) for t in df["task"].unique()),
    }
    if eligible is not None:
        expected = sample_tasks(eligible)
        out["sampleCheck"] = {"expected": expected, "matches": expected == out["tasks"]}
    return out
