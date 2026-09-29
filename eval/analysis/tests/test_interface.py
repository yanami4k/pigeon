"""接口不可猜的敏感性分析（决策 316）：逐行剔除、剔除用例结果的来源、无剩余用例的题、与主判据并列的措辞。"""

import json
import math

import numpy as np
import pytest
from runner_fixture import identity, memory, runner_row, write_run

from pigeon_analysis.cli import main
from pigeon_analysis.interface import (
    adjusted_table,
    agreement,
    dropped_share,
    excluded_failed,
    read_unguessable,
)
from pigeon_analysis.table import make_table
from pigeon_analysis.wording import interface_agreement_sentence, interface_dropped_banner

A = [f"t/test_a.py::c{i}" for i in range(3)]
B = [f"t/test_b.py::c{i}" for i in range(3, 6)]
KEY = ("01", 11, 1)


class TestExcludedFailed:
    def test_rejudged_results_take_precedence(self):
        # 结果行的列表截断、定不了；重判的逐用例结果给出答案
        lists = {KEY: {"failed": ["t/test_0.py::x"], "complete": False}}
        assert excluded_failed(set(A), KEY, lists, {}) is None
        assert excluded_failed(set(A), KEY, lists, {KEY: [A[0], A[2], B[0]]}) == 2

    def test_complete_list(self):
        lists = {KEY: {"failed": [A[1], B[2]], "complete": True}}
        assert excluded_failed(set(A), KEY, lists, {}) == 1

    def test_truncated_list_decides_ids_up_to_its_last_entry(self):
        # 列表按编号排序、只截掉尾部：剔除用例的编号都不大于最后一条即可定
        lists = {KEY: {"failed": [A[0], B[0], B[1]], "complete": False}}
        assert excluded_failed(set(A), KEY, lists, {}) == 1
        lists = {KEY: {"failed": [A[0], A[1]], "complete": False}}
        assert excluded_failed(set(A), KEY, lists, {}) is None

    def test_no_row_information(self):
        assert excluded_failed(set(A), KEY, {}, {}) is None


def table(rows):
    return make_table([{"cell": c, "task": t, "pass_no": r, "f_total": ft, "f_passed": fp} for c, t, r, ft, fp in rows])


class TestAdjustedTable:
    def test_recompute_counts_and_score(self):
        df = table([("01", 11, 1, 6, 4), ("01", 12, 1, 6, 1)])
        lists = {KEY: {"failed": [A[1], B[2]], "complete": True}}
        adj, undetermined = adjusted_table(df, {11: set(A)}, lists)
        assert undetermined == []
        row = adj[adj["task"].eq(11)].iloc[0]
        # 剔除 3 条，其中失败 1 条、通过 2 条：总数 3，通过 4 − 2 = 2
        assert (row["f_total"], row["f_passed"]) == (3, 2)
        assert row["score"] == pytest.approx(2 / 3)
        # 没有剔除的题不动
        other = adj[adj["task"].eq(12)].iloc[0]
        assert (other["f_total"], other["f_passed"]) == (6, 1)

    def test_no_remaining_cases_needs_no_case_results(self):
        df = table([("01", 11, 1, 3, 1)])
        adj, undetermined = adjusted_table(df, {11: set(A)}, {})
        assert undetermined == []
        row = adj.iloc[0]
        assert row["f_total"] == 0 and math.isnan(row["score"])

    def test_undetermined_rows_are_dropped_and_listed(self):
        df = table([("01", 11, 1, 6, 4), ("01", 11, 2, 6, 5)])
        lists = {("01", 11, 2): {"failed": [B[0]], "complete": True}}
        adj, undetermined = adjusted_table(df, {11: set(A)}, lists)
        assert undetermined == [{"cell": "01", "task": 11, "pass_no": 1, "reason": "结果行没有失败用例列表"}]
        assert adj["pass_no"].tolist() == [2]

    def test_reasons(self):
        df = table([("01", 11, 1, 6, 4), ("01", 11, 2, 6, 4)])
        lists = {k: {"failed": [A[0]], "complete": False} for k in (("01", 11, 1), ("01", 11, 2))}
        _, undetermined = adjusted_table(df, {11: set(A)}, lists, {}, [("01", 11, 2)])
        assert [r["reason"] for r in undetermined] == [
            "结果行的失败用例列表截断（只记前 20 条），没有一致的重判结果",
            "重判与原结果行不一致、未采用，结果行的失败用例列表截断",
        ]


