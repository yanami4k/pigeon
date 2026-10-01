import json
from pathlib import Path

import numpy as np
import pytest

from pigeon_analysis.calibration import sample_tasks
from pigeon_analysis.cli import main
from pigeon_analysis.reader import (
    ResultFieldError,
    common_settings,
    load_table,
    read_baseline_failures,
    row_to_record,
    rows_cost,
    spent_summary,
)
from pigeon_analysis.sessions import SessionSourceError, memory_refs, reads_referenced_file
from runner_fixture import (
    MEMORY_MD,
    SessionBuilder,
    identity,
    memory,
    review_facts,
    runner_row,
    write_job,
    write_run,
)


class TestReader:
    def test_mapping(self):
        r = row_to_record(runner_row(
            "11", 7, 2, 3, 4, keep_failed=2, review_cost=0.1, peak=51_000,
            mem_start=memory(900, entries=6, size=950), mem_end=memory(1200, entries=8, size=1333),
            review=review_facts(turns=12, wall_ms=90_000, tokens=33_000, closing=1, pre=2, hit=True),
            hitStepBudget=True, verifyToolFaults=3,
        ))
        assert r["cell"] == "11" and r["task"] == 7 and r["pass_no"] == 2
        assert (r["f_passed"], r["f_total"], r["score"], r["solved"]) == (3, 4, 0.75, 0.0)
        assert (r["p_failed"], r["p_total"], r["flaky_excluded"]) == (2, 50, 1)
        assert (r["input_miss"], r["input_hit"], r["output_tokens"]) == (1000, 9000, 500)
        assert (r["turns"], r["wall_ms"]) == (40, 600_000)
        assert (r["cost"], r["review_cost"], r["peak_input"]) == (0.4, 0.1, 51_000)
        assert (r["memory_chars"], r["memory_bytes"], r["memory_entries"]) == (900, 950, 6)
        assert (r["memory_chars_after"], r["memory_entries_after"]) == (1200, 8)
        assert (r["review_closing"], r["review_pre_compaction"]) == (1, 2)
        assert (r["review_turns"], r["review_tokens"], r["review_wall_ms"]) == (12, 33_000, 90_000)
        assert (r["hit_step_budget"], r["hit_review_budget"]) == (1.0, 1.0)
        assert r["verify_tool_faults"] == 3
        assert r["baseline_unavailable"] == 0.0

    def test_nulls_read_as_empty(self):
        # 没判的步 judging 为 null；不推送的条件没有复盘；不经网关 gateway 为 null：字段在、值为空，照常读成空
        r = row_to_record(runner_row("00", 1, 1, 1, 2, judging=None, gateway=None))
        assert r["f_total"] is None and r["score"] is None and r["cost"] is None
        assert r["review_turns"] is None and r["hit_review_budget"] is None

    @pytest.mark.parametrize("field", ["hitStepBudget", "hitReviewBudget", "memoryAtEnd", "verifyToolFaults", "review",
                                       "gateway", "runIdentity", "baselineUnavailable", "kind"])
    def test_missing_top_field_raises(self, field):
        row = runner_row("11", 7, 2, 1, 2)
        del row[field]
        with pytest.raises(ResultFieldError) as e:
            row_to_record(row, "results.jsonl 第 3 行")
        msg = str(e.value)
        assert field in msg and "seq=7" in msg and "第 3 行" in msg

    @pytest.mark.parametrize(
        "parent,child",
        [("gateway", "reviewCostCny"), ("gateway", "costCny"), ("gateway", "peakInputTokens"), ("review", "tokens"),
         ("review", "preCompaction"), ("memoryAtEnd", "entryChars"), ("memoryAtStart", "entries"), ("usage", "cacheRead")],
    )
    def test_missing_nested_field_raises(self, parent, child):
        row = runner_row("11", 7, 2, 1, 2)
        del row[parent][child]
        with pytest.raises(ResultFieldError, match=f"{parent}.{child}"):
            row_to_record(row)

    def test_missing_judging_subfield_raises(self):
        row = runner_row("01", 7, 2, 1, 2)
        del row["judging"]["failToPass"]["passed"]
        with pytest.raises(ResultFieldError, match="judging.failToPass.passed"):
            row_to_record(row)

    @pytest.mark.parametrize(
        "value,want",
        [("叠放运行拿不全用例", 1.0), (None, 0.0), ("", 0.0), ("  ", 0.0)],
    )
    def test_baseline_unavailable_reason_string(self, value, want):
        # baselineUnavailable 为 string | null：非空即排除
        assert row_to_record(runner_row("00", 1, 1, 1, 2, baselineUnavailable=value))["baseline_unavailable"] == want

    def test_baseline_unavailable_reason_excludes_task(self, tmp_path):
        rows = [runner_row(c, 1, 1, 1, 2) for c in ("00", "01", "10", "11")]
        rows += [runner_row(c, 2, 1, 0, 0, judging=None, baselineUnavailable="叠放运行拿不全用例") for c in ("00", "01", "10", "11")]
        df, _ = load_table([write_run(tmp_path, rows)])
        from pigeon_analysis.primary import select_tasks
        sel = select_tasks(df)
        assert sel["baselineUnavailableTasks"] == [2]
        assert sel["missingTasks"] == []

    def test_non_task_and_unknown_condition_skipped(self):
        assert row_to_record(runner_row("00", 1, 1, 1, 1, kind="maintenance")) is None
        assert row_to_record({**runner_row("00", 1, 1, 1, 1), "condition": "full"}) is None

    def test_torn_line_and_absent_fields(self, tmp_path):
        f = write_run(tmp_path, [runner_row("00", 1, 1, 1, 2), runner_row("01", 1, 1, 0, 0)], torn=True)
        df, info = load_table([f])
        assert info["rows"] == 2
        assert np.isnan(df[df.cell == "01"]["score"].iloc[0])  # 要做到的为零
        assert np.isnan(df[df.cell == "01"]["solved"].iloc[0])
        assert df[df.cell == "00"]["score"].iloc[0] == 0.5
        assert "gateway.costCny" not in info["fieldsAbsent"]
        assert "gateway.reviewCostCny" in info["fieldsAbsent"]  # 两格都不推送
        assert "review.turns" in info["fieldsAbsent"]
        assert "memoryAtStart.entryChars" not in info["fieldsAbsent"]

    def test_multiple_files_later_wins(self, tmp_path):
        a = write_run(tmp_path / "a", [runner_row("00", 1, 1, 1, 2)])
        b = write_run(tmp_path / "b", [runner_row("00", 1, 1, 2, 2)])
        df, info = load_table([a, b])
        assert df["score"].tolist() == [1.0]
        assert len(info["settings"]) == 2

    def test_baseline_failures_from_summary(self, tmp_path):
        # 汇总里的 task 是流中的序号（从 1 起），按全部题（步序）换算
        s = tmp_path / "classes-summary.json"
        s.write_text(json.dumps({"total": 4, "failed": [{"task": 3, "commit": "c3", "error": "x"}], "steps": []}), encoding="utf-8")
        assert read_baseline_failures(s, [40, 10, 30, 20]) == [30]
        s.write_text(json.dumps({"failed": [{"task": 5, "commit": "c", "error": "x"}]}), encoding="utf-8")
        with pytest.raises(ValueError):
            read_baseline_failures(s, [10, 20, 30, 40])


