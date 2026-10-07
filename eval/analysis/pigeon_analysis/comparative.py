"""对比评测的主判据与次要判据（docs/roadmap/comparative-eval-analysis-plan.md 第 1–3 节；决策 385、388、391、398–401、404）。

两组：P 为 Pigeon 组、D 为对照组，条件名由命令行给（--group-a 为 P，--group-b 为 D）。规整表里两组的格子记作 P 与 D。
主判据只有一个（404）：正式跑的主判据按重做试跑两组合并的平均部分得分选定（≥ 90% 用做成与否，否则用部分得分，只看
合并水平），由命令行 --primary 显式给定为部分得分（score）或做成与否（solved）；按题配对差 d(i) = ȳ(P, i) − ȳ(D, i)，
各组先把各遍等权平均、缺一遍按另一遍计（做成与否的各遍平均取值 0、0.5、1）。主检验为按题配对的符号翻转置换检验，
置信区间为按题自助法，随机种子写死在 constants.py。混合模型只作稳健性对照。每题花费为关键次要判据（404②），与主判据
两项按 Holm 两步控制总误报率 5%（stats.holm_two_step）。
"""

from __future__ import annotations

import json
import math
import warnings
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

from . import constants as K
from .comparative_sources import (
    agent_tries,
    job_dir,
    peak_pauses,
    pigeon_mechanisms,
    retention_job,
    MECHANISM_COLUMNS,
)
from .primary import cell_task_means, select_tasks
from .reader import ResultFieldError, read_gateway_spend, read_identity, read_jsonl, record_for_cell
from .secondary import _distribution, _slope, half_difference, time_positions
from .stats import EPS, above, at_least, bootstrap_ci, bootstrap_stat_ci, holm_two_step, paired_dz, sign_flip_pvalue
from .table import make_table

GROUP_P = "P"
GROUP_D = "D"
GROUPS = (GROUP_P, GROUP_D)

# 花费与效率（第 3 节）：非高峰折算的花费、实付花费（含高峰，参照）、输入 token（未命中 / 命中）、输出 token（含思考）、墙钟、请求数
EFFICIENCY_METRICS = ("cost_offpeak", "cost", "input_miss", "input_hit", "output_tokens", "wall_ms", "turns")


def offpeak_cost(usage: dict[str, Any] | None) -> float | None:
    """一步的非高峰花费（元）：按非高峰价目计这一步网关读到的用量合计；cache_creation 按未命中价计（同网关）。"""
    if not isinstance(usage, dict):
        return None
    price = K.OFFPEAK_PRICE_CNY_PER_MTOK
    miss = float(usage.get("input") or 0) + float(usage.get("cacheWrite") or 0)
    return (miss * price["cacheMiss"] + float(usage.get("cacheRead") or 0) * price["cacheHit"]
            + float(usage.get("output") or 0) * price["output"]) / 1_000_000


def _extra(row: dict[str, Any], wall_cap_ms: float) -> dict[str, Any]:
    """结果行里规整表之外、对比评测要用的几项：非高峰花费、撞墙钟上限、以轮数上限收尾、没判分、缺用量的请求数。
    两组都不限轮数（398），撞每步上限只看墙钟：终态 wall-clock-limit 或 agent 用时达到墙钟上限。结果行的 hitStepBudget
    另把"轮数（网关请求数）达到身份头的 maxTurns"也算作撞上限，这里不用它判上限，只在报告里并列。"""
    status = row.get("status")
    ran = status is not None
    wall = row.get("agentWallMs")
    return {
        "cost_offpeak": offpeak_cost(row.get("usage")) if row.get("gateway") is not None else None,
        # 结果行网关一节的 usageMissing：读回复中途断开、用量不齐而没能计价的请求数（没有即不出现，按 0 计）；
        # 这些请求的 token 与花费不在行里，合计大于 0 时花费可能偏低
        "usage_missing": (int(row["gateway"].get("usageMissing") or 0)
                          if isinstance(row.get("gateway"), dict) else None),
        "wall_cap_hit": (1.0 if status == "wall-clock-limit" or (wall is not None and wall >= wall_cap_ms) else 0.0)
        if ran else None,
        "turn_limit": (1.0 if status == "turn-limit" else 0.0) if ran else None,
        "not_judged": 1.0 if (row.get("judging") is None and not row.get("baselineUnavailable")) else 0.0,
    }