class TestDroppedShare:
    def rows(self, n_drop):
        # 四格第 11 题共 20 行可用：n_drop 行截断且定不了，其余齐全
        rows, lists = [], {}
        for k in range(20):
            cell, a = ("00", "01", "10", "11")[k % 4], k // 4 + 1
            rows.append((cell, 11, a, 6, 4))
            lists[(cell, 11, a)] = {"failed": [A[0]], "complete": k >= n_drop}
        return table(rows), lists

    @pytest.mark.parametrize("n_drop,warn", [(1, False), (2, True)])
    def test_threshold(self, n_drop, warn):
        df, lists = self.rows(n_drop)
        adj, undetermined = adjusted_table(df, {11: set(A)}, lists)
        share = dropped_share(adj, undetermined)
        # 1/20 = 5% 不算超过；2/20 = 10% 超过
        assert (share["dropped"], share["rows"], share["warn"]) == (n_drop, 20, warn)
        banner = interface_dropped_banner(share)
        assert (banner is not None) == warn
        if warn:
            assert banner.startswith("敏感性分析中剔除用例结果定不了、被去掉的行 2 行，占该分析所用 20 行的 10.0%，超过 5%。")

    def test_unjudged_rows_untouched(self):
        df = make_table([{"cell": "01", "task": 11, "pass_no": 1, "f_total": np.nan, "f_passed": np.nan}])
        adj, undetermined = adjusted_table(df, {11: set(A)}, {})
        assert undetermined == [] and math.isnan(adj.iloc[0]["f_total"])


def effect(est, sig):
    return {"estimate": est, "holmSignificant": sig}


class TestAgreement:
    def test_consistent(self):
        p = {"effects": {"push": effect(0.05, True), "search": effect(0.01, False)}}
        s = {"effects": {"push": effect(0.08, True), "search": effect(-0.02, False)}}
        a = agreement(p, s)
        assert a["consistent"] is True
        assert interface_agreement_sentence(a) == (
            "剔除接口不可猜的测试文件后，推送与检索两个效应的结论与主判据一致：结论不受题目格式影响。")

    def test_inconsistent(self):
        p = {"effects": {"push": effect(0.05, True), "search": effect(0.01, False)}}
        s = {"effects": {"push": effect(0.03, False), "search": effect(0.01, False)}}
        a = agreement(p, s)
        assert a["consistent"] is False
        assert a["byEffect"]["push"] == {"primary": "detected-positive", "sensitivity": "not-detected",
                                         "consistent": False}
        assert interface_agreement_sentence(a) == (
            "剔除接口不可猜的测试文件后，推送记忆（主判据：测出变好；敏感性分析：未测出改善）的结论与主判据不一致："
            "结论对题目格式敏感，以主判据为准。")


# ---------- 命令行：读清单与逐用例补充结果 ----------

N_TASKS = 12


def case_ids(seq):
    return [f"t{seq}/test_a.py::c{i}" for i in range(3)] + [f"t{seq}/test_b.py::c{i}" for i in range(3, 6)]


def unguessable_list(tmp_path, excluded_files):
    """excluded_files：{步序: [被判不可猜的文件]}；每题要做到的用例为 test_a 与 test_b 各 3 条。"""
    tasks = []
    for t in range(1, N_TASKS + 1):
        seq = 10 + t
        files = [{"file": f, "cases": 3, "triggers": [{"kind": "name", "module": "strands.x", "name": "_y", "line": 1,
                                                       "word": "_y"}],
                  "caseIds": [c for c in case_ids(seq) if c.startswith(f + "::")]}
                 for f in excluded_files.get(seq, [])]
        n = sum(f["cases"] for f in files)
        tasks.append({"seq": seq, "commit": f"c{seq}", "parent": f"p{seq}", "failToPass": 6, "excluded": n,
                      "remaining": 6 - n, "files": files, "unparsable": []})
    summary = {"tasks": N_TASKS, "tasksWithUnguessableFiles": len(excluded_files),
               "unguessableFiles": sum(len(v) for v in excluded_files.values()), "failToPassCases": 6 * N_TASKS,
               "excludedCases": sum(t["excluded"] for t in tasks),
               "tasksWithNoRemainingCases": sorted(t["seq"] for t in tasks if t["remaining"] == 0), "unparsableFiles": 0}
    p = tmp_path / "unguessable.json"
    p.write_text(json.dumps({"rule": "decisions 316", "summary": summary, "tasks": tasks}), encoding="utf-8")
    return str(p)