class TestIdentity:
    def test_settings_read(self, tmp_path):
        f = write_run(tmp_path, [runner_row("11", 1, 1, 1, 2)])
        _, info = load_table([f])
        st = info["settings"][0]
        assert st["digest"] == "0123456789abcdef"
        assert st["promptFormat"] == "test-files"
        assert st["stepBudget"] == {"maxTurns": 300, "wallClockMs": 3_600_000}
        assert st["compaction"]["thresholdTokens"] == 983_616
        assert st["memoryLimitChars"] == 12_000
        assert st["reviewTemplate"] == "v1"
        assert st["reviewBudget"] == {"maxTurns": 40, "wallClockMs": 900_000}
        assert st["model"]["modelId"] == "deepseek-flash"

    def test_missing_identity_file(self, tmp_path):
        f = write_run(tmp_path, [runner_row("11", 1, 1, 1, 2)])
        (tmp_path / "identity.json").unlink()
        with pytest.raises(ResultFieldError, match="identity.json"):
            load_table([f])

    @pytest.mark.parametrize("key", ["reviewBudget", "reviewTemplate", "memoryLimitChars", "compaction"])
    def test_missing_pigeon_setting(self, tmp_path, key):
        ident = identity()
        del ident["core"]["agents"]["pigeon"][key]
        f = write_run(tmp_path, [runner_row("11", 1, 1, 1, 2)], ident=ident)
        with pytest.raises(ResultFieldError, match=f"core.agents.pigeon.{key}"):
            load_table([f])

    def test_minimal_only_needs_no_pigeon_settings(self, tmp_path):
        f = write_run(tmp_path, [runner_row("M", 1, 1, 1, 2)], ident=identity(("minimal",), pigeon=False))
        _, info = load_table([f])
        assert info["settings"][0]["reviewBudget"] is None

    def test_row_digest_must_match(self, tmp_path):
        f = write_run(tmp_path, [runner_row("11", 1, 1, 1, 2, runIdentity="ffffffffffffffff")])
        with pytest.raises(ResultFieldError, match="身份摘要"):
            load_table([f])

    def test_common_settings(self):
        a = {"digest": "a", **{k: 1 for k in ("promptFormat", "promptLayout", "stepBudget", "model", "compaction",
                                              "memoryLimitChars", "reviewTemplate", "reviewBudget")}}
        assert common_settings([a, {**a, "digest": "b"}]) == a
        with pytest.raises(ResultFieldError, match="reviewBudget"):
            common_settings([a, {**a, "reviewBudget": 2}])
        assert common_settings([]) is None


