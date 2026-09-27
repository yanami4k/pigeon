"""主判据（分析计划第 1 节；决策 199、201、222）。

每格每题先把多遍合起来取平均，再按题配对算推送差与检索差，四格共同估计；
以按题配对的符号翻转置换检验为主检验，Holm 两步控制总误报率，按题自助法给置信区间；
按题与按流的随机效应混合模型作稳健性对照。
"""

from __future__ import annotations

import math
import warnings
from typing import Any, Iterable

import numpy as np
import pandas as pd

from . import constants as K
from .stats import above, at_least, bootstrap_ci, holm_two_step, paired_dz, sign_flip_pvalue

EFFECTS = ("push", "search")


def four_cell_rows(df: pd.DataFrame) -> pd.DataFrame:
    return df[df["cell"].isin(K.CELLS)]


def f_empty_tasks(df: pd.DataFrame) -> list[int]:
    """要做到的用例为空的题（1.1）：照常跑、不进主判据分母。任一行 f_total 为 0 即算。"""
    rows = df[df["f_total"].eq(0)]
    return sorted(int(t) for t in rows["task"].unique())


def cell_task_means(df: pd.DataFrame, metric: str, cells: Iterable[str] = K.CELLS) -> pd.DataFrame:
    """ȳ(c, i)：该格该题已跑各遍的等权平均；某遍缺失即按其余遍的平均计（1.4）。
    返回按题为行、按格为列的表，一遍有效结果都没有的格为 NaN。"""
    cells = list(cells)
    sub = df[df["cell"].isin(cells)]
    means = sub.groupby(["task", "cell"])[metric].mean().unstack("cell")
    return means.reindex(columns=cells)


def paired_differences(means: pd.DataFrame) -> pd.DataFrame:
    """按题的推送差、检索差与交互（1.3）。"""
    y00, y01, y10, y11 = (means[c] for c in K.CELLS)
    return pd.DataFrame(
        {
            "push": (y10 + y11) / 2 - (y00 + y01) / 2,
            "search": (y01 + y11) / 2 - (y00 + y10) / 2,
            "interaction": (y11 - y10) - (y01 - y00),
        }
    )


def select_tasks(df: pd.DataFrame, expected_tasks: Iterable[int] | None = None) -> dict[str, Any]:
    """有效题：F 不为空、四格在该题上各至少一遍有效结果（1.4）。
    expected_tasks 给出时，完全没有结果行的题也列为缺失（F 未知）。"""
    rows = four_cell_rows(df)
    seen = set(int(t) for t in rows["task"].unique())
    all_tasks = sorted(seen | set(int(t) for t in (expected_tasks or ())))
    empty = set(f_empty_tasks(rows))
    means = cell_task_means(rows, "score")
    valid: list[int] = []
    missing: list[dict[str, Any]] = []
    for t in all_tasks:
        if t in empty:
            continue
        if t not in means.index:
            missing.append({"task": t, "cellsWithoutResult": list(K.CELLS), "reason": "no-rows"})
            continue
        lacking = [c for c in K.CELLS if math.isnan(means.at[t, c])]
        if lacking:
            missing.append({"task": t, "cellsWithoutResult": lacking, "reason": "cell-missing"})
        else:
            valid.append(t)
    return {
        "allTasks": all_tasks,
        "fEmptyTasks": sorted(empty),
        "validTasks": valid,
        "missingTasks": missing,
    }


def effect_summary(
    d: np.ndarray,
    flips: int = K.PERMUTATIONS,
    boots: int = K.BOOTSTRAPS,
) -> dict[str, Any]:
    n = int(d.size)
    est = float(d.mean()) if n else None
    ci = bootstrap_ci(d, resamples=boots)
    sd = float(d.std(ddof=1)) if n >= 2 else None
    return {
        "n": n,
        "estimate": est,
        "ci": list(ci) if ci else None,
        "p": sign_flip_pvalue(d, flips=flips),
        "dz": paired_dz(d),
        "sd": sd,
        # 正式报告里的最小可分辨效果：用正式跑自己的数据重算，不再乘 k（3.7 末段）
        "mdeFormal": (K.MDE_Z_SUM * sd / math.sqrt(n)) if (sd is not None and n) else None,
    }


def per_cell_pass_scores(df: pd.DataFrame, valid_or_nonempty: Iterable[int]) -> dict[str, dict[str, float]]:
    """S(c, r)：该格该遍所有有效步得分的等权平均，只作描述（1.2）。"""
    keep = set(valid_or_nonempty)
    out: dict[str, dict[str, float]] = {}
    sub = df[df["task"].isin(keep) & df["score"].notna()]
    for (cell, pass_no), g in sub.groupby(["cell", "pass_no"]):
        out.setdefault(str(cell), {})[str(int(pass_no))] = float(g["score"].mean())
    return out


