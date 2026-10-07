"""对比评测试跑的取值规则（分析计划第 5 节；决策 398、399、400、404）。

试跑结果不进正式结论：这里只看花费、上限与机制是否正常，不看两组得分之差。能自动算的都算出来；要人判断的（撞上限的步
是在打转还是确实做不完、留存体积不符的原因、账单核对）列出依据，交人看。主判据选定（404①）只看两组合并的平均水平，
不看两组之差。
"""

from __future__ import annotations

from typing import Any, Iterable

import numpy as np
import pandas as pd

from . import constants as K
from .calibration import sample_tasks
from .comparative import GROUP_D, GROUP_P, GROUPS
from .stats import at_least

MIB = 1024 * 1024
MB = 1_000_000
GB = 1_000_000_000
# 实付与非高峰折算比较的相对容差（浮点）
COST_TOL = 1e-6


# 主判据选定（404①）的质量指标取值：部分得分（score）或做成与否（solved）
PRIMARY_METRIC_NAMES = {"partial": "score", "solved": "solved"}


def primary_selection(df: pd.DataFrame) -> dict[str, Any]:
    """主判据选定（404①）：两组合并的平均部分得分 ≥ 90% 时正式跑主判据为做成与否，否则维持部分得分；只看合并水平。"""
    x = df[df["cell"].isin(GROUPS)]["score"].dropna()
    merged = float(x.mean()) if not x.empty else None
    use_solved = merged is not None and at_least(merged, K.CEILING_SCORE)
    return {"mergedScore": merged, "steps": int(len(x)), "ceiling": K.CEILING_SCORE,
            "primary": "solved" if use_solved else "partial"}

def budget_rule(df: pd.DataFrame) -> dict[str, Any]:
    """花费与预算（5.2）：cP、cD 为两组每步平均的非高峰花费（有网关计量的步），C = 79 × (cP + cD) × 2 × 1.2。
    另核对实付与非高峰折算：实付应在折算的 1 到 2 倍之间（高峰整条翻倍），超出即价目对不上；高于折算的步为按高峰价计的步。"""
    out: dict[str, Any] = {"byGroup": {}, "priceMismatchSteps": [], "peakBilledSteps": []}
    for g in GROUPS:
        x = df[(df["cell"] == g) & df["cost_offpeak"].notna()]
        out["byGroup"][g] = {"steps": int(len(x)),
                             "meanOffpeak": float(x["cost_offpeak"].mean()) if len(x) else None,
                             "meanActual": float(x["cost"].mean()) if len(x) else None,
                             "totalOffpeak": float(x["cost_offpeak"].sum()), "totalActual": float(x["cost"].sum())}
        for _, r in x.iterrows():
            where = {"group": g, "task": int(r["task"]), "pass": int(r["pass_no"])}
            low, cost = float(r["cost_offpeak"]), float(r["cost"])
            if cost < low * (1 - COST_TOL) - 1e-9 or cost > K.PEAK_MULTIPLIER * low * (1 + COST_TOL) + 1e-9:
                out["priceMismatchSteps"].append(where)
            elif cost > low * (1 + COST_TOL) + 1e-9:
                out["peakBilledSteps"].append(where)
    cp, cd = out["byGroup"][GROUP_P]["meanOffpeak"], out["byGroup"][GROUP_D]["meanOffpeak"]
    out["formula"] = {"tasks": K.COMPARATIVE_TASKS, "passes": K.COMPARATIVE_PASSES, "margin": K.COMPARATIVE_COST_MARGIN}
    out["budget"] = (K.COMPARATIVE_TASKS * (cp + cd) * K.COMPARATIVE_PASSES * K.COMPARATIVE_COST_MARGIN
                     if cp is not None and cd is not None else None)
    return out


def cap_rule(df: pd.DataFrame, settings: list[dict[str, Any]], caps: dict[str, Any]) -> dict[str, Any]:
    """每步上限（5.3、398）：身份头的每步墙钟应为 60 分钟；有一步撞了墙钟上限即列出、先看轨迹（打转先在产品里解决，
    确实做不完则正式跑上调到 120 分钟并在报告里注明）；没有撞即维持 60 分钟。轮数两组都不限，不作上限。"""
    walls = sorted({float(s["stepBudget"]["wallClockMs"]) / 60_000 for s in settings})
    hits = [{"group": g, **x} for g in GROUPS for x in caps[g]["wallCapSteps"]]
    return {
        "wallClockMinutes": walls,
        "matchesPlan": walls == [float(K.PILOT_STEP_WALL_MIN)],
        "hitSteps": hits,
        "turnLimitSteps": [{"group": g, **x} for g in GROUPS for x in caps[g]["turnLimitSteps"]],
        "flaggedOnlyByTurns": [{"group": g, **x} for g in GROUPS for x in caps[g]["flaggedSteps"]
                               if x not in caps[g]["wallCapSteps"]],
        "decision": "diagnose-trajectories" if hits else "keep",
        "raisedMinutes": K.RAISED_STEP_WALL_MIN,
    }


