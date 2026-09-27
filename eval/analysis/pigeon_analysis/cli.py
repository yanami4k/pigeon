"""命令行入口：分析正式跑、分析校准两种，各输出 report.md 与 result.json。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from . import constants as K
from .calibration import analyze_calibration
from .primary import analyze_primary
from .reader import load_table, read_baseline_failures
from .report import calibration_markdown, dumps, formal_markdown, formal_result
from .secondary import analyze_secondary
from .sensitivity import third_pass_decision


def _read_tasks(path: str | None) -> list[int] | None:
    """题号列表文件：JSON 数组。"""
    if path is None:
        return None
    return [int(x) for x in json.loads(Path(path).read_text(encoding="utf-8"))]


def run_formal(args: argparse.Namespace) -> dict[str, Any]:
    df, info = load_table(args.results)
    tasks = _read_tasks(args.tasks)
    no_baseline = read_baseline_failures(args.classes_summary, tasks) if args.classes_summary else None
    primary = analyze_primary(df, expected_tasks=tasks, baseline_unavailable=no_baseline)
    secondary = analyze_secondary(df, primary)
    passes = set(primary["passesPerCell"].values())
    # 第 3 遍规则只在四格都跑完两遍、尚无第 3 遍时判定（224）
    third = third_pass_decision(df, minimal_reserve=args.minimal_reserve) if passes == {2} else None
    return formal_result(primary, secondary, third, info)


def run_calibration(args: argparse.Namespace) -> dict[str, Any]:
    df, info = load_table(args.results)
    cal = analyze_calibration(
        df,
        formal_tasks=args.formal_tasks,
        formal_valid_tasks=args.formal_valid_tasks,
        compaction_trigger=args.compaction_trigger,
        eligible=_read_tasks(args.eligible),
    )
    return {"kind": "calibration", "calibration": cal, "input": info}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pigeon_analysis", description="正式跑与校准的统计分析")
    sub = ap.add_subparsers(dest="command", required=True)

    f = sub.add_parser("formal", help="分析正式跑")
    f.add_argument("--results", nargs="+", required=True, help="results.jsonl（可多个）")
    f.add_argument("--out", required=True, help="输出目录")
    f.add_argument("--tasks", required=True,
                   help="全部题号（89 道）的 JSON 数组：学习曲线的时间位置按它排，完全没有结果行的题也列为缺失")
    f.add_argument("--classes-summary",
                   help="两类用例预计算汇总（classes-summary.json）：其中出错、无法建立基线的题排除在主判据之外并计数")
    f.add_argument("--minimal-reserve", type=float, default=None,
                   help="最简 agent 尚未跑时为它预留的花费 C_M（元），第 3 遍判定用")

    c = sub.add_parser("calibration", help="分析校准")
    c.add_argument("--results", nargs="+", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--formal-tasks", type=int, default=K.FORMAL_TASKS, help="正式跑的题数（花费估算）")
    c.add_argument("--formal-valid-tasks", type=int, default=None,
                   help="正式跑的有效题数（89 道里要做到的不为零的题数，最小可分辨效果的 n）；未给时不算最小可分辨效果")
    c.add_argument("--compaction-trigger", type=float, default=None, help="压缩触发点（token）")
    c.add_argument("--eligible", help="要做到的不为零的全部题号（JSON 数组），用于核对抽题")

    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if args.command == "formal":
        res = run_formal(args)
        md = formal_markdown(res)
    else:
        res = run_calibration(args)
        md = calibration_markdown(res)
    (out / "result.json").write_text(dumps(res), encoding="utf-8", newline="\n")
    (out / "report.md").write_text(md, encoding="utf-8", newline="\n")
    return 0