def load_comparative(paths: Iterable[str | Path], group_a: str, group_b: str,
                     with_retention: bool = False) -> tuple[pd.DataFrame, dict[str, Any]]:
    """读结果文件里两组的题步结果行，合成规整表（格子为 P、D）；其余条件的行跳过并计数。
    每个结果文件所在目录即输出目录：读其 identity.json、作业目录下的尝试目录、Pigeon 组的会话文件；
    with_retention 时另读网关留存（试跑核对用，体积大）。缺字段、身份摘要不符或某组没有结果行即报错。"""
    if group_a == group_b:
        raise ValueError("--group-a 与 --group-b 不能是同一个条件")
    to_group = {group_a: GROUP_P, group_b: GROUP_D}
    rows = read_jsonl([Path(p) for p in paths])
    by_dir: dict[Path, list[tuple[Path, int, dict[str, Any]]]] = {}
    ignored = 0
    for f, k, row in rows:
        if row.get("kind") is not None and row.get("kind") != "task":
            continue
        if row.get("condition") not in to_group:
            ignored += 1
            continue
        by_dir.setdefault(f.parent, []).append((f, k, row))
    records: list[dict[str, Any]] = []
    settings: list[dict[str, Any]] = []
    identities: list[dict[str, Any]] = []
    tries: dict[tuple[str, int], dict[int, int] | None] = {}
    mech_steps: dict[tuple[int, int], dict[str, float]] = {}
    mech_jobs: list[dict[str, Any]] = []
    retention: dict[str, list[dict[str, Any]]] = {g: [] for g in GROUPS}
    pauses: list[dict[str, Any]] = []
    spend: list[dict[str, Any]] = []
    for run_dir, items in by_dir.items():
        ident = read_identity(run_dir, needs_pigeon=False)
        raw = json.loads((run_dir / "identity.json").read_text(encoding="utf-8"))
        settings.append(ident)
        identities.append(_identity_summary(run_dir, raw, group_a, group_b))
        wall_cap = float(ident["stepBudget"]["wallClockMs"])
        jobs: dict[tuple[str, str, int], list[int]] = {}
        for f, k, row in items:
            if row["runIdentity"] is not None and row["runIdentity"] != ident["digest"]:
                raise ResultFieldError(f"结果行的身份摘要 {row['runIdentity']} 与 identity.json 的 {ident['digest']} 不一致"
                                       f"（{f.name} 第 {k} 行）")
            group = to_group[row["condition"]]
            rec = record_for_cell(row, group, f"{f.name} 第 {k} 行")
            rec.update(_extra(row, wall_cap))
            records.append(rec)
            jobs.setdefault((str(row.get("stream") or "tasks"), row["condition"], int(row["attempt"])), []).append(
                int(row["seq"]))
        for (stream, condition, attempt), seqs in sorted(jobs.items()):
            group = to_group[condition]
            job = job_dir(run_dir, stream, condition, attempt)
            tries[(group, attempt)] = agent_tries(job)
            if group == GROUP_P:
                per_step, job_info = pigeon_mechanisms(job, seqs)
                mech_jobs.append({"pass": attempt, **job_info})
                for seq, m in per_step.items():
                    mech_steps[(seq, attempt)] = m
            if with_retention:
                retention[group].append({"pass": attempt, "seqs": sorted(set(seqs)), **retention_job(job)})
        pauses.append({"dir": run_dir.name, **peak_pauses(run_dir)})
        spend.append({"dir": run_dir.name, **read_gateway_spend(run_dir)})
    for g, cond in ((GROUP_P, group_a), (GROUP_D, group_b)):
        if not any(r["cell"] == g for r in records):
            raise ValueError(f"结果行里没有条件 {cond} 的题步行（{'--group-a' if g == GROUP_P else '--group-b'}）")
    for rec in records:
        if rec["cell"] == GROUP_P:
            rec.update(mech_steps.get((int(rec["task"]), int(rec["pass_no"])), {}))
    info = {
        "groups": {GROUP_P: group_a, GROUP_D: group_b},
        "rows": len(rows),
        "records": len(records),
        "ignoredRows": ignored,
        "settings": settings,
        "identities": identities,
        "tries": {f"{g}-{p}": v for (g, p), v in sorted(tries.items())},
        "mechanismJobs": mech_jobs,
        "retention": retention if with_retention else None,
        "peakPauses": pauses,
        "spend": spend,
    }
    return make_table(records), info