# 最简 agent 单独一个输出目录时身份头里的设置：跑批器按 run_mini.py --identity 记下的 litellm 参数
MINI_KWARGS = {"drop_params": True, "parallel_tool_calls": True, "max_tokens": 16384, "temperature": 0,
               "thinking": {"type": "disabled"}, "allowed_openai_params": ["thinking"]}


def minimal_identity(**kwargs_override):
    ident = identity(("minimal",), pigeon=False)
    ident["core"]["agents"]["minimal"] = {"model": "deepseek-flash", "miniSweAgent": "2.4.6", "litellm": "1.102.1",
                                          "modelKwargs": {**MINI_KWARGS, **kwargs_override}}
    return ident


def split_runs(tmp_path, minimal_ident):
    """两格两遍一个目录、最简 agent 一遍另一个目录（校准与正式跑的分法）。"""
    cells = write_run(tmp_path / "cells", [runner_row(c, s, p, 1, 2) for c in ("01", "11") for s in (1, 2)
                                           for p in (1, 2)], ident=identity(("search-only", "search-push")))
    mini = write_run(tmp_path / "minimal", [runner_row("M", s, 1, 1, 2) for s in (1, 2)], ident=minimal_ident)
    return cells, mini


class TestSplitDirs:
    def test_cells_and_minimal_dirs_read_together(self, tmp_path):
        cells, mini = split_runs(tmp_path, minimal_identity())
        for order in ([cells, mini], [mini, cells]):
            df, info = load_table(order)
            assert sorted(df["cell"].unique()) == ["01", "11", "M"]
            settings = common_settings(info["settings"])
            assert settings["compaction"]["thresholdTokens"] == 983_616
            assert settings["reviewBudget"] == {"maxTurns": 40, "wallClockMs": 900_000}
        out = tmp_path / "out"
        assert main(["calibration", "--results", str(cells), str(mini), "--out", str(out)]) == 0
        assert json.loads((out / "result.json").read_text(encoding="utf-8"))["input"]["records"] == 10

    @pytest.mark.parametrize("override", [{"temperature": 0.7}, {"max_tokens": 8192},
                                          {"thinking": {"type": "enabled"}}])
    def test_minimal_model_settings_must_match(self, tmp_path, override):
        cells, mini = split_runs(tmp_path, minimal_identity(**override))
        _, info = load_table([cells, mini])
        with pytest.raises(ResultFieldError, match="model"):
            common_settings(info["settings"])

    def test_minimal_model_name_must_match(self, tmp_path):
        ident = minimal_identity()
        ident["core"]["agents"]["minimal"]["model"] = "deepseek-pro"
        cells, mini = split_runs(tmp_path, ident)
        with pytest.raises(ResultFieldError, match="model"):
            main(["calibration", "--results", str(cells), str(mini), "--out", str(tmp_path / "out")])

    def test_minimal_without_model_kwargs_cannot_be_checked(self, tmp_path):
        ident = minimal_identity()
        ident["core"]["agents"]["minimal"]["modelKwargs"] = None
        cells, mini = split_runs(tmp_path, ident)
        _, info = load_table([cells, mini])
        with pytest.raises(ResultFieldError, match="model"):
            common_settings(info["settings"])

    def test_minimal_dir_still_checks_shared_step_settings(self, tmp_path):
        ident = minimal_identity()
        ident["core"]["budget"] = {"maxTurns": 150, "wallClockMs": 1_800_000}
        cells, mini = split_runs(tmp_path, ident)
        _, info = load_table([cells, mini])
        with pytest.raises(ResultFieldError, match="stepBudget"):
            common_settings(info["settings"])

    def test_sessions_kept_per_dir_with_same_digest(self, tmp_path):
        """两个目录的身份摘要相同（摘要不含条件与 agent 参数）：会话汇总按目录各记一条，后读的不覆盖先读的。"""
        cells = write_run(tmp_path / "cells", [runner_row("11", 1, 1, 1, 2, mem_start=memory(300, entries=2))],
                          ident=identity(("search-push",)))
        write_job(tmp_path / "cells", "search-push", 1, {1: [worker_step1(), review_step1()]}, snapshots={1: MEMORY_MD})
        mini = write_run(tmp_path / "minimal", [runner_row("M", 1, 1, 1, 2)], ident=minimal_identity())
        (tmp_path / "minimal" / "streams").mkdir()
        _, info = load_table([cells, mini])
        assert info["settings"][0]["digest"] == info["settings"][1]["digest"]
        assert info["sessions"] == [
            {"dir": "cells", "digest": "0123456789abcdef", "available": True, "jobs": 1, "sessionFiles": 2},
            {"dir": "minimal", "digest": "0123456789abcdef", "available": True, "jobs": 0, "sessionFiles": 0},
        ]
        out = tmp_path / "out"
        assert main(["calibration", "--results", str(cells), str(mini), "--out", str(out)]) == 0
        md = (out / "report.md").read_text(encoding="utf-8")
        assert "会话文件（目录 cells，摘要 0123456789abcdef）：1 个作业、2 个会话文件" in md
        assert "会话文件（目录 minimal，摘要 0123456789abcdef）：0 个作业、0 个会话文件" in md
        assert "会话文件合计（2 个可用目录相加）：1 个作业、2 个会话文件" in md


