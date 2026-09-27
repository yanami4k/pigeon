"""读入层：把跑批器的结果文件（results.jsonl，每行一格、一题、一遍的一步）转成规整表。

跑批器二（两类用例、部分得分与校准能力）交付前，新字段按其字段设计先取名，标"待对齐"；
交付后只改本文件的映射表。撕裂的末行与空行丢弃，与跑批器自己的读法一致。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

from .table import make_table

# 跑批器的条件名 → 格子
CONDITION_TO_CELL = {
    "neither": "00",
    "search-only": "01",
    "push-only": "10",
    "search-push": "11",
    "minimal": "M",
}

# 规整表列 → 结果行字段（点号表示嵌套）
FIELD_MAP: dict[str, str] = {
    "task": "seq",
    "pass_no": "attempt",
    "f_passed": "targetPassed",
    "f_total": "targetTotal",
    "score": "targetScore",
    "solved": "solved",
    "p_failed": "keepFailed",
    "p_total": "keepTotal",
    "flaky_excluded": "flakyExcluded",
    "turns": "turns",
    "wall_ms": "agentWallMs",
    "cost": "stepCost",
    "review_cost": "reviewCost",
    "cost_offpeak": "stepCostOffPeak",
    "review_cost_offpeak": "reviewCostOffPeak",
    "review_turns": "reviewTurns",
    "review_wall_ms": "reviewWallMs",
    "peak_input": "peakInputTokens",
    "memory_bytes": "memoryBytes",
    "memory_chars": "memoryChars",
    "memory_entries": "memoryEntries",
    "input_miss": "usage.input",
    "input_hit": "usage.cacheRead",
    "output_tokens": "usage.output",
    "hit_step_budget": "hitStepBudget",
    "hit_review_budget": "hitReviewBudget",
}

# 以下结果行字段在跑批器二交付前按其字段设计暂定，交付后逐个对齐（审计列出）
PENDING_FIELDS = (
    "targetPassed",
    "targetTotal",
    "targetScore",
    "solved",
    "keepFailed",
    "keepTotal",
    "flakyExcluded",
    "agentWallMs",
    "stepCost",
    "reviewCost",
    "stepCostOffPeak",
    "reviewCostOffPeak",
    "reviewTurns",
    "reviewWallMs",
    "peakInputTokens",
    "memoryBytes",
    "memoryChars",
    "memoryEntries",
    "hitStepBudget",
    "hitReviewBudget",
    "memoryUsage",
    "searchUsage",
)

# 记忆使用的计数（推送记忆实现后才有）：对象里的每个数值字段展开为 mem_<键> / search_<键>
USAGE_OBJECTS = {"memoryUsage": "mem_", "searchUsage": "search_"}


def _get(row: dict[str, Any], path: str) -> Any:
    cur: Any = row
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _num(x: Any) -> Any:
    if isinstance(x, bool):
        return 1.0 if x else 0.0
    return x


def read_jsonl(paths: Iterable[str | Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for p in paths:
        for raw in Path(p).read_text(encoding="utf-8").split("\n"):
            if not raw.strip():
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue  # 撕裂的行
            if isinstance(obj, dict):
                rows.append(obj)
    return rows


def row_to_record(row: dict[str, Any]) -> dict[str, Any] | None:
    """一条结果行 → 规整表的一条记录；不是题的步、条件不认识或缺题号 / 遍次的返回 None。"""
    if row.get("kind", "task") != "task":
        return None
    cell = CONDITION_TO_CELL.get(row.get("condition"))
    if cell is None:
        return None
    rec: dict[str, Any] = {"cell": cell}
    for col, path in FIELD_MAP.items():
        rec[col] = _num(_get(row, path))
    if rec["task"] is None or rec["pass_no"] is None:
        return None
    for obj_name, prefix in USAGE_OBJECTS.items():
        obj = row.get(obj_name)
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, (int, float, bool)):
                    rec[prefix + k] = _num(v)
    return rec


def load_table(paths: Iterable[str | Path]) -> tuple[pd.DataFrame, dict[str, Any]]:
    """读若干结果文件（多遍、多格可分在不同输出目录）合成一张规整表；同一格、题、遍取文件中最后出现的一行。"""
    rows = read_jsonl(paths)
    records = [r for r in (row_to_record(x) for x in rows) if r is not None]
    present = {f for f in PENDING_FIELDS if any(_get(x, f) is not None for x in rows)}
    info = {
        "rows": len(rows),
        "records": len(records),
        "pendingFieldsPresent": sorted(present),
        "pendingFieldsAbsent": sorted(set(PENDING_FIELDS) - present),
    }
    return make_table(records), info