def _identity_summary(run_dir: Path, raw: dict[str, Any], group_a: str, group_b: str) -> dict[str, Any]:
    """身份头里报告要列的项：每步墙钟、选题、高峰暂停余量、留存设置，两组各自的产物或工具目录摘要与自报版本。"""
    core = raw.get("core") or {}
    agents = core.get("agents") or {}
    info = raw.get("info") or {}

    def agent(cond: str) -> dict[str, Any] | None:
        seg = agents.get("pigeonDocker") if cond == "pigeon-docker" else agents.get(cond)
        if not isinstance(seg, dict):
            return None
        return {"digest": seg.get("bundleDigest") or seg.get("toolDirDigest"), "selfReported": seg.get("selfReported")}

    return {
        "dir": run_dir.name,
        "digest": raw.get("digest"),
        "wallClockMs": (core.get("budget") or {}).get("wallClockMs"),
        "taskSelection": core.get("taskSelection"),
        "peakPause": info.get("peakPause"),
        "gatewayRetention": info.get("gatewayRetention"),
        "harness": info.get("harness"),
        "agents": {GROUP_P: agent(group_a), GROUP_D: agent(group_b)},
    }


# ---------- 主判据（第 2 节） ----------

def _two_group_rows(df: pd.DataFrame) -> pd.DataFrame:
    return df[df["cell"].isin(GROUPS)]


def comparative_mixed_model(df: pd.DataFrame, valid: list[int], metric: str = "score") -> dict[str, Any]:
    """稳健性对照（2.3）：y ~ 组 + (1|题) + (1|作业)，作业 = 组 × 遍。组按 P = +0.5、D = −0.5 编码，系数即 P − D。
    y 取主判据的指标（部分得分或做成与否，404①）。"""
    import statsmodels.api as sm

    sub = _two_group_rows(df)
    sub = sub[sub["task"].isin(valid) & sub[metric].notna()].copy()
    if sub.empty or len(valid) < 2:
        return {"error": "not-enough-data"}
    sub["arm"] = np.where(sub["cell"] == GROUP_P, 0.5, -0.5)
    sub["job"] = sub["cell"] + "-" + sub["pass_no"].astype(str)
    sub["one"] = 1
    try:
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            model = sm.MixedLM.from_formula(f"{metric} ~ arm", groups="one", re_formula="0",
                                            vc_formula={"task": "0 + C(task)", "job": "0 + C(job)"}, data=sub)
            fit = model.fit(reml=True)
            caught = sorted({type(x.message).__name__ + ": " + str(x.message).splitlines()[0] for x in w})
        coef, p = float(fit.params["arm"]), float(fit.pvalues["arm"])
    except Exception as e:  # 拟合失败照实报告，不影响主检验
        return {"error": f"{type(e).__name__}: {e}"}
    return {
        "coef": coef,
        "p": p,
        "significant": (not math.isnan(p)) and p <= K.ALPHA,
        "converged": bool(fit.converged),
        "varianceComponents": {name: float(v) for name, v in zip(model.exog_vc.names, fit.vcomp)},
        "residualVariance": float(fit.scale),
        "warnings": caught,
    }


def model_sensitivity(estimate: float | None, significant: bool, mixed: dict[str, Any]) -> bool | None:
    """与主检验方向或显著性不一致即结论对建模方式敏感；混合模型没拟合出来或未收敛时不比较（None）。"""
    if estimate is None or "error" in mixed or not mixed.get("converged", False):
        return None
    return bool(np.sign(estimate) != np.sign(mixed["coef"]) or significant != mixed["significant"])