class TestGatewaySpent:
    """已花取各输出目录网关累计之和（含作废的步与开跑前探测），结果行合计与二者之差并列；缺网关记录即报错。"""

    def split(self, tmp_path, cells_gateway=None):
        cells, mini = split_runs(tmp_path, minimal_identity())
        if cells_gateway is not None:
            (tmp_path / "cells" / "gateway-spend.json").write_text(
                json.dumps({"totalCny": cells_gateway, "requests": 9, "peakRequests": 0}), encoding="utf-8")
        return cells, mini

    def test_gateway_total_counts_voided_steps(self, tmp_path):
        # 两格 8 行：01 每步 0.4，11 每步 0.4 + 复盘 0.02，共 3.28；另有作废的步 0.5 只记在网关。最简 agent 2 行 0.8
        cells, mini = self.split(tmp_path, cells_gateway=3.78)
        _, info = load_table([cells, mini])
        assert [(x["dir"], round(x["gatewayCny"], 4), round(x["rowsCny"], 4)) for x in info["spend"]] == [
            ("cells", 3.78, 3.28), ("minimal", 0.8, 0.8)]
        sp = spent_summary(info["spend"])
        assert sp["gatewayCny"] == pytest.approx(4.58)
        assert sp["rowsCny"] == pytest.approx(4.08)
        assert sp["difference"] == pytest.approx(0.5)
        out = tmp_path / "out"
        assert main(["calibration", "--results", str(cells), str(mini), "--out", str(out)]) == 0
        res = json.loads((out / "result.json").read_text(encoding="utf-8"))
        assert res["calibration"]["cost"]["spent"]["gatewayCny"] == pytest.approx(4.58)
        md = (out / "report.md").read_text(encoding="utf-8")
        assert "已花（各输出目录网关累计之和，含作废的步与开跑前探测）4.5800 元；结果行合计 4.0800 元；二者之差 0.5000 元" in md

    def test_missing_gateway_file_raises(self, tmp_path):
        cells, mini = self.split(tmp_path)
        (tmp_path / "minimal" / "gateway-spend.json").unlink()
        with pytest.raises(ResultFieldError, match="缺网关花费记录：minimal（缺 gateway-spend.json）"):
            main(["calibration", "--results", str(cells), str(mini), "--out", str(tmp_path / "out")])

    def test_missing_total_raises(self, tmp_path):
        cells, mini = self.split(tmp_path)
        (tmp_path / "cells" / "gateway-spend.json").write_text(json.dumps({"requests": 3}), encoding="utf-8")
        with pytest.raises(ResultFieldError, match="cells（缺 totalCny）"):
            main(["calibration", "--results", str(cells), str(mini), "--out", str(tmp_path / "out")])

    def test_rows_cost_takes_last_row(self):
        rows = [runner_row("01", 1, 1, 1, 2, cost=9.0), runner_row("01", 1, 1, 1, 2, cost=0.4),
                runner_row("11", 1, 1, 1, 2, cost=0.4)]
        assert rows_cost(rows) == pytest.approx(0.4 + 0.42)

    def test_formal_missing_gateway_raises(self, tmp_path):
        f = write_run(tmp_path / "run", formal_rows(), ident=identity(FORMAL_CONDITIONS), gateway_cny=None)
        with pytest.raises(ResultFieldError, match="缺 gateway-spend.json"):
            main(["formal", "--results", str(f), "--out", str(tmp_path / "o"), "--tasks", tasks_file(tmp_path)])


