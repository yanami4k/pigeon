"""模拟数据：人为造出已知效果与已知波动的四格数据。

y(c, i, r) = base + a_i + (push + b_i)·p_c + search·s_c + ε，p_c、s_c 取 ±0.5；
a_i 为题目难度，b_i 为推送效果因题而异的部分（方差 τ²），ε 为重跑噪声（方差 v）。
于是 dP(i) = push + b_i + 噪声，单遍时噪声方差为 v，R 遍平均后为 v / R，与分析计划 3.7 的模型一致。
"""

from __future__ import annotations

import math

import numpy as np

from pigeon_analysis.constants import CELLS
from pigeon_analysis.table import make_table


def simulate(
    n_tasks: int = 89,
    passes: int = 2,
    push: float = 0.0,
    search: float = 0.0,
    v: float = 0.02,
    tau2: float = 0.0,
    task_sd: float = 0.15,
    base: float = 0.5,
    seed: int = 0,
    discrete: int | None = None,
    minimal: bool = False,
):
    """discrete 给出时把得分换成 discrete 条用例里通过的比例（有界、离散），检验对分布形状不敏感。"""
    rng = np.random.default_rng(seed)
    a = rng.normal(0, task_sd, n_tasks)
    b = rng.normal(0, math.sqrt(tau2), n_tasks) if tau2 > 0 else np.zeros(n_tasks)
    records = []
    for i in range(n_tasks):
        for c in CELLS:
            pc = int(c[0]) - 0.5
            sc = int(c[1]) - 0.5
            mean = base + a[i] + (push + b[i]) * pc + search * sc
            for r in range(1, passes + 1):
                y = mean + rng.normal(0, math.sqrt(v))
                rec = {"cell": c, "task": i + 1, "pass_no": r}
                if discrete:
                    prob = min(1.0, max(0.0, y))
                    k = int(rng.binomial(discrete, prob))
                    rec.update(f_total=discrete, f_passed=k)
                else:
                    rec.update(f_total=10, score=y)
                records.append(rec)
        if minimal:
            records.append({"cell": "M", "task": i + 1, "pass_no": 1, "f_total": 10,
                            "score": base + a[i] - 0.1 + rng.normal(0, math.sqrt(v))})
    return make_table(records)


def rec(cell, task, pass_no, score=None, f_total=10, **kw):
    """手工造一条记录：score 给比例时按 f_total 换算通过数。"""
    out = {"cell": cell, "task": task, "pass_no": pass_no, "f_total": f_total}
    if score is not None:
        out["f_passed"] = score * f_total
    out.update(kw)
    return out


def grid(scores: dict, tasks=(1, 2, 3), passes=(1,), **kw):
    """四格常数得分的网格：scores = {cell: 得分 或 函数(task, pass)}。"""
    out = []
    for t in tasks:
        for c, s in scores.items():
            for r in passes:
                val = s(t, r) if callable(s) else s
                out.append(rec(c, t, r, val, **kw))
    return out
