"""规整表：计算核心的唯一输入，与结果文件格式无关。

每行是一格、一题、一遍的一步结果。缺行即缺失（基础设施故障重做到上限仍失败的步不留行）。
列：
- cell：00 / 01 / 10 / 11 / M
- task：题号（按时间顺序可比较的整数，跑批器里是步序 seq）
- pass_no：遍次，从 1 起
- f_total、f_passed：要做到的用例总数与在 agent 代码上通过的条数（1.1）
- score：f_passed / f_total；f_total 为 0 时为 NaN（不进主判据分母）
- solved：做成与否（F 全过且 P 无一失败），1 / 0
- p_failed、p_total：不许挂的用例中失败的条数与总数
- flaky_excluded：因时过时不过排除的用例数
- turns、wall_ms：每步轮数与墙钟（含验证门与回炉）
- cost、review_cost：每步花费与复盘花费（元）
- review_turns、review_wall_ms：复盘的轮数与墙钟
- input_miss、input_hit、output_tokens：输入 token（未命中 / 命中）与输出 token
- peak_input：每步单次请求输入 token 的峰值
- memory_chars、memory_bytes、memory_entries：每步开工时 MEMORY.md 的字符数、字节数与条目数
- hit_step_budget、hit_review_budget：是否撞了每步 / 复盘的上限（1 / 0，未知为 NaN）
- 其余以 mem_ 或 search_ 开头的列为记忆使用的计数，原样汇总
"""

from __future__ import annotations

from typing import Any, Iterable

import numpy as np
import pandas as pd

NUMERIC_COLUMNS = (
    "f_total",
    "f_passed",
    "score",
    "solved",
    "p_failed",
    "p_total",
    "flaky_excluded",
    "turns",
    "wall_ms",
    "cost",
    "review_cost",
    "review_turns",
    "review_wall_ms",
    "input_miss",
    "input_hit",
    "output_tokens",
    "peak_input",
    "memory_chars",
    "memory_bytes",
    "memory_entries",
    "hit_step_budget",
    "hit_review_budget",
)

KEY_COLUMNS = ("cell", "task", "pass_no")


def make_table(records: Iterable[dict[str, Any]]) -> pd.DataFrame:
    """由记录列表建规整表：补齐缺的数值列为 NaN，按 f 计数补算 score；
    同一格、题、遍重复出现时取最后一条（重做以最后结果为准，1.1）。"""
    df = pd.DataFrame(list(records))
    if df.empty:
        df = pd.DataFrame(columns=list(KEY_COLUMNS))
    for col in NUMERIC_COLUMNS:
        if col not in df.columns:
            df[col] = np.nan
    for col in df.columns:
        if col in KEY_COLUMNS:
            continue
        df[col] = pd.to_numeric(df[col], errors="coerce").astype(float)
    df["cell"] = df["cell"].astype(str)
    df["task"] = df["task"].astype(int)
    df["pass_no"] = df["pass_no"].astype(int)
    # score 未给时由计数补算；F 为空的步一律记 NaN
    need = df["score"].isna() & df["f_total"].gt(0)
    df.loc[need, "score"] = df.loc[need, "f_passed"] / df.loc[need, "f_total"]
    df.loc[df["f_total"].eq(0), "score"] = np.nan
    df = df.drop_duplicates(subset=list(KEY_COLUMNS), keep="last")
    return df.sort_values(list(KEY_COLUMNS), kind="mergesort").reset_index(drop=True)


def extra_usage_columns(df: pd.DataFrame) -> list[str]:
    return sorted(c for c in df.columns if c.startswith("mem_") or c.startswith("search_"))