class TestStepSpace:
    """--eligible 与 --tasks 给的是结果行的步序（seq），不是从 1 起的题号。"""

    def rows(self, tmp_path):
        return write_run(tmp_path / "run", [runner_row(c, s, p, 1, 2) for c in ("01", "11") for s in (46, 59)
                                            for p in (1, 2)], ident=identity(("search-only", "search-push")))

    def test_eligible_in_step_space_passes(self, tmp_path):
        el = tmp_path / "eligible.json"
        el.write_text(json.dumps([46, 59] + list(range(100, 118))), encoding="utf-8")
        assert main(["calibration", "--results", str(self.rows(tmp_path)), "--out", str(tmp_path / "o"),
                     "--eligible", str(el)]) == 0

    def test_eligible_as_task_numbers_raises(self, tmp_path):
        el = tmp_path / "eligible.json"
        # 清单里 1 至 20 的题号，与结果行的步序 46、59 不在同一编号空间
        el.write_text(json.dumps(list(range(1, 21))), encoding="utf-8")
        with pytest.raises(ValueError, match=r"--eligible 应给步序（结果行的 seq），不是题号：结果行里的步序 46, 59 不在 --eligible 里"):
            main(["calibration", "--results", str(self.rows(tmp_path)), "--out", str(tmp_path / "o"),
                  "--eligible", str(el)])

    def test_formal_tasks_missing_a_result_step_raises(self, tmp_path):
        f = write_run(tmp_path / "run", formal_rows(), ident=identity(FORMAL_CONDITIONS))
        tasks = json.loads(Path(tasks_file(tmp_path)).read_text(encoding="utf-8"))
        seen = sorted({r["seq"] for r in formal_rows()})
        p = tmp_path / "short.json"
        p.write_text(json.dumps([t for t in tasks if t != seen[-1]]), encoding="utf-8")
        with pytest.raises(ValueError, match=rf"--tasks 应给步序.*{seen[-1]}"):
            main(["formal", "--results", str(f), "--out", str(tmp_path / "o"), "--tasks", str(p)])


def worker_step1():
    s = SessionBuilder("w1").run_start()
    s.assistant("先看记忆。依据 [L1]，还有 [L2]；再次依据 [L1]。", calls=[
        ("c1", "read_file", {"path": "/testbed/src/a.py"}),
        ("c2", "read_file", {"path": "src/other.py"}),
        ("c3", "read_file", {"path": "./tests/test_b.py"}),
        ("c4", "search_sessions", {"keywords": ["x"]}),
        ("c5", "search_sessions", {"keywords": ["y"]}),
        ("c6", "read_session_entry", {"entryId": "e3"}),
    ], usage=(500, 5000, 100))
    s.result("c4", "search_sessions", {"hits": [{"sessionId": "s1"}, {"sessionId": "s2"}], "limited": False, "byteCapped": False})
    s.result("c5", "search_sessions", {"hits": [{"sessionId": "s1"}, {"sessionId": "s3"}], "limited": False, "byteCapped": False})
    s.result("c6", "read_session_entry", {}, is_error=True)
    s.memory_write("m1", "add")
    s.memory_write("m2", "replace", written=False, rejected="full")
    s.memory_write("m3", "add", written=False, rejected="duplicate")
    return s


def review_step1():
    # 复盘会话由干活会话分叉：开头是干活会话的历史副本（含它的写入与检索），复盘自己的部分从带 memoryReview 的 run-start 起
    s = SessionBuilder("r1", parent="w1").run_start()
    s.assistant("副本里的 [L1]", calls=[("x1", "search_sessions", {"keywords": ["z"]})], usage=(999, 999, 999))
    s.result("x1", "search_sessions", {"hits": [{"sessionId": "s9"}]})
    s.memory_write("xm", "add")
    s.run_start("closing")
    s.memory_write("rm1", "add")
    # 复盘里调检索工具会被拒（只能 read_file 与 update_memory），不计入检索次数
    s.assistant(calls=[("rs1", "search_sessions", {"keywords": ["q"]}), ("rs2", "read_session_entry", {"entryId": "e1"})])
    s.result("rs1", "search_sessions", {}, text="复盘中只能使用 read_file 与 update_memory，这次调用没有执行。")
    s.result("rs2", "read_session_entry", {}, text="复盘中只能使用 read_file 与 update_memory，这次调用没有执行。")
    s.memory_write("rm2", "remove")
    s.memory_write("rm3", "add", written=False, rejected="full")
    s.assistant("复盘完", usage=(100, 200, 30))
    return s