def rows_with_cases(seed=0, truncate=()):
    """每题 6 条要做到的用例，失败的为编号最大的 6 − k 条；truncate 里的（格、步序、遍）只记前 1 条失败用例（模拟截断）。"""
    rng = np.random.default_rng(seed)
    rows = []
    for t in range(1, N_TASKS + 1):
        seq = 10 + t
        ids = case_ids(seq)
        for cell in ("00", "01", "10", "11"):
            for a in (1, 2):
                k = int(rng.integers(0, 7))
                failed = ids[k:]
                shown = failed[:1] if (cell, seq, a) in truncate else failed
                extra = {"mem_start": memory(100), "mem_end": memory(180)} if cell[0] == "1" else {}
                row = runner_row(cell, seq, a, k, 6, **extra)
                row["judging"]["failedCases"]["failToPass"] = shown
                rows.append(row)
    return rows


def tasks_file(tmp_path):
    p = tmp_path / "tasks.json"
    p.write_text(json.dumps([10 + t for t in range(1, N_TASKS + 1)]), encoding="utf-8")
    return str(p)


def rejudge_line(cell, seq, attempt, failed, consistent=True):
    cond = {"00": "neither", "01": "search-only", "10": "push-only", "11": "search-push"}[cell]
    return {"condition": cond, "attempt": attempt, "seq": seq, "consistent": consistent, "complete": True,
            "mismatches": [] if consistent else ["要做到的通过数：原 1，重判 2"],
            "judging": {"failedCases": {"failToPass": failed, "passToPass": [], "truncated": False}}}


CONDS = ("neither", "search-only", "push-only", "search-push")


def run_formal(tmp_path, name, rows, extra):
    f = write_run(tmp_path / "run", rows, ident=identity(CONDS))
    out = tmp_path / name
    assert main(["formal", "--results", str(f), "--out", str(out), "--tasks", tasks_file(tmp_path), *extra]) == 0
    return json.loads((out / "result.json").read_text(encoding="utf-8")), (out / "report.md").read_text(encoding="utf-8")


def test_read_unguessable(tmp_path):
    u = read_unguessable(unguessable_list(tmp_path, {11: ["t11/test_a.py"], 12: ["t12/test_a.py", "t12/test_b.py"]}))
    assert u["excluded"] == {11: set(case_ids(11)[:3]), 12: set(case_ids(12))}
    assert u["remaining"][12] == 0 and u["remaining"][13] == 6


def test_cli_interface_sensitivity(tmp_path):
    # 第 12 题两个文件都不可猜：剔除后无剩余用例；第 11 题剔除 test_a；01 格第 11 题第 1 遍的失败列表被截断且定不了，
    # 由重判结果补上；另一行重判与原结果不一致，不采用（它的列表齐全，照样可定）
    truncate = {("01", 11, 1)}
    rows = rows_with_cases(truncate=truncate)
    ug = unguessable_list(tmp_path, {11: ["t11/test_a.py"], 12: ["t12/test_a.py", "t12/test_b.py"]})
    orig = next(r for r in rows if (r["condition"], r["seq"], r["attempt"]) == ("search-only", 11, 1))
    full_failed = case_ids(11)[orig["judging"]["failToPass"]["passed"]:]
    cases = tmp_path / "cases.jsonl"
    cases.write_text(
        json.dumps(rejudge_line("01", 11, 1, full_failed)) + "\n"
        + json.dumps(rejudge_line("10", 13, 2, [], consistent=False)) + "\n", encoding="utf-8")
    base, _ = run_formal(tmp_path, "plain", rows, [])
    res, md = run_formal(tmp_path, "sens", rows, ["--unguessable", ug, "--case-results", str(cases)])
    x = res["interfaceSensitivity"]
    # 主判据不受影响
    assert res["primary"] == base["primary"]
    assert x["noRemainingTasks"] == [12]
    assert x["rejudgedRows"] == 1
    assert x["undeterminedRows"] == []
    assert x["rejudgeInconsistent"] == [{"cell": "10", "task": 13, "pass_no": 2,
                                         "mismatches": ["要做到的通过数：原 1，重判 2"]}]
    sp = x["primary"]
    assert 12 in sp["fEmptyTasks"] and 12 not in sp["validTasks"]
    assert sp["nValid"] == base["primary"]["nValid"] - 1
    assert "holmSignificant" in sp["effects"]["push"] and "mixedModel" not in sp
    assert "## 敏感性分析：剔除接口不可猜的测试文件（决策 316）" in md
    assert "剔除后无剩余用例、不进该分析的题 1 道：[12]" in md
    assert "重判与原结果行不一致、未采用的行：第 13 题 10 第 2 遍" in md
    assert md.count("剔除接口不可猜的测试文件后，") == 2  # 结论一节与敏感性分析一节各一句
    # 同一输入两次运行逐字相同
    again, md2 = run_formal(tmp_path, "sens2", rows, ["--unguessable", ug, "--case-results", str(cases)])
    assert md2 == md and again == res


