"""对比评测分析（comparative-eval-analysis-plan.md）：主判据与措辞的关键判定、主判据选定与每题花费（404）、
试跑取值规则、读输出目录的端到端。"""

import gzip
import json

import pytest

from pigeon_analysis import constants as K
from pigeon_analysis.cli import main
from pigeon_analysis.comparative import GROUP_D, GROUP_P, comparative_primary, holm_primary_cost
from pigeon_analysis.comparative_pilot import budget_rule, primary_selection
from pigeon_analysis.comparative_report import (EQUIVALENT, NOT_DETECTED, classify, conclusion, cost_conclusion,
                                                exploratory_banner)
from pigeon_analysis.table import make_table
from runner_fixture import SessionBuilder, identity, runner_row, write_job, write_run

FAST = dict(flips=2000, boots=500, with_mixed=False)


def table(p, d, passes=(1, 2)):
    """p、d 为每题得分列表（或 {(题, 遍): 得分}）：两组各遍同分，None 即该遍没有结果行。"""
    out = []
    for cell, scores in ((GROUP_P, p), (GROUP_D, d)):
        for t, s in enumerate(scores, start=1):
            for r in passes:
                v = s(r) if callable(s) else s
                if v is not None:
                    out.append({"cell": cell, "task": t, "pass_no": r, "f_total": 10, "f_passed": v * 10})
    return make_table(out)

# ---------- 主判据选定（404①） ----------

def test_primary_selection_threshold():
    # 两组合并的平均部分得分恰好 90%：主判据为做成与否（端点算 ≥）
    at = primary_selection(table([0.9], [0.9], passes=(1,)))
    assert at["primary"] == "solved" and at["mergedScore"] == pytest.approx(0.9) and at["steps"] == 2
    # 合并平均低于 90%：维持部分得分；只看合并水平，不看两组之差
    below = primary_selection(table([0.95], [0.84], passes=(1,)))
    assert below["primary"] == "partial" and below["mergedScore"] == pytest.approx(0.895)


def solved_table(p, d):
    """p、d：{(题, 遍): (做成与否, 得分)}。"""
    out = []
    for cell, spec in ((GROUP_P, p), (GROUP_D, d)):
        for (t, r), (sv, sc) in spec.items():
            out.append({"cell": cell, "task": t, "pass_no": r, "f_total": 10, "f_passed": sc * 10, "solved": sv})
    return make_table(out)


def test_solved_primary_averages_passes():
    # 做成与否作主判据：ȳ 取各遍做成与否的平均（0、0.5、1）
    res = comparative_primary(solved_table({(1, 1): (1, 1.0), (1, 2): (0, 0.5), (2, 1): (1, 1.0), (2, 2): (1, 1.0)},
                                           {(1, 1): (0, 0.5), (1, 2): (0, 0.5), (2, 1): (1, 1.0), (2, 2): (0, 0.5)}),
                              metric="solved", **FAST)
    assert res["perTask"]["d"] == pytest.approx([0.5, 0.5]) and res["effect"]["estimate"] == pytest.approx(0.5)
    # 显著时措辞把"要做到的用例通过比例"换成"做成率"
    all_solved = solved_table({(t, r): (1, 1.0) for t in range(1, 7) for r in (1, 2)},
                              {(t, r): (0, 0.5) for t in range(1, 7) for r in (1, 2)})
    text = conclusion(comparative_primary(all_solved, metric="solved", **FAST))["text"]
    assert "做成率" in text and "用例通过比例" not in text


# ---------- Holm 两步（404②） ----------

def holm_at(p_primary, p_cost):
    return holm_primary_cost({"effect": {"p": p_primary}}, {"p": p_cost})


def test_holm_two_step_order_and_thresholds():
    # 较小的 p > 0.025：两项都不显著，不进入第二步
    h = holm_at(0.04, 0.5)
    assert h["significant"] == [False, False] and h["thresholds"] == [0.025, None]
    # 主判据过第一步：花费按第二步 0.05 判，0.04 显著、0.06 不显著
    assert holm_at(0.01, 0.04)["significant"] == [True, True]
    assert holm_at(0.01, 0.06)["significant"] == [True, False]
    # 花费的 p 更小：花费先按 0.025 判，主判据第二步按 0.05 判
    h = holm_at(0.04, 0.01)
    assert h["significant"] == [True, True] and h["thresholds"] == [0.05, 0.025]


# ---------- 花费结论的措辞（404③） ----------