class TestSessions:
    def build(self, tmp_path, with_step2=True):
        rows = [runner_row("11", 1, 1, 1, 2, mem_start=memory(300, entries=2))]
        steps = {1: [worker_step1(), review_step1()]}
        if with_step2:
            rows.append(runner_row("11", 2, 1, 1, 2, mem_start=memory(300, entries=2)))
            w2 = SessionBuilder("w2").run_start()
            w2.memory_write("n1", "remove")
            pre = SessionBuilder("r2", parent="w2").run_start().run_start("pre-compaction")
            pre.memory_write("n2", "replace")
            steps[2] = [w2, pre]
        rows += [runner_row("01", 1, 1, 1, 2)]
        s01 = SessionBuilder("s01").run_start()
        s01.assistant("[L1] 不算：这格不推送", calls=[("q1", "search_sessions", {"keywords": ["a"]})])
        s01.result("q1", "search_sessions", {"hits": [{"sessionId": "k1"}, {"sessionId": "k1"}]})
        write_job(tmp_path, "search-push", 1, steps, snapshots={1: MEMORY_MD, 2: MEMORY_MD})
        write_job(tmp_path, "search-only", 1, {1: [s01]})
        return write_run(tmp_path, rows)

    def test_reads_state_layout(self, tmp_path):
        """决策 325 起会话在 .pigeon/state/sessions；新布局与旧布局读出同样的计数。"""
        rows = [runner_row("01", 1, 1, 1, 2)]
        s01 = SessionBuilder("s01").run_start()
        s01.assistant("找", calls=[("q1", "search_sessions", {"keywords": ["a"]})])
        s01.result("q1", "search_sessions", {"hits": [{"sessionId": "k1"}]})
        legacy, state = tmp_path / "legacy", tmp_path / "state"
        write_job(legacy, "search-only", 1, {1: [s01]})
        write_job(state, "search-only", 1, {1: [s01]}, layout="state")
        assert (state / "streams" / "tasks-search-only-1" / ".pigeon" / "state" / "sessions").is_dir()
        a, _ = load_table([write_run(legacy, rows)])
        b, _ = load_table([write_run(state, rows)])
        ra = a[(a.cell == "01") & (a.task == 1)].iloc[0]
        rb = b[(b.cell == "01") & (b.task == 1)].iloc[0]
        assert ra.search_calls_search_sessions == rb.search_calls_search_sessions == 1

    def test_counts_step1(self, tmp_path):
        df, info = load_table([self.build(tmp_path)])
        r = df[(df.cell == "11") & (df.task == 1)].iloc[0]
        # 干活：新增 1（写成功），写满被拒 1（重复被拒不算写满）；复盘只数自己的部分：新增 1、删除 1、写满被拒 1
        assert (r.mem_worker_add, r.mem_worker_replace, r.mem_worker_remove, r.mem_worker_rejected_full) == (1, 0, 0, 1)
        assert (r.mem_review_add, r.mem_review_replace, r.mem_review_remove, r.mem_review_rejected_full) == (1, 0, 1, 1)
        # 回复正文里的 [L1]、[L2]、[L1]：3 次、2 条；思考与复盘副本里的不算
        assert (r.mem_citations, r.mem_cited_entries) == (3, 2)
        # 其中写成"依据 [L编号]"的：两处都是 [L1]，涉及 1 条；"还有 [L2]"不算
        assert (r.mem_basis_citations, r.mem_basis_cited_entries) == (2, 1)
        # 读 /testbed/src/a.py 与 ./tests/test_b.py 命中记忆所引文件，src/other.py 不算
        assert r.mem_ref_reads == 2
        # 检索只数干活会话：search_sessions 2 次、read_session_entry 1 次，命中会话 s1、s2、s3
        assert (r.search_calls_search_sessions, r.search_calls_read_session_entry, r.search_sessions_hit) == (2, 1, 3)
        # 复盘 token 只数复盘自己的部分
        assert (r.review_input_miss, r.review_input_hit, r.review_output) == (100, 200, 30)
        assert info["sessions"] == [{"dir": tmp_path.name, "digest": "0123456789abcdef", "available": True, "jobs": 2,
                                     "sessionFiles": 5}]

    def test_step2_counts_only_new_sessions(self, tmp_path):
        df, _ = load_table([self.build(tmp_path)])
        r = df[(df.cell == "11") & (df.task == 2)].iloc[0]
        assert (r.mem_worker_add, r.mem_worker_remove) == (0, 1)
        assert (r.mem_review_add, r.mem_review_replace) == (0, 1)
        assert r.mem_citations == 0 and r.mem_basis_citations == 0 and r.search_sessions_hit == 0

    def test_non_push_cell_has_no_memory_counts(self, tmp_path):
        df, _ = load_table([self.build(tmp_path)])
        r = df[df.cell == "01"].iloc[0]
        assert np.isnan(r.mem_citations) and np.isnan(r.mem_worker_add)
        assert (r.search_calls_search_sessions, r.search_sessions_hit) == (1, 1)

    def test_missing_listing_raises(self, tmp_path):
        f = self.build(tmp_path)
        (tmp_path / "streams" / "tasks-search-push-1" / "sessions-2.json").unlink()
        with pytest.raises(SessionSourceError, match="sessions-2.json"):
            load_table([f])

    def test_missing_snapshot_with_entries_raises(self, tmp_path):
        f = self.build(tmp_path, with_step2=False)
        snap = tmp_path / "streams" / "tasks-search-push-1" / "learned-snapshots" / "step-1" / "learned" / "MEMORY.md"
        snap.unlink()
        with pytest.raises(SessionSourceError, match="开工记忆快照"):
            load_table([f])

    def test_no_streams_dir_marked_unavailable(self, tmp_path):
        f = write_run(tmp_path, [runner_row("11", 1, 1, 1, 2)])
        df, info = load_table([f])
        assert info["sessions"] == [{"dir": tmp_path.name, "digest": "0123456789abcdef", "available": False,
                                     "reason": "no-streams-dir"}]
        assert "mem_citations" not in df.columns

    def test_memory_refs_and_matching(self):
        refs = memory_refs(MEMORY_MD)
        assert refs == {"src/a.py", "tests/test_b.py"}
        assert reads_referenced_file("/testbed/src/a.py", refs)
        assert reads_referenced_file("src\\a.py", refs)
        assert not reads_referenced_file("/testbed/xsrc/a.py", refs)