def comparative_primary(
    df: pd.DataFrame,
    expected_tasks: Iterable[int] | None = None,
    baseline_unavailable: Iterable[int] | None = None,
    flips: int = K.PERMUTATIONS,
    boots: int = K.BOOTSTRAPS,
    with_mixed: bool = True,
    metric: str = "score",
) -> dict[str, Any]:
    """主判据（2.1–2.4、404①）：有效题、缺失、Δ 与检验、自助法区间、dz、相对差、本次数据的最小可分辨差距 M、稳健性对照。
    metric 为 score（部分得分）或 solved（做成与否）；做成与否时 ȳ 取各遍做成与否的平均（0、0.5、1），检验、区间与 M 同部分得分。
    "两组都接近满分"的注记按第 4 节始终看部分得分（两种指标下口径一致）。"""
    if metric not in ("score", "solved"):
        raise ValueError(f"主判据的指标只认 score（部分得分）与 solved（做成与否），给了 {metric!r}")
    sel = select_tasks(df, expected_tasks, baseline_unavailable, cells=GROUPS)
    valid = sel["validTasks"]
    rows = _two_group_rows(df)
    means = cell_task_means(rows, metric, GROUPS).reindex(valid)
    d = (means[GROUP_P] - means[GROUP_D]).to_numpy(dtype=float)
    n = int(d.size)
    est = float(d.mean()) if n else None
    ci = bootstrap_ci(d, resamples=boots, seed=K.COMPARATIVE_BOOTSTRAP_SEED)
    p = sign_flip_pvalue(d, flips=flips, seed=K.COMPARATIVE_PERMUTATION_SEED)
    sd = float(d.std(ddof=1)) if n >= 2 else None
    mde = K.COMPARATIVE_MDE_Z_SUM * sd / math.sqrt(n) if sd is not None else None
    group_means = {g: (float(means[g].mean()) if n else None) for g in GROUPS}
    score_means = means if metric == "score" else cell_task_means(rows, "score", GROUPS).reindex(valid)
    score_group_means = {g: (float(score_means[g].mean()) if n else None) for g in GROUPS}
    significant = p is not None and p <= K.ALPHA
    within = (ci is not None and mde is not None and ci[0] >= -mde - EPS and ci[1] <= mde + EPS)
    n_missing = len(sel["missingTasks"])
    ratio = (n_missing / n) if n else (math.inf if n_missing else 0.0)
    result: dict[str, Any] = {
        "metric": metric,
        **sel,
        "nValid": n,
        "missingRatio": ratio if math.isfinite(ratio) else None,
        "exploratory": above(ratio, K.MISSING_EXPLORATORY_RATIO),
        "passesPerGroup": {g: int(rows[rows["cell"] == g]["pass_no"].nunique()) for g in GROUPS},
        "groupPassScores": {g: {str(int(r)): float(x["score"].mean())
                                for r, x in rows[(rows["cell"] == g) & rows["task"].isin(valid) & rows["score"].notna()]
                                .groupby("pass_no")} for g in GROUPS},
        "groupMeans": group_means,
        "scoreGroupMeans": score_group_means,
        "bothNearCeiling": n > 0 and all(at_least(score_group_means[g], K.CEILING_SCORE) for g in GROUPS),
        "effect": {
            "estimate": est,
            "ci": list(ci) if ci else None,
            "p": p,
            "significant": significant,
            "dz": paired_dz(d),
            "sd": sd,
            "mde": mde,
            "ciWithinMde": within,
            "relative": (est / group_means[GROUP_D]) if (est is not None and group_means[GROUP_D]) else None,
        },
        "perTask": {"tasks": valid, "d": d.tolist(), GROUP_P: means[GROUP_P].tolist(), GROUP_D: means[GROUP_D].tolist()},
    }
    if with_mixed:
        mixed = comparative_mixed_model(df, valid, metric)
        result["mixedModel"] = mixed
        result["modelSensitive"] = model_sensitivity(est, significant, mixed)
    return result


# ---------- 关键次要判据：每题花费（404②） ----------

def cost_criterion(
    df: pd.DataFrame,
    tasks: list[int],
    flips: int = K.PERMUTATIONS,
    boots: int = K.BOOTSTRAPS,
) -> dict[str, Any]:
    """每题花费（404②）：c(g, i) 为该组该题各遍最终有效那次的网关花费（非高峰折算）的平均，dc(i) = c(P, i) − c(D, i)。
    按题配对的符号翻转置换检验（双侧）与按题自助法 95% 区间，相对差 = mean(dc) ÷ mean(c(D))；显著与否由 Holm 两步判
    （holm_primary_cost），这里只给 p。另报每组缺用量的请求合计（usageMissing）：大于 0 时花费可能偏低。"""
    rows = _two_group_rows(df)
    means = cell_task_means(rows, "cost_offpeak", GROUPS).reindex(tasks).dropna()
    d = (means[GROUP_P] - means[GROUP_D]).to_numpy(dtype=float)
    group_means = {g: (float(means[g].mean()) if d.size else None) for g in GROUPS}
    est = float(d.mean()) if d.size else None
    ci = bootstrap_ci(d, resamples=boots, seed=K.COMPARATIVE_BOOTSTRAP_SEED)
    return {
        "n": int(d.size),
        "tasks": [int(t) for t in means.index],
        "groupMeans": group_means,
        "estimate": est,
        "ci": list(ci) if ci else None,
        "p": sign_flip_pvalue(d, flips=flips, seed=K.COMPARATIVE_PERMUTATION_SEED),
        "relative": (est / group_means[GROUP_D]) if (est is not None and group_means[GROUP_D]) else None,
        "usageMissing": {g: int(rows.loc[rows["cell"] == g, "usage_missing"].sum()) for g in GROUPS},
    }