def worktree_rule(df: pd.DataFrame, mech: dict[str, Any], free_gb: float | None) -> dict[str, Any]:
    """工作树占盘（5.4、399）：k = Pigeon 组每题派出的建工作树的 worker 平均数；推算 k × 33 MB × 79 × 2 × 1.5，
    超过剩余空间减 5 GB 即正式跑前改为判完一题即删该题的工作树。没给剩余空间只推算、不判。"""
    v = df[df["cell"] == GROUP_P]["mech_worktree_workers"].dropna() if "mech_worktree_workers" in df.columns else []
    if len(v) == 0:
        return {"k": None, "reason": "no-session-records"}
    k = float(np.mean(v))
    projected = k * K.WORKTREE_MB * MB * K.COMPARATIVE_TASKS * K.COMPARATIVE_PASSES * K.WORKTREE_MARGIN
    out: dict[str, Any] = {"k": k, "steps": int(len(v)), "projectedBytes": projected,
                           "worktreesOnDisk": mech.get("worktreesOnDisk"), "freeGb": free_gb}
    if free_gb is not None:
        allowed = (free_gb - K.DISK_RESERVE_GB) * GB
        out.update({"allowedBytes": allowed, "deleteAfterJudging": projected > allowed})
    return out


def retention_check(df: pd.DataFrame, retention: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """网关留存（5.4、394、396）：每步都有留存（有网关计量的步）、每题体积与估算比、存全量与截断的请求、回复状态、
    多轮请求的 400、回复里思考块的签名、请求里回传的思考块签名、请求头里的敏感名。"""
    lo, hi = K.RETENTION_ESTIMATE_MIB
    out: dict[str, Any] = {}
    for g in GROUPS:
        steps: list[dict[str, Any]] = []
        lacking: list[dict[str, int]] = []
        blobs = 0
        for job in retention[g]:
            p = job["pass"]
            have = job.get("steps", {}) if job.get("available") else {}
            blobs += int(job.get("blobBytes") or 0)
            ran = df[(df["cell"] == g) & (df["pass_no"] == p) & df["cost_offpeak"].notna()]["task"]
            lacking += [{"task": int(t), "pass": p} for t in ran if int(t) not in have]
            steps += [{"task": int(seq), "pass": p, **s} for seq, s in sorted(have.items())]
        sizes = np.array([s["bytes"] / MIB for s in steps], dtype=float)
        total = lambda key: int(sum(s.get(key, 0) for s in steps))
        statuses: dict[str, int] = {}
        for s in steps:
            for k, v in s.get("statuses", {}).items():
                statuses[k] = statuses.get(k, 0) + int(v)
        out[g] = {
            "steps": len(steps),
            "stepsWithoutRetention": lacking,
            "sizeMiB": ({"median": float(np.median(sizes)), "p90": float(np.quantile(sizes, 0.9)),
                         "max": float(sizes.max())} if sizes.size else None),
            "outsideEstimate": [{"task": s["task"], "pass": s["pass"], "mib": s["bytes"] / MIB} for s in steps
                                if not lo <= s["bytes"] / MIB <= hi],
            "blobMiB": blobs / MIB,
            **{key: total(key) for key in ("requests", "fullRequests", "truncatedRequests", "truncatedReplies",
                                           "multiTurn400", "thinkingBlocks", "thinkingEmptySignature", "echoedThinking",
                                           "echoedThinkingEmptySignature", "sensitiveHeaders", "tries")},
            "statuses": statuses,
        }
        x = out[g]
        x["checks"] = {
            "everyStepRetained": not lacking,
            "signaturesNonEmpty": x["thinkingBlocks"] > 0 and x["thinkingEmptySignature"] == 0,
            "noMultiTurn400": x["multiTurn400"] == 0,
            "noSensitiveHeaders": x["sensitiveHeaders"] == 0,
        }
    return out


def sample_check(df: pd.DataFrame, eligible: Iterable[int] | None) -> dict[str, Any] | None:
    """抽题核对（5.1、400）：要做到的不为空的题（步序）里以 random.Random(20261007).sample 抽 8 道、按时间排序。"""
    if eligible is None:
        return None
    expected = sample_tasks(eligible, K.PILOT_SAMPLE_SEED, K.PILOT_TASKS)
    seen = sorted(int(t) for t in df[df["cell"].isin(GROUPS)]["task"].unique())
    return {"expected": expected, "seen": seen, "matches": seen == expected}


def analyze_pilot(df: pd.DataFrame, info: dict[str, Any], caps: dict[str, Any], mech: dict[str, Any],
                  free_gb: float | None = None, eligible: Iterable[int] | None = None) -> dict[str, Any]:
    pauses = info["peakPauses"]
    n_pauses = sum(p["pauses"] for p in pauses)
    budget = budget_rule(df)
    return {
        "primarySelection": primary_selection(df),
        "budget": budget,
        "stepCap": cap_rule(df, info["settings"], caps),
        "worktrees": worktree_rule(df, mech, free_gb),
        "retention": retention_check(df, info["retention"]),
        "workers": {"spawned": (mech["counts"].get("mech_workers") or {}).get("total"), "roles": mech["roles"],
                    "settled": mech["settled"], "available": mech["available"]},
        "peakPause": {"pauses": n_pauses, "resumes": sum(p["resumes"] for p in pauses),
                      "unresumed": sum(p["unresumed"] for p in pauses), "covered": n_pauses > 0,
                      "peakBilledSteps": len(budget["peakBilledSteps"])},
        "voids": {g: caps[g]["voids"] for g in GROUPS},
        "missing": {g: caps[g]["missingSteps"] for g in GROUPS},
        "sampleCheck": sample_check(df, eligible),
    }