def formal_rows(n=12, passes=2, seed=0, no_baseline=()):
    rng = np.random.default_rng(seed)
    rows = []
    for t in range(1, n + 1):
        total = 0 if t == 5 else 6
        for cell in ("00", "01", "10", "11"):
            for a in range(1, passes + 1):
                k = int(rng.integers(0, total + 1)) if total else 0
                extra = {"mem_start": memory(100 * t), "mem_end": memory(100 * t + 80)} if cell[0] == "1" else {}
                if t in no_baseline:
                    extra["judging"] = None
                rows.append(runner_row(cell, 10 + t, a, k, total, **extra))
        rows.append(runner_row("M", 10 + t, 1, int(rng.integers(0, total + 1)) if total else 0, total))
    return rows


FORMAL_CONDITIONS = ("neither", "search-only", "push-only", "search-push", "minimal")


def tasks_file(tmp_path, n=12):
    p = tmp_path / "tasks.json"
    p.write_text(json.dumps([10 + t for t in range(1, n + 1)]), encoding="utf-8")
    return str(p)


def test_cli_formal_requires_tasks(tmp_path):
    f = write_run(tmp_path / "run", formal_rows())
    with pytest.raises(SystemExit):
        main(["formal", "--results", str(f), "--out", str(tmp_path / "o")])


def test_cli_formal_deterministic(tmp_path):
    f = write_run(tmp_path / "run", formal_rows(), ident=identity(FORMAL_CONDITIONS))
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
    assert res["verifyToolFaults"] == {"00": 0.0, "01": 0.0, "10": 0.0, "11": 0.0}
    md = outs[0][0].decode("utf-8")
    assert "## 结论（主判据）" in md and "## 稳健性分析（混合模型）" in md
    assert "## 设置（身份头）" in md and "复盘模板 v1" in md and "触发点 983616 token" in md
    assert "### 效率：干活" in md and "### 效率：复盘" in md
    assert "会话文件不可用" in md


def test_cli_formal_baseline_unavailable_from_summary(tmp_path):
    # 第 3 道题（步序 13）无法建立基线：跑批器没判（judging 为 null），汇总里记为出错
    f = write_run(tmp_path / "run", formal_rows(no_baseline=(3,)), ident=identity(FORMAL_CONDITIONS))
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
    f = write_run(tmp_path / "run", formal_rows(passes=1), ident=identity(FORMAL_CONDITIONS))
    main(["formal", "--results", str(f), "--out", str(tmp_path / "o"), "--tasks", tasks_file(tmp_path)])
    res = json.loads((tmp_path / "o" / "result.json").read_text(encoding="utf-8"))
    assert res["thirdPass"] is None