def cost(estimate, ci, relative, p):
    return {"n": 10, "groupMeans": {GROUP_P: 0.8, GROUP_D: 1.0}, "estimate": estimate, "ci": ci,
            "p": p, "relative": relative, "usageMissing": {GROUP_P: 0, GROUP_D: 0}}


def test_saving_sentence_only_when_equivalent_and_cost_significant():
    s = cost_conclusion(EQUIVALENT, cost(-0.2, [-0.3, -0.1], -0.2, 0.01), True)
    assert s == "质量相当，Pigeon每题平均省 0.200 元（20.0%，95% 区间 [0.100, 0.300]）。"
    # 花费显著但主判据不是"两组相当"：不出"质量相当"句，照实报省钱
    s2 = cost_conclusion(NOT_DETECTED, cost(-0.2, [-0.3, -0.1], -0.2, 0.01), True)
    assert "质量相当" not in s2 and "省 0.200 元" in s2
    # 花费不显著：不出省钱句
    s3 = cost_conclusion(EQUIVALENT, cost(-0.2, [-0.3, -0.1], -0.2, 0.4), False)
    assert "省" not in s3 and "未达显著" in s3
    # 对照组更省的方向；任何花费句子都不写"更好"
    s4 = cost_conclusion(EQUIVALENT, cost(0.25, [0.1, 0.4], 0.25, 0.01), True)
    assert s4.startswith("质量相当，对照 harness每题平均省 0.250 元（25.0%，95% 区间 [0.100, 0.400]）。")
    for x in (s, s2, s3, s4):
        assert "更好" not in x

# ---------- 主判据 ----------

def test_difference_is_pigeon_minus_control():
    p = [0.8 + 0.01 * (i % 3) for i in range(10)]
    res = comparative_primary(table(p, [0.5] * 10), **FAST)
    assert res["effect"]["estimate"] == pytest.approx(sum(p) / 10 - 0.5)
    assert res["effect"]["significant"]
    s = conclusion(res)
    assert s["kind"] == "significant-p-better" and "比对照 harness 平均高 30.9 个百分点" in s["text"]
    flipped = conclusion(comparative_primary(table([0.5] * 10, p), **FAST))
    assert flipped["kind"] == "significant-d-better" and "平均低 30.9 个百分点" in flipped["text"]


def test_missing_pass_counts_the_other_pass():
    # P 第 1 题第 2 遍没有结果行、第 1 遍为 1.0：该组该题只按第 1 遍计
    p = [lambda r: 1.0 if r == 1 else None] + [0.6] * 3
    res = comparative_primary(table(p, [0.5] * 4), **FAST)
    assert res["validTasks"] == [1, 2, 3, 4]
    assert res["perTask"]["d"][0] == pytest.approx(0.5)


def test_missing_over_ten_percent_is_exploratory():
    base = [0.5] * 10
    # 对照组两道题一遍有效结果都没有：缺失 2 道 > 有效 10 道的 10%
    res = comparative_primary(table(base + [0.5, 0.5], base + [None, None]), **FAST)
    assert res["validTasks"] == list(range(1, 11)) and len(res["missingTasks"]) == 2
    assert res["exploratory"] and "降格为探索性" in exploratory_banner(res)
    # 恰好 10%（缺 1 道）不降格
    assert not comparative_primary(table(base + [0.5], base + [None]), **FAST)["exploratory"]


def alternating(shift, n=40):
    return [0.5 + shift + (0.1 if i % 2 else -0.1) for i in range(n)]


def test_equivalent_only_when_interval_within_mde():
    same = comparative_primary(table(alternating(0.0), [0.5] * 40), **FAST)
    e = same["effect"]
    assert e["mde"] == pytest.approx(K.COMPARATIVE_MDE_Z_SUM * e["sd"] / 40 ** 0.5)
    assert not e["significant"] and e["ciWithinMde"]
    assert conclusion(same)["kind"] == EQUIVALENT and "两组相当" in conclusion(same)["text"]
    # 估计差约 1.4 个标准误：不显著，但区间上端超出 M → 未测出差别，写明不能排除约 M 以上的差距
    off = comparative_primary(table(alternating(0.0224), [0.5] * 40), **FAST)
    assert not off["effect"]["significant"] and not off["effect"]["ciWithinMde"]
    s = conclusion(off)
    assert s["kind"] == NOT_DETECTED and "未测出两组的差别" in s["text"] and "不能排除约" in s["text"]
    # 方向反过来（区间下端超出 −M）同样不是"两组相当"
    assert not comparative_primary(table([0.5] * 40, alternating(0.0224)), **FAST)["effect"]["ciWithinMde"]


