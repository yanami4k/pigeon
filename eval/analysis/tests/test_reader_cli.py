import json

import numpy as np
import pytest

from pigeon_analysis.calibration import sample_tasks
from pigeon_analysis.cli import main
from pigeon_analysis.reader import CONDITION_TO_CELL, load_table, row_to_record

CELL_TO_CONDITION = {v: k for k, v in CONDITION_TO_CELL.items()}


def runner_row(cell, seq, attempt, passed, total, **kw):
    row = {
        "repo": "strands",
        "stream": "tasks",
        "condition": CELL_TO_CONDITION[cell],
        "attempt": attempt,
        "seq": seq,
        "kind": "task",
        "targetPassed": passed,
        "targetTotal": total,
        "solved": passed == total,
        "keepFailed": 0,
        "keepTotal": 50,
        "turns": 40,
        "agentWallMs": 600_000,
        "usage": {"input": 1000, "cacheRead": 9000, "output": 500},
        "stepCost": 0.4,
    }
    row.update(kw)
    return row


def write_jsonl(path, rows, torn=False):
    text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    if torn:
        text += '{"condition": "neither", "seq'
    path.write_text(text, encoding="utf-8")


class TestReader:
    def test_mapping(self):
        r = row_to_record(runner_row("11", 7, 2, 3, 4, memoryUsage={"citations": 2, "rejectedFull": True}, reviewCost=0.1))
        assert r["cell"] == "11" and r["task"] == 7 and r["pass_no"] == 2
        assert (r["f_passed"], r["f_total"], r["solved"]) == (3, 4, 0.0)
        assert (r["input_miss"], r["input_hit"], r["output_tokens"]) == (1000, 9000, 500)
        assert r["cost"] == 0.4 and r["review_cost"] == 0.1
        assert r["mem_citations"] == 2 and r["mem_rejectedFull"] == 1.0

    def test_non_task_and_unknown_condition_skipped(self):
        assert row_to_record(runner_row("00", 1, 1, 1, 1, kind="maintenance")) is None
        assert row_to_record({**runner_row("00", 1, 1, 1, 1), "condition": "full"}) is None

    def test_torn_line_and_pending_fields(self, tmp_path):
        f = tmp_path / "results.jsonl"
        write_jsonl(f, [runner_row("00", 1, 1, 1, 2), runner_row("01", 1, 1, 0, 0)], torn=True)
        df, info = load_table([f])
        assert info["rows"] == 2
        assert np.isnan(df[df.cell == "01"]["score"].iloc[0])  # 要做到的为零
        assert df[df.cell == "00"]["score"].iloc[0] == 0.5
        assert "targetTotal" in info["pendingFieldsPresent"]
        assert "memoryChars" in info["pendingFieldsAbsent"]

    def test_multiple_files_later_wins(self, tmp_path):
        a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
        write_jsonl(a, [runner_row("00", 1, 1, 1, 2)])
        write_jsonl(b, [runner_row("00", 1, 1, 2, 2)])
        df, _ = load_table([a, b])
        assert df["score"].tolist() == [1.0]


def formal_rows(n=12, passes=2, seed=0):
    rng = np.random.default_rng(seed)
    rows = []
    for t in range(1, n + 1):
        total = 0 if t == 5 else 6
        for cell in ("00", "01", "10", "11"):
            for a in range(1, passes + 1):
                k = int(rng.integers(0, total + 1)) if total else 0
                extra = {"reviewCost": 0.05, "memoryBytes": 100 * t} if cell[0] == "1" else {}
                rows.append(runner_row(cell, 10 + t, a, k, total, **extra))
        rows.append(runner_row("M", 10 + t, 1, int(rng.integers(0, total + 1)) if total else 0, total))
    return rows


def test_cli_formal_deterministic(tmp_path):
    f = tmp_path / "results.jsonl"
    write_jsonl(f, formal_rows())
    outs = []
    for k in range(2):
        out = tmp_path / f"out{k}"
        assert main(["formal", "--results", str(f), "--out", str(out)]) == 0
        outs.append(((out / "report.md").read_bytes(), (out / "result.json").read_bytes()))
    assert outs[0] == outs[1]
    res = json.loads(outs[0][1])
    assert res["primary"]["fEmptyTasks"] == [15]
    assert res["primary"]["nValid"] == 11
    assert res["thirdPass"] is not None  # 四格都是两遍
    md = outs[0][0].decode("utf-8")
    assert "## 结论（主判据）" in md and "## 稳健性分析（混合模型）" in md


def test_cli_formal_single_pass_no_third_pass(tmp_path):
    f = tmp_path / "results.jsonl"
    write_jsonl(f, formal_rows(passes=1))
    main(["formal", "--results", str(f), "--out", str(tmp_path / "o")])
    res = json.loads((tmp_path / "o" / "result.json").read_text(encoding="utf-8"))
    assert res["thirdPass"] is None


def test_cli_calibration(tmp_path):
    eligible = list(range(1, 60))
    tasks = sample_tasks(eligible)
    rng = np.random.default_rng(1)
    rows = []
    for i, t in enumerate(tasks):
        for cell in ("01", "11"):
            for a in (1, 2):
                extra = {"memoryChars": 250 * i, "reviewTurns": 12, "reviewWallMs": 180_000, "reviewCost": 0.02} if cell == "11" else {}
                rows.append(runner_row(cell, t, a, int(rng.integers(0, 5)), 4, peakInputTokens=40_000 + 1000 * i, **extra))
        rows.append(runner_row("M", t, 1, 1, 4, stepCost=0.1))
    f = tmp_path / "cal.jsonl"
    write_jsonl(f, rows)
    el = tmp_path / "eligible.json"
    el.write_text(json.dumps(eligible), encoding="utf-8")
    outs = []
    for k in range(2):
        out = tmp_path / f"c{k}"
        main(["calibration", "--results", str(f), "--out", str(out), "--eligible", str(el), "--compaction-trigger", "900000"])
        outs.append(((out / "report.md").read_bytes(), (out / "result.json").read_bytes()))
    assert outs[0] == outs[1]
    cal = json.loads(outs[0][1])["calibration"]
    assert cal["sampleCheck"]["matches"] is True
    assert cal["memoryCap"]["capChars"] == 8000  # 每步 250 × 30 = 7,500 → 8,000
    assert cal["reviewCap"]["turns"] == 20
    assert cal["stepBudget"]["turns"] == 150
    assert cal["designSensitivity"]["mde"] is not None
