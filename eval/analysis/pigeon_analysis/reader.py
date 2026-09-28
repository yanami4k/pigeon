"""读入层：把跑批器的输出目录（results.jsonl、identity.json 与各作业的会话文件）转成规整表与设置。

字段名以合并推送记忆与每日沙箱之后 formal-v2 上的 src/eval/stream-results.ts 与 stream-identity.ts 为准；
跑批器字段再有变动只改本文件的映射表。撕裂的末行与空行丢弃，与跑批器自己的读法一致。
结果行与身份头缺了该有的字段即报错，说清是哪个文件、哪一行、哪一项，不静默补默认值；字段在而值为 null
（没判的步、不推送的条件没有复盘、没跑 agent 等）照常读成空。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

from .sessions import load_session_metrics
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
    "input_miss": "usage.input",
    "input_hit": "usage.cacheRead",
    "output_tokens": "usage.output",
    # 干活部分的花费，已减去复盘；复盘花费单列
    "cost": "gateway.costCny",
    "review_cost": "gateway.reviewCostCny",
    "peak_input": "gateway.peakInputTokens",
    "review_closing": "review.closing",
    "review_pre_compaction": "review.preCompaction",
    "review_turns": "review.turns",
    "review_tokens": "review.tokens",
    "review_wall_ms": "review.wallMs",
    "memory_bytes": "memoryAtStart.bytes",
    # 223 的上限按条目部分的字符数（Unicode 码点，文件头不计）
    "memory_chars": "memoryAtStart.entryChars",
    "memory_entries": "memoryAtStart.entries",
    # 步末：agent 与收尾复盘都结束之后；最后一步的即一遍结束时的记忆
    "memory_chars_after": "memoryAtEnd.entryChars",
    "memory_entries_after": "memoryAtEnd.entries",
    "hit_step_budget": "hitStepBudget",
    "hit_review_budget": "hitReviewBudget",
    "verify_tool_faults": "verifyToolFaults",
    "baseline_unavailable": "baselineUnavailable",
}

# 每条题步结果行必须带的顶层字段（值可以为 null）
REQUIRED_TOP = (
    "condition",
    "attempt",
    "seq",
    "kind",
    "judging",
    "baselineUnavailable",
    "turns",
    "usage",
    "agentWallMs",
    "memoryAtStart",
    "memoryAtEnd",
    "hitStepBudget",
    "hitReviewBudget",
    "review",
    "gateway",
    "verifyToolFaults",
    "runIdentity",
)

# 父对象不为 null 时必须带的子字段
REQUIRED_NESTED = {
    "usage": ("input", "cacheRead", "output"),
    "judging": ("failToPass.passed", "failToPass.total", "score", "solved", "passToPass.failed", "passToPass.total",
                "excludedFlaky"),
    "gateway": ("costCny", "reviewCostCny", "peakInputTokens"),
    "review": ("closing", "preCompaction", "turns", "tokens", "wallMs", "hitLimit"),
    "memoryAtStart": ("bytes", "entries", "entryChars"),
    "memoryAtEnd": ("bytes", "entries", "entryChars"),
}

# 报告里列出结果行中整列为空的字段，便于发现没接上的计量
TRACKED_FIELDS = tuple(p for col, p in FIELD_MAP.items() if col not in ("task", "pass_no"))

_MISSING = object()


class ResultFieldError(ValueError):
    """结果行或身份头缺字段。"""


def _get(row: dict[str, Any], path: str, default: Any = None) -> Any:
    cur: Any = row
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def _num(x: Any) -> Any:
    if isinstance(x, bool):
        return 1.0 if x else 0.0
    return x


def read_jsonl(paths: Iterable[str | Path]) -> list[tuple[Path, int, dict[str, Any]]]:
    """逐行读结果文件，返回（文件、行号、行）；撕裂的行与空行丢弃。"""
    rows: list[tuple[Path, int, dict[str, Any]]] = []
    for p in paths:
        p = Path(p)
        for k, raw in enumerate(p.read_text(encoding="utf-8").split("\n"), start=1):
            if not raw.strip():
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue  # 撕裂的行
            if isinstance(obj, dict):
                rows.append((p, k, obj))
    return rows


def is_task_row(row: dict[str, Any]) -> bool:
    return row.get("kind") == "task" and row.get("condition") in CONDITION_TO_CELL


def missing_fields(row: dict[str, Any]) -> list[str]:
    """这一行缺的字段（按点号路径）。顶层字段必须在；父对象不为 null 时子字段必须在。"""
    out = [f for f in REQUIRED_TOP if f not in row]
    for parent, children in REQUIRED_NESTED.items():
        obj = row.get(parent)
        if obj is None:
            continue
        for child in children:
            if _get(obj, child, _MISSING) is _MISSING:
                out.append(f"{parent}.{child}")
    return out


def check_row(row: dict[str, Any], where: str) -> None:
    lacking = missing_fields(row)
    if lacking:
        raise ResultFieldError(
            f"结果行缺字段 {'、'.join(lacking)}（{where}：condition={row.get('condition')}，attempt={row.get('attempt')}，"
            f"seq={row.get('seq')}）"
        )


def row_to_record(row: dict[str, Any], where: str = "结果行") -> dict[str, Any] | None:
    """一条结果行 → 规整表的一条记录；不是题的步、条件不认识的返回 None。缺字段即报错。"""
    if row.get("kind") is not None and row.get("kind") != "task":
        return None
    if row.get("condition") not in CONDITION_TO_CELL:
        return None
    check_row(row, where)
    rec: dict[str, Any] = {"cell": CONDITION_TO_CELL[row["condition"]]}
    for col, path in FIELD_MAP.items():
        rec[col] = _num(_get(row, path))
    # baselineUnavailable 为 string | null：非空即为无法建立基线的原因文字，记 1；null 或空串记 0。不按布尔真假判断
    reason = row["baselineUnavailable"]
    rec["baseline_unavailable"] = 1.0 if (isinstance(reason, str) and reason.strip() != "") else 0.0
    return rec


# 身份头：core 必须带的字段
IDENTITY_REQUIRED = ("digest", "core.repo", "core.budget.maxTurns", "core.budget.wallClockMs", "core.promptFormat",
                     "core.promptLayout", "core.conditions", "core.taskSelection")
# 有 Pigeon 条件时 core.agents.pigeon 必须带的字段（推送记忆合并之后的身份头才有后几项）
PIGEON_REQUIRED = ("provider", "modelId", "temperature", "thinking", "maxOutputTokens",
                   "compaction.contextWindow", "compaction.reserveTokens", "compaction.keepRecentTokens",
                   "compaction.thresholdTokens", "memoryLimitChars", "reviewTemplate", "reviewBudget.maxTurns",
                   "reviewBudget.wallClockMs")


def read_identity(run_dir: Path, needs_pigeon: bool) -> dict[str, Any]:
    """读输出目录的 identity.json，取报告设置一节要的项：题面格式、每步上限、模型设定、压缩配置、记忆上限、
    复盘模板与复盘上限。缺文件或缺字段即报错。"""
    f = run_dir / "identity.json"
    try:
        ident = json.loads(f.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ResultFieldError(f"缺身份头 identity.json：{f.as_posix()}") from None
    lacking = [k for k in IDENTITY_REQUIRED if _get(ident, k, _MISSING) is _MISSING]
    pigeon = _get(ident, "core.agents.pigeon")
    if needs_pigeon:
        if not isinstance(pigeon, dict):
            lacking.append("core.agents.pigeon")
        else:
            lacking += [f"core.agents.pigeon.{k}" for k in PIGEON_REQUIRED if _get(pigeon, k, _MISSING) is _MISSING]
    if lacking:
        raise ResultFieldError(f"身份头缺字段 {'、'.join(lacking)}（{f.as_posix()}）")
    core = ident["core"]
    out: dict[str, Any] = {
        "digest": ident["digest"],
        "repo": core["repo"],
        "promptFormat": core["promptFormat"],
        "promptLayout": core["promptLayout"],
        "stepBudget": {"maxTurns": core["budget"]["maxTurns"], "wallClockMs": core["budget"]["wallClockMs"]},
        "conditions": list(core["conditions"]),
        "taskSelection": core["taskSelection"],
        "model": None,
        "compaction": None,
        "memoryLimitChars": None,
        "reviewTemplate": None,
        "reviewBudget": None,
        "minimal": _get(ident, "core.agents.minimal"),
    }
    if isinstance(pigeon, dict):
        out.update({
            "model": {k: pigeon.get(k) for k in ("provider", "modelId", "temperature", "thinking", "maxOutputTokens")},
            "compaction": pigeon.get("compaction"),
            "memoryLimitChars": pigeon.get("memoryLimitChars"),
            "reviewTemplate": pigeon.get("reviewTemplate"),
            "reviewBudget": pigeon.get("reviewBudget"),
        })
    return out


# 多个输出目录合在一起分析时必须相同的设置项
SHARED_SETTINGS = ("promptFormat", "promptLayout", "stepBudget", "model", "compaction", "memoryLimitChars",
                   "reviewTemplate", "reviewBudget")


# 只属于 Pigeon 的设置项：只跑最简 agent 的输出目录身份头里没有 Pigeon 代理，这几项读出为空，不参与比对
PIGEON_ONLY_SETTINGS = ("compaction", "memoryLimitChars", "reviewTemplate", "reviewBudget")


def minimal_model(minimal: Any) -> dict[str, Any] | None:
    """最简 agent 身份头里的模型设置 → 与 Pigeon 的 model 同口径（模型名、温度、思考开关、单次输出上限）；
    缺 modelKwargs（跑批器读不到最简 agent 的参数）返回 None。思考关在 litellm 参数里写作 {"type": "disabled"}，
    对应 Pigeon 的 "off"；其余取值原样保留，不一致即报错。"""
    if not isinstance(minimal, dict) or not isinstance(minimal.get("modelKwargs"), dict):
        return None
    kw = minimal["modelKwargs"]
    thinking = kw.get("thinking")
    if isinstance(thinking, dict) and thinking.get("type") == "disabled":
        thinking = "off"
    return {"modelId": minimal.get("model"), "temperature": kw.get("temperature"), "thinking": thinking,
            "maxOutputTokens": kw.get("max_tokens")}


def common_settings(settings: list[dict[str, Any]]) -> dict[str, Any] | None:
    """各输出目录的设置应一致（摘要可以不同）；不一致即报错并列出不同的项。
    只跑最简 agent 的目录（身份头里没有 Pigeon 代理）跳过只属于 Pigeon 的几项，模型设置改为核对最简 agent 记录的
    模型名、温度、思考开关、单次输出上限与 Pigeon 的一致。返回有 Pigeon 代理的目录的设置（没有则为第一个目录的）。"""
    if not settings:
        return None
    pigeon_dirs = [s for s in settings if s["model"] is not None]
    minimal_only = [s for s in settings if s["model"] is None]
    if not pigeon_dirs:
        first = settings[0]
        differ = sorted({k for s in settings[1:] for k in SHARED_SETTINGS if s[k] != first[k]})
        if differ:
            raise ResultFieldError(f"各输出目录的设置不一致：{'、'.join(differ)}")
        return first
    first = pigeon_dirs[0]
    differ = {k for s in pigeon_dirs[1:] for k in SHARED_SETTINGS if s[k] != first[k]}
    exempt = PIGEON_ONLY_SETTINGS + ("model",)
    differ |= {k for s in minimal_only for k in SHARED_SETTINGS if k not in exempt and s[k] != first[k]}
    if minimal_only:
        expected = {k: first["model"].get(k) for k in ("modelId", "temperature", "thinking", "maxOutputTokens")}
        if any(minimal_model(s["minimal"]) != expected for s in minimal_only):
            differ.add("model")
    if differ:
        raise ResultFieldError(f"各输出目录的设置不一致：{'、'.join(sorted(differ))}")
    return first


def load_table(paths: Iterable[str | Path]) -> tuple[pd.DataFrame, dict[str, Any]]:
    """读若干结果文件（多遍、多格可分在不同输出目录）合成一张规整表；同一格、题、遍取文件中最后出现的一行。
    每个结果文件所在目录即输出目录：读其 identity.json 与 streams/ 下的会话文件。"""
    paths = [Path(p) for p in paths]
    rows = read_jsonl(paths)
    by_dir: dict[Path, list[dict[str, Any]]] = {}
    records: list[dict[str, Any]] = []
    for f, k, row in rows:
        rec = row_to_record(row, f"{f.name} 第 {k} 行")
        if rec is None:
            continue
        records.append(rec)
        by_dir.setdefault(f.parent, []).append(row)
    settings: list[dict[str, Any]] = []
    # 会话文件的汇总按输出目录各记一条：不同目录的身份摘要可以相同（摘要不含条件与各 agent 参数），不能以摘要为键
    sessions_info: list[dict[str, Any]] = []
    session_counts: dict[tuple[str, int, int], dict[str, float]] = {}
    for run_dir, dir_rows in by_dir.items():
        needs_pigeon = any(CONDITION_TO_CELL[r["condition"]] != "M" for r in dir_rows)
        ident = read_identity(run_dir, needs_pigeon)
        for r in dir_rows:
            if r["runIdentity"] is not None and r["runIdentity"] != ident["digest"]:
                raise ResultFieldError(
                    f"结果行的身份摘要 {r['runIdentity']} 与 identity.json 的 {ident['digest']} 不一致"
                    f"（{run_dir.name}：condition={r['condition']}，attempt={r['attempt']}，seq={r['seq']}）")
        settings.append(ident)
        counts, info = load_session_metrics(run_dir, dir_rows, CONDITION_TO_CELL)
        session_counts.update(counts)
        sessions_info.append({"dir": run_dir.name, "digest": ident["digest"], **info})
    for rec in records:
        extra = session_counts.get((rec["cell"], int(rec["task"]), int(rec["pass_no"])))
        if extra:
            rec.update(extra)
    raw = [r for _, _, r in rows if is_task_row(r)]
    present = {f for f in TRACKED_FIELDS if any(_get(x, f) is not None for x in raw)}
    info = {
        "rows": len(rows),
        "records": len(records),
        "fieldsAbsent": sorted(set(TRACKED_FIELDS) - present),
        "settings": settings,
        "sessions": sessions_info,
    }
    return make_table(records), info


def require_step_space(values: Iterable[int], tasks: Iterable[int], flag: str) -> None:
    """题号列表（--tasks、--eligible）与规整表的"题"同为结果行的步序（seq），不是清单里的题号（从 1 起的序号）。
    结果行里有步序不在所给列表里即报错，提示改给步序。"""
    given = {int(v) for v in values}
    outside = sorted({int(t) for t in tasks} - given)
    if outside:
        shown = ", ".join(str(t) for t in outside[:10]) + ("…" if len(outside) > 10 else "")
        raise ValueError(f"{flag} 应给步序（结果行的 seq），不是题号：结果行里的步序 {shown} 不在 {flag} 里")


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