def test_classify_uses_significance_before_interval():
    eff = dict(estimate=0.01, significant=False, ciWithinMde=False)
    assert classify(eff) == NOT_DETECTED
    assert classify({**eff, "ciWithinMde": True}) == EQUIVALENT
    assert classify({**eff, "significant": True}) == "significant-p-better"


def test_near_ceiling_note_needs_both_groups():
    both = comparative_primary(table([0.95, 0.96, 0.97], [0.95, 0.94, 0.93]), **FAST)
    assert both["bothNearCeiling"] and conclusion(both)["text"].endswith("（两组都接近满分）")
    one = comparative_primary(table([0.95, 0.96, 0.97], [0.89, 0.89, 0.89]), **FAST)
    assert not one["bothNearCeiling"] and "接近满分" not in conclusion(one)["text"]


# ---------- 试跑：预算 ----------

def test_budget_formula():
    df = make_table([{"cell": GROUP_P, "task": 1, "pass_no": 1, "cost_offpeak": 0.30, "cost": 0.30},
                     {"cell": GROUP_P, "task": 2, "pass_no": 1, "cost_offpeak": 0.50, "cost": 1.00},
                     {"cell": GROUP_D, "task": 1, "pass_no": 1, "cost_offpeak": 0.20, "cost": 0.20},
                     {"cell": GROUP_D, "task": 2, "pass_no": 1, "cost_offpeak": 0.10, "cost": 0.35}])
    b = budget_rule(df)
    # cP = 0.40、cD = 0.15：C = 79 × 0.55 × 2 × 1.2
    assert b["budget"] == pytest.approx(79 * 0.55 * 2 * 1.2)
    assert b["peakBilledSteps"] == [{"group": GROUP_P, "task": 2, "pass": 1}]
    assert b["priceMismatchSteps"] == [{"group": GROUP_D, "task": 2, "pass": 1}]


# ---------- 端到端：输出目录 → 两个子命令 ----------

PIGEON, CONTROL = "pigeon-docker", "ext-control"


def row(cond, seq, passed, *, cost=1.0, status="completed", wall=600_000, flagged=False, total=10):
    # 用量取整：100 万未命中输入 = 非高峰 1 元
    usage = {"input": 1_000_000, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 1_000_000}
    return runner_row("01", seq, 1, passed, total, cost=cost, condition=cond, usage=usage, status=status,
                      agentWallMs=wall, hitStepBudget=flagged)