def holm_primary_cost(primary: dict[str, Any], cost: dict[str, Any]) -> dict[str, Any]:
    """主判据与每题花费两项的 Holm 两步（404②）：较小的 p ≤ 0.025 则该项显著并进入第二步，第二步较大的 p ≤ 0.05。
    返回各项的 p、门槛与显著与否（顺序为主判据、每题花费），供结论措辞与报告使用。"""
    p = (primary["effect"]["p"], cost["p"])
    h = holm_two_step(p)
    return {"items": ["primary", "cost"], "p": list(p),
            "significant": [bool(h.significant[0]), bool(h.significant[1])],
            "thresholds": [h.thresholds[0], h.thresholds[1]]}

def _paired(df: pd.DataFrame, metric: str, tasks: list[int], flips: int, boots: int) -> dict[str, Any]:
    """按 2.1 的配对方法：各组各遍等权平均后按题取 P − D，在两组都有该项的题上给平均、区间与 p。"""
    means = cell_task_means(_two_group_rows(df), metric, GROUPS).reindex(tasks).dropna()
    d = (means[GROUP_P] - means[GROUP_D]).to_numpy(dtype=float)
    ci = bootstrap_ci(d, resamples=boots, seed=K.COMPARATIVE_BOOTSTRAP_SEED)
    return {"n": int(d.size), "estimate": float(d.mean()) if d.size else None, "ci": list(ci) if ci else None,
            "p": sign_flip_pvalue(d, flips=flips, seed=K.COMPARATIVE_PERMUTATION_SEED)}


def _paired_median(df: pd.DataFrame, metric: str, tasks: list[int]) -> float | None:
    means = cell_task_means(_two_group_rows(df), metric, GROUPS).reindex(tasks).dropna()
    d = (means[GROUP_P] - means[GROUP_D]).to_numpy(dtype=float)
    return float(np.median(d)) if d.size else None


def learning(primary: dict[str, Any], boots: int) -> dict[str, Any]:
    """d(i) 对时间位置 t(i)（全部题按时间，第 1 题 0、最后一题 1）的最小二乘斜率与后半段差；只作描述。"""
    tasks = primary["perTask"]["tasks"]
    d = np.array(primary["perTask"]["d"], dtype=float)
    if d.size < 2:
        return {"slope": None, "slopeCi": None, "halfDifference": half_difference(d) if d.size else None}
    pos = time_positions(primary["allTasks"])
    t = np.array([pos[x] for x in tasks], dtype=float)
    slope = float(_slope(t, d))
    ci = bootstrap_stat_ci([t, d], _slope, resamples=boots, seed=K.COMPARATIVE_BOOTSTRAP_SEED)
    return {"slope": None if math.isnan(slope) else slope, "slopeCi": list(ci) if ci else None,
            "halfDifference": half_difference(d)}


def expected_passes(df: pd.DataFrame) -> list[int]:
    return sorted(int(p) for p in _two_group_rows(df)["pass_no"].unique())


def caps_and_voids(df: pd.DataFrame, primary: dict[str, Any], info: dict[str, Any]) -> dict[str, Any]:
    """撞上限与作废（第 3 节）：每组撞墙钟上限的步、以轮数上限收尾的步、结果行 hitStepBudget 为真的步（参照）、
    作废重做次数（尝试目录数减去留下结果行的那一次）、最终缺失的步（该有却没有结果行，或有行而没判分）。"""
    rows = _two_group_rows(df)
    tasks = [t for t in primary["allTasks"] if t not in set(primary["fEmptyTasks"]) | set(primary["baselineUnavailableTasks"])]
    passes = expected_passes(df)

    def step(x: pd.DataFrame, col: str) -> list[dict[str, int]]:
        x = x[x[col].eq(1)] if col in x.columns else x.iloc[0:0]
        return [{"task": int(t), "pass": int(p)} for t, p in zip(x["task"], x["pass_no"])]

    out: dict[str, Any] = {}
    for g in GROUPS:
        gr = rows[rows["cell"] == g]
        have = {(int(t), int(p)) for t, p in zip(gr["task"], gr["pass_no"])}
        voids: int | None = 0
        void_steps: list[dict[str, int]] = []
        for p in passes:
            tr = info["tries"].get(f"{g}-{p}")
            if tr is None:
                voids = None
                continue
            for seq, n in sorted(tr.items()):
                extra = n - (1 if (seq, p) in have else 0)
                if extra > 0:
                    void_steps.append({"task": seq, "pass": p, "voided": extra})
                    if voids is not None:
                        voids += extra
        missing = [{"task": t, "pass": p, "reason": "no-row"} for t in tasks for p in passes if (t, p) not in have]
        missing += [{**x, "reason": "not-judged"} for x in step(gr, "not_judged")]
        out[g] = {
            "steps": int(len(gr)),
            "wallCapSteps": step(gr, "wall_cap_hit"),
            "turnLimitSteps": step(gr, "turn_limit"),
            "flaggedSteps": step(gr, "hit_step_budget"),
            "voids": voids,
            "voidSteps": void_steps,
            "missingSteps": sorted(missing, key=lambda x: (x["task"], x["pass"])),
        }
    return out