def calibration_rows(tasks, hit_step=False, hit_review=False):
    rng = np.random.default_rng(1)
    rows = []
    for i, t in enumerate(tasks):
        for cell in ("01", "11"):
            for a in (1, 2):
                extra = ({"mem_start": memory(250 * i), "mem_end": memory(250 * (i + 1)),
                          "review": review_facts(hit=hit_review and i == 3), "review_cost": 0.02} if cell == "11" else {})
                rows.append(runner_row(cell, t, a, int(rng.integers(0, 5)), 4, peak=40_000 + 1000 * i,
                                       hitStepBudget=bool(hit_step and cell == "01" and i == 2), **extra))
        rows.append(runner_row("M", t, 1, 1, 4, cost=0.1))
    return rows


def test_cli_calibration(tmp_path):
    eligible = list(range(1, 60))
    tasks = sample_tasks(eligible)
    f = write_run(tmp_path / "run", calibration_rows(tasks))
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
    # 没有撞：两种上限都维持临时值
    assert (cal["reviewCap"]["turns"], cal["reviewCap"]["wallMinutes"]) == (40, 15)
    assert (cal["stepBudget"]["turns"], cal["stepBudget"]["wallMinutes"]) == (300, 60)
    assert cal["contextPeak"]["max"] == 40_000 + 1000 * 14
    assert cal["contextPeak"]["compactionTrigger"] == 900_000
    assert cal["difficultyGate"]["promptFormat"] == "test-files"
    assert cal["difficultyGate"]["steps"] == 30
    assert cal["temporarySettings"]["matches"] == {"stepBudget": True, "reviewBudget": True, "memoryLimitChars": True}
    assert cal["designSensitivity"]["formalTasks"] == 80
    assert cal["designSensitivity"]["mde"] is not None
    md = outs[0][0].decode("utf-8")
    assert "## 5.1 难度关" in md and "## 设置（身份头）" in md
    # 不给正式跑有效题数时不算最小可分辨效果；不给压缩触发点时取身份头里的
    main(["calibration", "--results", str(f), "--out", str(tmp_path / "c2")])
    cal2 = json.loads((tmp_path / "c2" / "result.json").read_text(encoding="utf-8"))["calibration"]
    assert cal2["designSensitivity"]["mde"] is None
    assert cal2["designSensitivity"]["v"] is not None
    assert cal2["contextPeak"]["compactionTrigger"] == 983_616


def test_cli_calibration_hits_double_caps(tmp_path):
    tasks = sample_tasks(range(1, 60))
    f = write_run(tmp_path / "run", calibration_rows(tasks, hit_step=True, hit_review=True))
    main(["calibration", "--results", str(f), "--out", str(tmp_path / "c")])
    cal = json.loads((tmp_path / "c" / "result.json").read_text(encoding="utf-8"))["calibration"]
    assert (cal["stepBudget"]["turns"], cal["stepBudget"]["wallMinutes"]) == (600, 120)
    assert cal["stepBudget"]["hitSteps"] == {"01": 2}
    assert (cal["reviewCap"]["turns"], cal["reviewCap"]["wallMinutes"]) == (80, 30)


def test_cli_calibration_retest_prompt_format(tmp_path):
    # 用例名题面的复测：身份头的题面格式为 test-cases
    tasks = sample_tasks(range(1, 60))
    f = write_run(tmp_path / "run", calibration_rows(tasks),
                  ident=identity(("search-only", "search-push", "minimal"), prompt_format="test-cases"))
    main(["calibration", "--results", str(f), "--out", str(tmp_path / "c")])
    cal = json.loads((tmp_path / "c" / "result.json").read_text(encoding="utf-8"))["calibration"]
    assert cal["difficultyGate"]["promptFormat"] == "test-cases"
    assert cal["difficultyGate"]["decision"] in ("start-with-test-cases", "owner-decides", "retest-above-range")


def test_cli_rejects_missing_field(tmp_path):
    rows = formal_rows()
    del rows[3]["hitStepBudget"]
    f = write_run(tmp_path / "run", rows, ident=identity(FORMAL_CONDITIONS))
    with pytest.raises(ResultFieldError, match="hitStepBudget"):
        main(["formal", "--results", str(f), "--out", str(tmp_path / "o"), "--tasks", tasks_file(tmp_path)])
