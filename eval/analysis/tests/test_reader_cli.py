import json

import numpy as np
import pytest

from pigeon_analysis.calibration import sample_tasks
from pigeon_analysis.cli import main
from pigeon_analysis.reader import CONDITION_TO_CELL, load_table, read_baseline_failures, row_to_record

CELL_TO_CONDITION = {v: k for k, v in CONDITION_TO_CELL.items()}


def memory(chars, entries=None, size=None):
    return {"bytes": size if size is not None else chars, "entries": entries if entries is not None else chars // 150,
            "entryChars": chars}


def runner_row(cell, seq, attempt, passed, total, *, keep_failed=0, cost=0.4, review_cost=None, peak=None,
               mem_start=None, mem_end=None, review=None, **kw):
    """按跑批器二（runner-r3 0f463bb）的结果行字段表造一行；total 为 0 时得分与做成记 null。"""
    row = {
        "repo": "strands",
        "stream": "tasks",
        "condition": CELL_TO_CONDITION[cell],
        "attempt": attempt,
        "seq": seq,
        "kind": "task",
        "judged": True,
        "judging": {
            "failToPass": {"passed": passed, "total": total},
            "score": (passed / total) if total else None,
            "passToPass": {"failed": keep_failed, "total": 50},
            "solved": (passed == total and keep_failed == 0) if total else None,
            "failedCases": {"failToPass": [], "passToPass": [], "truncated": False},
            "excludedFlaky": 1,
        },
        "turns": 40,
        "agentWallMs": 600_000,
        "usage": {"input": 1000, "cacheRead": 9000, "output": 500},
        "gateway": {"queueMs": 0, "accountRequests": [3], "peakInFlight": 1, "costCny": cost,
                    "reviewCostCny": review_cost, "peakInputTokens": peak},
        "memoryAtStart": mem_start,
        "memoryAtEnd": mem_end,
        "hitStepBudget": False,
        "hitReviewBudget": None,
        "review": review,
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
        r = row_to_record(runner_row(
            "11", 7, 2, 3, 4, keep_failed=2, review_cost=0.1, peak=51_000,
            mem_start=memory(900, entries=6, size=950), mem_end=memory(1200),
            review={"turns": 12, "wallMs": 90_000}, hitStepBudget=True, hitReviewBudget=False,
            memoryUsage={"citations": 2, "rejectedFull": True},
        ))
        assert r["cell"] == "11" and r["task"] == 7 and r["pass_no"] == 2
        assert (r["f_passed"], r["f_total"], r["score"], r["solved"]) == (3, 4, 0.75, 0.0)
        assert (r["p_failed"], r["p_total"], r["flaky_excluded"]) == (2, 50, 1)
        assert (r["input_miss"], r["input_hit"], r["output_tokens"]) == (1000, 9000, 500)
        assert (r["cost"], r["review_cost"], r["peak_input"]) == (0.4, 0.1, 51_000)
        assert (r["memory_chars"], r["memory_bytes"], r["memory_entries"], r["memory_chars_after"]) == (900, 950, 6, 1200)
        assert (r["review_turns"], r["review_wall_ms"]) == (12, 90_000)
        assert (r["hit_step_budget"], r["hit_review_budget"]) == (1.0, 0.0)
        assert r["mem_citations"] == 2 and r["mem_rejectedFull"] == 1.0

    def test_unjudged_and_nulls(self):
        # 没判的步 judging 为 null；网关计价、复盘未接入时各项为 null：一律读成空
        r = row_to_record(runner_row("00", 1, 1, 1, 2, judging=None, gateway=None))
        assert r["f_total"] is None and r["score"] is None and r["cost"] is None and r["review_turns"] is None

    @pytest.mark.parametrize(
        "value,want",
        [("叠放运行拿不全用例", 1.0), (None, 0.0), ("", 0.0), ("  ", 0.0)],
    )
    def test_baseline_unavailable_reason_string(self, value, want):
        # 跑批器二（7b91a71）的 baselineUnavailable 为 string | null：非空即排除
        assert row_to_record(runner_row("00", 1, 1, 1, 2, baselineUnavailable=value))["baseline_unavailable"] == want

    def test_baseline_unavailable_reason_excludes_task(self, tmp_path):
        f = tmp_path / "results.jsonl"
        rows = [runner_row(c, 1, 1, 1, 2) for c in ("00", "01", "10", "11")]
        rows += [runner_row(c, 2, 1, 0, 0, judging=None, baselineUnavailable="叠放运行拿不全用例") for c in ("00", "01", "10", "11")]
        write_jsonl(f, rows)
        df, _ = load_table([f])
        from pigeon_analysis.primary import select_tasks
        sel = select_tasks(df)
        assert sel["baselineUnavailableTasks"] == [2]
        assert sel["missingTasks"] == []

    def test_non_task_and_unknown_condition_skipped(self):
        assert row_to_record(runner_row("00", 1, 1, 1, 1, kind="maintenance")) is None
        assert row_to_record({**runner_row("00", 1, 1, 1, 1), "condition": "full"}) is None

    def test_torn_line_and_absent_fields(self, tmp_path):
        f = tmp_path / "results.jsonl"
        write_jsonl(f, [runner_row("00", 1, 1, 1, 2), runner_row("01", 1, 1, 0, 0)], torn=True)
        df, info = load_table([f])
        assert info["rows"] == 2
        assert np.isnan(df[df.cell == "01"]["score"].iloc[0])  # 要做到的为零
        assert np.isnan(df[df.cell == "01"]["solved"].iloc[0])
        assert df[df.cell == "00"]["score"].iloc[0] == 0.5
        assert "gateway.costCny" not in info["fieldsAbsent"]
        assert "gateway.reviewCostCny" in info["fieldsAbsent"]
        assert "memoryAtStart.entryChars" in info["fieldsAbsent"]
        assert info["pendingFieldsPresent"] == []

    def test_multiple_files_later_wins(self, tmp_path):
        a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
        write_jsonl(a, [runner_row("00", 1, 1, 1, 2)])
        write_jsonl(b, [runner_row("00", 1, 1, 2, 2)])
        df, _ = load_table([a, b])
        assert df["score"].tolist() == [1.0]

    def test_baseline_failures_from_summary(self, tmp_path):
        # 汇总里的 task 是流中的序号（从 1 起），按全部题（步序）换算
        s = tmp_path / "classes-summary.json"
        s.write_text(json.dumps({"total": 4, "failed": [{"task": 3, "commit": "c3", "error": "x"}], "steps": []}), encoding="utf-8")
        assert read_baseline_failures(s, [40, 10, 30, 20]) == [30]
        s.write_text(json.dumps({"failed": [{"task": 5, "commit": "c", "error": "x"}]}), encoding="utf-8")
        with pytest.raises(ValueError):
            read_baseline_failures(s, [10, 20, 30, 40])


def formal_rows(n=12, passes=2, seed=0, no_baseline=()):
    rng = np.random.default_rng(seed)
    rows = []
    for t in range(1, n + 1):
        total = 0 if t == 5 else 6
        for cell in ("00", "01", "10", "11"):
            for a in range(1, passes + 1):
                k = int(rng.integers(0, total + 1)) if total else 0
                extra = {"review_cost": 0.05, "mem_start": memory(100 * t)} if cell[0] == "1" else {}
                if t in no_baseline:
                    extra["judging"] = None
                rows.append(runner_row(cell, 10 + t, a, k, total, **extra))
        rows.append(runner_row("M", 10 + t, 1, int(rng.integers(0, total + 1)) if total else 0, total))
    return rows


def tasks_file(tmp_path, n=12):
    p = tmp_path / "tasks.json"
    p.write_text(json.dumps([10 + t for t in range(1, n + 1)]), encoding="utf-8")
    return str(p)


def test_cli_formal_requires_tasks(tmp_path):
    f = tmp_path / "results.jsonl"
    write_jsonl(f, formal_rows())
    with pytest.raises(SystemExit):
        main(["formal", "--results", str(f), "--out", str(tmp_path / "o")])


def test_cli_formal_deterministic(tmp_path):
    f = tmp_path / "results.jsonl"
    write_jsonl(f, formal_rows())
    outs = []
    for k in range(2):
        out = tmp_path / f"out{k}"
        assert main(["formal", "--results", str(f), "--out", str(out), "--tasks", tasks_file(tmp_path)]) == 0
        outs.append(((out / "report.md").read_bytes(), (out / "result.json").read_bytes()))
    assert outs[0] == outs[1]
    res = json.loads(outs[0][1])
    assert res["primary"]["fEmptyTasks"] == [15]
    assert res["primary"]["nValid"] == 11
    assert res["thirdPass"] is not None  # 四格都是两遍
    md = outs[0][0].decode("utf-8")
    assert "## 结论（主判据）" in md and "## 稳健性分析（混合模型）" in md


def test_cli_formal_baseline_unavailable_from_summary(tmp_path):
    # 第 3 道题（步序 13）无法建立基线：跑批器没判（judging 为 null），汇总里记为出错
    f = tmp_path / "results.jsonl"
    write_jsonl(f, formal_rows(no_baseline=(3,)))
    s = tmp_path / "classes-summary.json"
    s.write_text(json.dumps({"failed": [{"task": 3, "commit": "c", "error": "叠放运行拿不全用例"}]}), encoding="utf-8")
    main(["formal", "--results", str(f), "--out", str(tmp_path / "o"), "--tasks", tasks_file(tmp_path),
          "--classes-summary", str(s)])
    p = json.loads((tmp_path / "o" / "result.json").read_text(encoding="utf-8"))["primary"]
    assert p["baselineUnavailableTasks"] == [13]
    assert p["missingTasks"] == []  # 不算缺失题
    assert p["nValid"] == 10  # 12 道 − 要做到的为零 1 道 − 无法建立基线 1 道
    assert "无法建立两类用例基线的题 1 道" in (tmp_path / "o" / "report.md").read_text(encoding="utf-8")
    # 不给汇总时同一道题只能算缺失
    main(["formal", "--results", str(f), "--out", str(tmp_path / "o2"), "--tasks", tasks_file(tmp_path)])
    p2 = json.loads((tmp_path / "o2" / "result.json").read_text(encoding="utf-8"))["primary"]
    assert [m["task"] for m in p2["missingTasks"]] == [13]


def test_cli_formal_single_pass_no_third_pass(tmp_path):
    f = tmp_path / "results.jsonl"
    write_jsonl(f, formal_rows(passes=1))
    main(["formal", "--results", str(f), "--out", str(tmp_path / "o"), "--tasks", tasks_file(tmp_path)])
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
                extra = ({"mem_start": memory(250 * i), "mem_end": memory(250 * (i + 1)),
                          "review": {"turns": 12, "wallMs": 180_000}, "review_cost": 0.02} if cell == "11" else {})
                rows.append(runner_row(cell, t, a, int(rng.integers(0, 5)), 4, peak=40_000 + 1000 * i, **extra))
        rows.append(runner_row("M", t, 1, 1, 4, cost=0.1))
    f = tmp_path / "cal.jsonl"
    write_jsonl(f, rows)
    el = tmp_path / "eligible.json"
    el.write_text(json.dumps(eligible), encoding="utf-8")
    outs = []
    for k in range(2):
        out = tmp_path / f"c{k}"
        main(["calibration", "--results", str(f), "--out", str(out), "--eligible", str(el), "--compaction-trigger", "900000",
              "--formal-valid-tasks", "80"])
        outs.append(((out / "report.md").read_bytes(), (out / "result.json").read_bytes()))
    assert outs[0] == outs[1]
    cal = json.loads(outs[0][1])["calibration"]
    assert cal["sampleCheck"]["matches"] is True
    # 用步末大小：(15 × 250 − 0) / 15 步 = 250 × 30 = 7,500 → 8,000
    assert cal["memoryCap"]["usedEndOfStepSizes"] == {"1": True, "2": True}
    assert cal["memoryCap"]["capChars"] == 8000
    assert cal["reviewCap"]["turns"] == 20
    assert cal["stepBudget"]["turns"] == 150
    assert cal["contextPeak"]["max"] == 40_000 + 1000 * 14
    assert cal["designSensitivity"]["formalTasks"] == 80
    assert cal["designSensitivity"]["mde"] is not None
    # 不给正式跑有效题数时不算最小可分辨效果
    main(["calibration", "--results", str(f), "--out", str(tmp_path / "c2")])
    cal2 = json.loads((tmp_path / "c2" / "result.json").read_text(encoding="utf-8"))["calibration"]
    assert cal2["designSensitivity"]["mde"] is None
    assert cal2["designSensitivity"]["v"] is not None