def mixed_model(df: pd.DataFrame, valid_tasks: list[int]) -> dict[str, Any]:
    """稳健性对照（1.5 乙、222）：y ~ 推 + 拉 + 推×拉 + (1|题) + (1|流)，流 = 格 × 遍。
    推、拉按 ±0.5 编码，系数即另一因素两水平上的平均效应，与 DP、DS 同义。"""
    import statsmodels.api as sm

    sub = four_cell_rows(df)
    sub = sub[sub["task"].isin(valid_tasks) & sub["score"].notna()].copy()
    if sub.empty or len(valid_tasks) < 2:
        return {"error": "not-enough-data"}
    sub["push"] = sub["cell"].str[0].astype(int) - 0.5
    sub["search"] = sub["cell"].str[1].astype(int) - 0.5
    sub["stream"] = sub["cell"] + "-" + sub["pass_no"].astype(str)
    sub["group"] = 1
    caught: list[str] = []
    try:
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            model = sm.MixedLM.from_formula(
                "score ~ push * search",
                groups="group",
                re_formula="0",
                vc_formula={"task": "0 + C(task)", "stream": "0 + C(stream)"},
                data=sub,
            )
            fit = model.fit(reml=True)
            caught = sorted({type(x.message).__name__ + ": " + str(x.message).splitlines()[0] for x in w})
    except Exception as e:  # 拟合失败照实报告，不影响主检验
        return {"error": f"{type(e).__name__}: {e}"}
    coef = {k: float(fit.params[k]) for k in ("push", "search", "push:search")}
    pvals = {k: float(fit.pvalues[k]) for k in ("push", "search", "push:search")}
    holm = holm_two_step((pvals["push"], pvals["search"]))
    return {
        "coef": coef,
        "p": pvals,
        "holmSignificant": {"push": holm.significant[0], "search": holm.significant[1]},
        "converged": bool(fit.converged),
        "varianceComponents": {name: float(v) for name, v in zip(model.exog_vc.names, fit.vcomp)},
        "residualVariance": float(fit.scale),
        "warnings": caught,
    }


def sensitivity(effects: dict[str, dict[str, Any]], mixed: dict[str, Any]) -> dict[str, Any]:
    """两者方向或显著性不一致时写明结论对建模方式敏感（222）。混合模型没拟合出来时无法比较，记 None。"""
    if "error" in mixed:
        return {"sensitive": None, "byEffect": {}}
    by: dict[str, bool] = {}
    for name in EFFECTS:
        est = effects[name]["estimate"]
        coef = mixed["coef"][name]
        same_dir = np.sign(est) == np.sign(coef)
        same_sig = effects[name]["holmSignificant"] == mixed["holmSignificant"][name]
        by[name] = not (same_dir and same_sig)
    return {"sensitive": any(by.values()), "byEffect": by}


def analyze_primary(
    df: pd.DataFrame,
    expected_tasks: Iterable[int] | None = None,
    flips: int = K.PERMUTATIONS,
    boots: int = K.BOOTSTRAPS,
    with_mixed: bool = True,
) -> dict[str, Any]:
    sel = select_tasks(df, expected_tasks)
    valid = sel["validTasks"]
    rows = four_cell_rows(df)
    means = cell_task_means(rows, "score").reindex(valid)
    diffs = paired_differences(means)
    effects = {name: effect_summary(diffs[name].to_numpy(), flips, boots) for name in EFFECTS}
    holm = holm_two_step((effects["push"]["p"], effects["search"]["p"]))
    for k, name in enumerate(EFFECTS):
        effects[name]["holmSignificant"] = holm.significant[k]
        effects[name]["holmThreshold"] = holm.thresholds[k]
    inter = diffs["interaction"].to_numpy()
    interaction = {
        "estimate": float(inter.mean()) if inter.size else None,
        "ci": (lambda c: list(c) if c else None)(bootstrap_ci(inter, resamples=boots)),
        "exploratory": True,
    }
    n_valid = len(valid)
    n_missing = len(sel["missingTasks"])
    missing_ratio = (n_missing / n_valid) if n_valid else (math.inf if n_missing else 0.0)
    base00 = float(means["00"].mean()) if n_valid else None
    no_push = float(((means["00"] + means["01"]) / 2).mean()) if n_valid else None
    passes = {c: int(rows[rows["cell"] == c]["pass_no"].nunique()) for c in K.CELLS}
    result: dict[str, Any] = {
        **sel,
        "nValid": n_valid,
        "missingRatio": missing_ratio if math.isfinite(missing_ratio) else None,
        "exploratory": above(missing_ratio, K.MISSING_EXPLORATORY_RATIO),
        "passesPerCell": passes,
        "cellPassScores": per_cell_pass_scores(rows, valid),
        "cellMeans": {c: (float(means[c].mean()) if n_valid else None) for c in K.CELLS},
        "effects": effects,
        "interaction": interaction,
        "baseline": {
            "mean00": base00,
            "noPushMean": no_push,
            "ceiling": (no_push is not None and at_least(no_push, K.CEILING_SCORE)),
            # 以 00 格平均得分为底的相对变化
            "pushRelativeTo00": (effects["push"]["estimate"] / base00) if base00 else None,
            "searchRelativeTo00": (effects["search"]["estimate"] / base00) if base00 else None,
        },
        "perTask": {
            "tasks": valid,
            "push": diffs["push"].tolist(),
            "search": diffs["search"].tolist(),
            "interaction": diffs["interaction"].tolist(),
        },
    }
    if with_mixed:
        mixed = mixed_model(df, valid)
        result["mixedModel"] = mixed
        result["sensitivity"] = sensitivity(effects, mixed)
    return result
