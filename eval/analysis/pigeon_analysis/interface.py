"""接口不可猜的敏感性分析（决策 316，分析计划 2026-09-30 第二条修订）。

主判据不动。另把清单（data/unguessable-interfaces.json，静态规则在看到正式结果之前算出）里被判接口不可猜的测试文件中的
要做到用例剔除，逐行重算：要做到的总数减去剔除数，通过数减去剔除用例中通过的条数；剔除后无剩余用例的题即成为要做到的为零的
题，不进该分析。然后以与主判据相同的检验、置信区间与 Holm 校正（analyze_primary）再算推送效果与检索效果。

剔除用例在某一行是否通过，按以下来源确定：
- 按保存的改动重判、与原结果行逐项一致的逐用例结果（有则优先）；
- 否则取结果行里的失败用例列表：列表齐全即可确定；列表被截断时（跑批器只记按编号排序的前 20 条），编号不大于列表最后一条的
  剔除用例可确定，有编号更大的即无法确定。
无法确定的行不猜，从该分析的表里去掉（该格该题按其余遍的平均计，没有其余遍即为缺失题），并在报告里列出。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

from .primary import EFFECTS, analyze_primary
from .wording import classify

Key = tuple[str, int, int]


def read_unguessable(path: str | Path) -> dict[str, Any]:
    """读接口不可猜清单：按题（步序）的剔除用例编号与剩余用例数，以及清单的汇总。"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    excluded: dict[int, set[str]] = {}
    remaining: dict[int, int] = {}
    for t in data["tasks"]:
        seq = int(t["seq"])
        remaining[seq] = int(t["remaining"])
        ids = {c for f in t["files"] for c in f["caseIds"]}
        if ids:
            excluded[seq] = ids
    return {"excluded": excluded, "remaining": remaining, "summary": data["summary"]}


def excluded_failed(
    excluded: set[str], key: Key, failed_lists: dict[Key, dict[str, Any]], rejudged: dict[Key, list[str]]
) -> int | None:
    """这一行剔除用例中失败的条数；无法确定为 None。"""
    if key in rejudged:
        return len(excluded & set(rejudged[key]))
    info = failed_lists.get(key)
    if info is None:
        return None
    failed = info["failed"]
    if info["complete"]:
        return len(excluded & set(failed))
    if not failed or any(c > failed[-1] for c in excluded):
        return None
    return len(excluded & set(failed))


def adjusted_table(
    df: pd.DataFrame,
    excluded: dict[int, set[str]],
    failed_lists: dict[Key, dict[str, Any]],
    rejudged: dict[Key, list[str]] | None = None,
) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    """逐行剔除后重算 f_total、f_passed 与 score；返回新表与无法确定、被去掉的行。没判分的行（f_total 为空）原样保留。"""
    rejudged = rejudged or {}
    out = df.copy()
    drop: list[int] = []
    undetermined: list[dict[str, Any]] = []
    for idx, row in out.iterrows():
        ex = excluded.get(int(row["task"]))
        if not ex or pd.isna(row["f_total"]):
            continue
        key = (str(row["cell"]), int(row["task"]), int(row["pass_no"]))
        total = float(row["f_total"]) - len(ex)
        if total <= 0:
            # 剔除后无剩余用例：不必知道剔除用例的结果，记为要做到的为零（不进该分析）
            out.at[idx, "f_total"] = 0.0
            out.at[idx, "f_passed"] = 0.0
            out.at[idx, "score"] = np.nan
            continue
        n_failed = excluded_failed(ex, key, failed_lists, rejudged)
        if n_failed is None:
            drop.append(idx)
            undetermined.append({"cell": key[0], "task": key[1], "pass_no": key[2]})
            continue
        passed = float(row["f_passed"]) - (len(ex) - n_failed)
        out.at[idx, "f_total"] = total
        out.at[idx, "f_passed"] = passed
        out.at[idx, "score"] = passed / total
    out = out.drop(index=drop).reset_index(drop=True)
    return out, undetermined


def agreement(primary: dict[str, Any], sensitivity: dict[str, Any]) -> dict[str, Any]:
    """两者结论是否一致：各效应的结论类别（测出变好、测出变差、未测出）相同即一致。"""
    by: dict[str, dict[str, Any]] = {}
    for name in EFFECTS:
        a, b = primary["effects"][name], sensitivity["effects"][name]
        ka = classify(a) if a["estimate"] is not None else "no-data"
        kb = classify(b) if b["estimate"] is not None else "no-data"
        by[name] = {"primary": ka, "sensitivity": kb, "consistent": ka == kb}
    return {"consistent": all(x["consistent"] for x in by.values()), "byEffect": by}


def analyze_interface_sensitivity(
    df: pd.DataFrame,
    unguessable: dict[str, Any],
    failed_lists: dict[Key, dict[str, Any]],
    primary: dict[str, Any],
    rejudged: dict[Key, list[str]] | None = None,
    rejudge_inconsistent: Iterable[dict[str, Any]] = (),
    expected_tasks: Iterable[int] | None = None,
    baseline_unavailable: Iterable[int] | None = None,
    **kw: Any,
) -> dict[str, Any]:
    adj, undetermined = adjusted_table(df, unguessable["excluded"], failed_lists, rejudged)
    sens = analyze_primary(adj, expected_tasks=expected_tasks, baseline_unavailable=baseline_unavailable,
                           with_mixed=False, **kw)
    no_remaining = sorted(t for t, n in unguessable["remaining"].items() if n == 0)
    return {
        "list": unguessable["summary"],
        "noRemainingTasks": no_remaining,
        "undeterminedRows": undetermined,
        "rejudgedRows": len(rejudged or {}),
        "rejudgeInconsistent": list(rejudge_inconsistent),
        "primary": sens,
        "agreement": agreement(primary, sens),
    }