def test_cli_without_case_results_drops_undeterminable_rows(tmp_path):
    rows = rows_with_cases(truncate={("01", 11, 1)})
    orig = next(r for r in rows if (r["condition"], r["seq"], r["attempt"]) == ("search-only", 11, 1))
    ug = unguessable_list(tmp_path, {11: ["t11/test_a.py"]})
    res, md = run_formal(tmp_path, "o", rows, ["--unguessable", ug])
    k = orig["judging"]["failToPass"]["passed"]
    # 截断后只剩第一条失败用例（编号第 k 小的）：test_a 里还有编号比它大的（k < 2）才定不了
    reason = "结果行的失败用例列表截断（只记前 20 条），没有一致的重判结果"
    expected = [] if k >= 2 else [{"cell": "01", "task": 11, "pass_no": 1, "reason": reason}]
    x = res["interfaceSensitivity"]
    assert x["undeterminedRows"] == expected
    assert x["dropped"]["dropped"] == len(expected) and x["dropped"]["warn"] is False
    if expected:
        assert f"  - 第 11 题 01 第 1 遍：{reason}" in md


def test_cli_case_results_need_list(tmp_path):
    f = write_run(tmp_path / "run", rows_with_cases(), ident=identity(CONDS))
    with pytest.raises(ValueError, match="--unguessable"):
        main(["formal", "--results", str(f), "--out", str(tmp_path / "o"), "--tasks", tasks_file(tmp_path),
              "--case-results", str(tmp_path / "x.jsonl")])


def test_no_exclusions_reproduce_primary(tmp_path):
    rows = rows_with_cases()
    res, _ = run_formal(tmp_path, "o", rows, ["--unguessable", unguessable_list(tmp_path, {})])
    p, s = res["primary"], res["interfaceSensitivity"]["primary"]
    for name in ("push", "search"):
        for field in ("estimate", "ci", "p", "holmSignificant"):
            assert s["effects"][name][field] == p["effects"][name][field]
    assert res["interfaceSensitivity"]["agreement"]["consistent"] is True



def test_cli_dropped_rows_over_threshold_flagged(tmp_path):
    # 第 11 题四格两遍 8 行都是 0 通过、失败列表截断到只剩编号最小的一条：剔除的 test_a 里有更大的编号，全部定不了
    rows = rows_with_cases()
    for r in rows:
        if r["seq"] == 11:
            r["judging"]["failToPass"]["passed"] = 0
            r["judging"]["score"] = 0.0
            r["judging"]["solved"] = False
            r["judging"]["failedCases"]["failToPass"] = case_ids(11)[:1]
    ug = unguessable_list(tmp_path, {11: ["t11/test_a.py"]})
    res, md = run_formal(tmp_path, "o", rows, ["--unguessable", ug])
    d = res["interfaceSensitivity"]["dropped"]
    assert (d["dropped"], d["rows"], d["warn"]) == (8, 96, True)
    assert md.count("> **敏感性分析中剔除用例结果定不了、被去掉的行 8 行，占该分析所用 96 行的 8.3%，超过 5%。") == 2
    assert 11 not in res["interfaceSensitivity"]["primary"]["validTasks"]
