"""读入层：把跑批器的结果文件（results.jsonl，每行一格、一题、一遍的一步）转成规整表。

字段名以跑批器二（runner-r3 0f463bb）的结果行字段表为准；跑批器字段再有变动只改本文件的映射表。
撕裂的末行与空行丢弃，与跑批器自己的读法一致。没判的步 judging 为 null，读出来得分为空、按缺失处理。
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
    "f_passed": "judging.failToPass.passed",
    "f_total": "judging.failToPass.total",
    "score": "judging.score",
    "solved": "judging.solved",
    "p_failed": "judging.passToPass.failed",
    "p_total": "judging.passToPass.total",
    "flaky_excluded": "judging.excludedFlaky",
    "turns": "turns",
    "wall_ms": "agentWallMs",
    "cost": "gateway.costCny",
    "review_cost": "gateway.reviewCostCny",
    "review_turns": "review.turns",
    "review_wall_ms": "review.wallMs",
    "peak_input": "gateway.peakInputTokens",
    "memory_bytes": "memoryAtStart.bytes",
    # 223 的上限按条目部分的字符数（Unicode 码点，文件头不计）
    "memory_chars": "memoryAtStart.entryChars",
    "memory_chars_after": "memoryAtEnd.entryChars",
    "memory_entries": "memoryAtStart.entries",
    "input_miss": "usage.input",
    "input_hit": "usage.cacheRead",
    "output_tokens": "usage.output",
    "hit_step_budget": "hitStepBudget",
    "hit_review_budget": "hitReviewBudget",
    "baseline_unavailable": "baselineUnavailable",
}

# 报告里列出结果行中缺失（整列都为空）的字段，便于发现没接上的计量：网关计价、复盘接入之前这些字段为 null
TRACKED_FIELDS = tuple(p for col, p in FIELD_MAP.items() if col not in ("task", "pass_no")) + (
    "memoryUsage",
    "searchUsage",
)

# 暂定名、待跑批器二随后的提交确认：无法建立基线的标记；记忆使用与检索的计数（推送记忆与复盘接入后才有）
PENDING_FIELDS = ("baselineUnavailable", "memoryUsage", "searchUsage")

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
    present = {f for f in TRACKED_FIELDS if any(_get(x, f) is not None for x in rows)}
    info = {
        "rows": len(rows),
        "records": len(records),
        "fieldsAbsent": sorted(set(TRACKED_FIELDS) - present),
        "pendingFieldsPresent": sorted(set(PENDING_FIELDS) & present),
    }
    return make_table(records), info


def read_baseline_failures(summary_path: str | Path, all_tasks: list[int]) -> list[int]:
    """两类用例预计算汇总（classes-summary.json）里出错、无法建立基线的题 → 规整表的题号（步序）。
    汇总里的 task 是题在流中按时间的序号（从 1 起），按全部题号（步序，按时间排序）的位置换算。"""
    data = json.loads(Path(summary_path).read_text(encoding="utf-8"))
    order = sorted(all_tasks)
    out = []
    for item in data.get("failed", []):
        n = int(item["task"])
        if not 1 <= n <= len(order):
            raise ValueError(f"classes-summary 里的题号 {n} 超出全部题 {len(order)} 道")
        out.append(order[n - 1])
    return sorted(set(out))