def sse(signature):
    events = [{"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
              {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": signature}}]
    return "".join(f"data: {json.dumps(e)}\n" for e in events)


def write_retention(job, seq, exchanges, size_pad=0):
    """exchanges：[(消息条数, 状态, 回复里的签名)]；回传的历史思考块签名同回复。"""
    d = job / "gateway" / f"step-{seq}" / "try-1"
    d.mkdir(parents=True)
    reqs, resps, blob = [], [], b""
    for i, (count, status, sig) in enumerate(exchanges, start=1):
        delta = [{"role": "assistant", "content": [{"type": "thinking", "thinking": "t", "signature": sig}]}]
        reqs.append({"id": i, "headers": {"content-type": "application/json"},
                     "messages": {"count": count, "full": True, "delta": delta}})
        resp = {"id": i, "status": status}
        if status == 200:
            gz = gzip.compress(sse(sig).encode())
            resp["reply"] = {"bytes": 1, "slice": {"offset": len(blob), "length": len(gz)}}
            blob += gz
        resps.append(resp)
    (d / "requests.jsonl").write_text("".join(json.dumps(r) + "\n" for r in reqs), encoding="utf-8")
    (d / "responses.jsonl").write_text("".join(json.dumps(r) + "\n" for r in resps), encoding="utf-8")
    (d / "replies.gz").write_bytes(blob + b"\0" * size_pad)


def tries(job, sub, seq, n):
    for k in range(1, n + 1):
        (job / sub / f"step-{seq}" / f"try-{k}").mkdir(parents=True)


def custom(sb, ctype, data):
    return sb._entry(type="custom", customType=ctype, data=data)


@pytest.fixture
def run_dir(tmp_path):
    rows = [row(PIGEON, 1, 8), row(PIGEON, 2, 5, cost=2.0, status="wall-clock-limit", wall=3_600_000),
            row(PIGEON, 3, 0, total=0),
            row(CONTROL, 1, 6), row(CONTROL, 2, 5, flagged=True), row(CONTROL, 3, 0, total=0)]
    # 缺用量的请求（网关 usageMissing）：P 第 2 步 2 次、D 第 1 步 1 次
    rows[1]["gateway"]["usageMissing"] = 2
    rows[3]["gateway"]["usageMissing"] = 1
    ident = identity([PIGEON, CONTROL], pigeon=False, step_budget=(150, 3_600_000))
    ident["core"]["agents"]["pigeonDocker"] = {"bundleDigest": "bundle1", "selfReported": {"pigeon": "0.1"}}
    ident["info"]["peakPause"] = {"marginMs": 1_800_000}
    write_run(tmp_path, rows, ident)
    s1 = SessionBuilder("s1").run_start()
    s1.assistant(calls=[("c1", "search_sessions", {"keywords": ["x"]}), ("c2", "read_session_entry", {})])
    s1.result("c1", "search_sessions", {"groups": [{"sessionId": "old1"}, {"sessionId": "old2"}]})
    custom(s1, "pigeon.worker", {"event": "spawned", "role": "worker", "workspace": {"kind": "git-worktree"}})
    custom(s1, "pigeon.worker", {"event": "spawned", "role": "explorer", "workspace": {"kind": "shared"}})
    custom(s1, "pigeon.worker", {"event": "settled", "status": "completed"})
    custom(s1, "pigeon.prune", {}), custom(s1, "pigeon.continuation", {})
    s1._entry(type="compaction", summary="s")
    s2 = SessionBuilder("s2").run_start()
    custom(s2, "pigeon.worker", {"event": "spawned", "role": "worker", "workspace": {"kind": "git-worktree"}})
    job_p = write_job(tmp_path, PIGEON, 1, {1: [s1], 2: [s2], 3: []}, layout="state")
    job_d = tmp_path / "streams" / f"tasks-{CONTROL}-1"
    tries(job_p, "pigeon-docker", 1, 2), tries(job_p, "pigeon-docker", 2, 1), tries(job_p, "pigeon-docker", 3, 1)
    for s in (1, 2, 3):
        tries(job_d, "external", s, 1)
    write_retention(job_p, 1, [(1, 200, "sig"), (3, 200, "sig")], size_pad=1024 * 1024)
    write_retention(job_p, 2, [(1, 200, ""), (3, 400, "")])
    write_retention(job_p, 3, [(1, 200, "sig")])
    write_retention(job_d, 1, [(1, 200, "sig")])
    write_retention(job_d, 2, [(1, 200, "sig")])
    return tmp_path


def run_cli(run_dir, command, *extra):
    out = run_dir / command
    assert main([command, "--results", str(run_dir / "results.jsonl"), "--out", str(out),
                 "--group-a", PIGEON, "--group-b", CONTROL, *extra]) == 0
    return json.loads((out / "result.json").read_text(encoding="utf-8")), (out / "report.md").read_text(encoding="utf-8")


def test_pilot_end_to_end(run_dir):
    res, md = run_cli(run_dir, "comparative-pilot", "--free-gb", "11")
    pl = res["pilot"]
    # 主判据选定（404①）：合并平均 (0.8 + 0.5 + 0.6 + 0.5) / 4 = 0.6 < 90%，维持部分得分（F 为空的步得分记空、不计）
    assert pl["primarySelection"]["primary"] == "partial" and pl["primarySelection"]["mergedScore"] == pytest.approx(0.6)
    # cP = (1 + 1 + 1) / 3 元（非高峰折算），cD 同
    assert pl["budget"]["budget"] == pytest.approx(79 * 2.0 * 2 * 1.2)
    assert pl["budget"]["peakBilledSteps"] == [{"group": "P", "task": 2, "pass": 1}]
    cap = pl["stepCap"]
    assert cap["matchesPlan"] and cap["decision"] == "diagnose-trajectories"
    assert cap["hitSteps"] == [{"group": "P", "task": 2, "pass": 1}]
    assert cap["flaggedOnlyByTurns"] == [{"group": "D", "task": 2, "pass": 1}]
    # 三步派出建工作树的 worker 2 个：k = 2/3，推算 2/3 × 33 MB × 79 × 2 × 1.5 ≈ 5.2 GB ≤ 11 − 5 GB
    wt = pl["worktrees"]
    assert wt["k"] == pytest.approx(2 / 3) and wt["deleteAfterJudging"] is False
    assert wt["projectedBytes"] == pytest.approx(2 / 3 * 33e6 * 79 * 2 * 1.5)
    rp, rd = pl["retention"]["P"], pl["retention"]["D"]
    assert (rp["thinkingBlocks"], rp["thinkingEmptySignature"], rp["multiTurn400"]) == (4, 1, 1)
    assert rp["echoedThinkingEmptySignature"] == 2 and rp["checks"]["everyStepRetained"]
    assert not rp["checks"]["signaturesNonEmpty"] and not rp["checks"]["noMultiTurn400"]
    assert [x["task"] for x in rp["outsideEstimate"]] == [2, 3]
    assert rd["stepsWithoutRetention"] == [{"task": 3, "pass": 1}] and rd["checks"]["signaturesNonEmpty"]
    assert pl["voids"] == {"P": 1, "D": 0}
    assert pl["workers"]["roles"] == {"worker": 2, "explorer": 1} and pl["peakPause"]["covered"] is False
    for text in ("C = 79 × (cP + cD) × 2 × 1.2 = 379.20 元", "未覆盖", "不超过：工作树照产品原样不自动删",
                 "正式跑主判据：部分得分——comparative 给 --primary partial"):
        assert text in md
    assert "两组相当" not in md and "估计差" not in md


def test_comparative_end_to_end(run_dir):
    res, md = run_cli(run_dir, "comparative", "--primary", "partial", "--pilot-score", "0.6")
    p, s = res["primary"], res["secondary"]
    assert p["validTasks"] == [1, 2] and p["fEmptyTasks"] == [3]
    assert p["effect"]["estimate"] == pytest.approx(((0.8 - 0.6) + (0.5 - 0.5)) / 2)
    m = s["mechanisms"]["counts"]
    assert (m["mech_search_calls"]["total"], m["mech_read_entry_calls"]["total"], m["mech_sessions_hit"]["total"]) == (1, 1, 2)
    assert (m["mech_workers"]["total"], m["mech_worktree_workers"]["total"]) == (3, 2)
    assert (m["mech_prunes"]["total"], m["mech_compactions"]["total"], m["mech_continuations"]["total"]) == (1, 1, 1)
    cv = s["capsAndVoids"]
    assert cv["P"]["wallCapSteps"] == [{"task": 2, "pass": 1}] and cv["D"]["wallCapSteps"] == []
    assert s["efficiency"]["pairedMedian"]["cost_offpeak"] == pytest.approx(0.0)
    assert res["costSentence"].startswith("每题花费（非高峰折算）的配对差（Pigeon − 对照 harness）平均 0.000 元")
    assert res["costCriterion"]["usageMissing"] == {"P": 2, "D": 1} and res["holm"]["significant"] == [False, False]
    assert "## 结论（主判据）" in md and res["conclusion"]["text"] in md and "混合模型" in md
    for text in ("主判据：部分得分（要做到的用例通过比例）；依据试跑两组合并的平均部分得分 60.0%",
                 "## Holm 两步（主判据与每题花费，总误报率 5%）", "缺用量的请求（结果行网关一节的 usageMissing）："
                 "P 合计 2 次、D 合计 1 次；这些请求的用量与花费不在结果行里，花费可能偏低"):
        assert text in md
    assert "更好" not in res["costSentence"]


def test_comparative_solved_end_to_end(run_dir):
    # --primary solved：主判据为做成与否，部分得分降为次要判据照报（404①）
    res, md = run_cli(run_dir, "comparative", "--primary", "solved", "--pilot-score", "0.93")
    assert res["primaryMetric"] == "solved" and "partialScore" in res["secondary"] and "solved" not in res["secondary"]
    assert "主判据：做成与否（做成率）；依据试跑两组合并的平均部分得分 93.0%" in md
    assert "- 部分得分：平均" in md


def test_comparative_requires_explicit_primary(run_dir):
    with pytest.raises(SystemExit):
        main(["comparative", "--results", str(run_dir / "results.jsonl"), "--out", str(run_dir / "np"),
              "--group-a", PIGEON, "--group-b", CONTROL])


def test_group_without_rows_is_an_error(run_dir):
    with pytest.raises(ValueError, match="ext-other"):
        main(["comparative", "--results", str(run_dir / "results.jsonl"), "--out", str(run_dir / "x"),
              "--group-a", PIGEON, "--group-b", "ext-other", "--primary", "partial", "--pilot-score", "0.6"])