def mechanisms(df: pd.DataFrame, info: dict[str, Any]) -> dict[str, Any]:
    """Pigeon 组的机制使用（只描述）：每步计数的合计、每步平均与有记录的步数；角色与收尾状态按作业合计。
    会话根不在的作业记为未记录。"""
    g = df[df["cell"] == GROUP_P]
    jobs = info["mechanismJobs"]
    available = bool(jobs) and all(j.get("available") for j in jobs)
    counts: dict[str, Any] = {}
    for col in MECHANISM_COLUMNS:
        v = g[col].dropna() if col in g.columns else pd.Series(dtype=float)
        counts[col] = ({"total": float(v.sum()), "meanPerStep": float(v.mean()), "steps": int(v.size)}
                       if not v.empty else None)
    roles: dict[str, int] = {}
    settled: dict[str, int] = {}
    for j in jobs:
        for k, v in (j.get("roles") or {}).items():
            roles[k] = roles.get(k, 0) + int(v)
        for k, v in (j.get("settled") or {}).items():
            settled[k] = settled.get(k, 0) + int(v)
    return {"available": available, "counts": counts, "roles": roles, "settled": settled,
            "worktreesOnDisk": sum(int(j.get("worktreesOnDisk") or 0) for j in jobs), "exploratory": True}


def comparative_secondary(df: pd.DataFrame, primary: dict[str, Any], info: dict[str, Any],
                          flips: int = K.PERMUTATIONS, boots: int = K.BOOTSTRAPS) -> dict[str, Any]:
    """次要判据（第 3 节，一律探索性）。主判据不用的那个质量指标降在这里照报（404①）：
    主判据为部分得分时报做成与否，主判据为做成与否时报部分得分。"""
    tasks = primary["validTasks"]
    rows = _two_group_rows(df)
    in_valid = rows[rows["task"].isin(tasks)]
    keep: dict[str, Any] = {}
    for g in GROUPS:
        x = rows[(rows["cell"] == g) & rows["p_failed"].notna()]
        keep[g] = {"steps": int(len(x)), "total": float(x["p_failed"].sum()),
                   "meanPerStep": float(x["p_failed"].mean()) if len(x) else None,
                   "stepsWithFailures": int((x["p_failed"] > 0).sum())}
    rate: dict[str, float | None] = {}
    for g in GROUPS:
        v = in_valid[in_valid["cell"] == g]["solved"].dropna()
        rate[g] = float(v.mean()) if not v.empty else None
    # 降为次要判据的质量指标：与主判据相对的那个（404①）
    quality_key, quality_metric = ("solved", "solved") if primary["metric"] == "score" else ("partialScore", "score")
    quality_rate = rate if quality_metric == "solved" else {
        g: (float(v.mean()) if not (v := in_valid[in_valid["cell"] == g]["score"].dropna()).empty else None) for g in GROUPS}
    return {
        quality_key: {"rateByGroup": quality_rate, **_paired(df, quality_metric, tasks, flips, boots), "exploratory": True},
        "keepFailures": {"byGroup": keep, **_paired(df, "p_failed", tasks, flips, boots), "exploratory": True},
        "learning": {**learning(primary, boots), "exploratory": True},
        "efficiency": {
            "byGroup": {m: _distribution(rows, m) for m in EFFICIENCY_METRICS},
            "pairedMedian": {m: _paired_median(df, m, tasks) for m in EFFICIENCY_METRICS},
            "totals": {g: {m: float(rows[rows["cell"] == g][m].sum()) for m in ("cost_offpeak", "cost")} for g in GROUPS},
            "exploratory": True,
        },
        "capsAndVoids": caps_and_voids(df, primary, info),
        "mechanisms": mechanisms(df, info),
    }
