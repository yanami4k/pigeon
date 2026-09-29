"""输出：一份 Markdown 报告与一份机器可读的 JSON。同一输入两次运行逐字相同。"""

from __future__ import annotations

import json
import math
import numbers
from typing import Any

import numpy as np

from . import constants as K
from .wording import LABELS, conclusion_sentences, exploratory_banner, fmt_p, interface_agreement_sentence, pp


def clean(x: Any) -> Any:
    """转成可稳定序列化的结构：浮点保留 10 位小数，NaN 与无穷记 null。"""
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, bool) or x is None or isinstance(x, str):
        return x
    if isinstance(x, numbers.Integral) and not isinstance(x, np.bool_):
        return int(x)
    if isinstance(x, np.bool_):
        return bool(x)
    try:
        f = float(x)
    except (TypeError, ValueError):
        return str(x)
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, 10)


def dumps(obj: Any) -> str:
    return json.dumps(clean(obj), ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def _ci(ci) -> str:
    return f"[{pp(ci[0])}, {pp(ci[1])}]" if ci else "—"


def _v(x, digits=1, scale=1.0) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—"
    return f"{x * scale:.{digits}f}"


def effect_table(p: dict[str, Any]) -> list[str]:
    """两个主效应的检验表（主判据与敏感性分析同一格式）。"""
    lines = ["| 效应 | 估计（百分点） | 95% 置信区间 | 双侧 p | Holm 门槛 | Holm 显著 | dz |", "|---|---|---|---|---|---|---|"]
    for name in ("push", "search"):
        e = p["effects"][name]
        lines.append(
            f"| {LABELS[name]} | {_v(e['estimate'], 1, 100)} | {_ci(e['ci'])} | "
            f"{fmt_p(e['p']) if e['p'] is not None else '—'} | {e['holmThreshold'] if e['holmThreshold'] is not None else '—'} | "
            f"{'是' if e['holmSignificant'] else '否'} | {_v(e['dz'], 2)} |"
        )
    return lines


def interface_lines(res: dict[str, Any]) -> list[str]:
    """敏感性分析一节（316）：清单汇总、剔除后无剩余用例的题、逐用例结果的来源与无法确定的行、检验表、结论与一致性。"""
    x = res["interfaceSensitivity"]
    sp = x["primary"]
    ls = x["list"]
    lines = ["## 敏感性分析：剔除接口不可猜的测试文件（决策 316）", ""]
    lines.append(
        f"- 清单（静态规则，看到正式结果之前入库）：{ls['tasks']} 道题中 {ls['tasksWithUnguessableFiles']} 道有接口不可猜的测试文件，"
        f"共 {ls['unguessableFiles']} 个文件；要做到的用例 {ls['failToPassCases']} 个中剔除 {ls['excludedCases']} 个")
    lines.append(f"- 剔除后无剩余用例、不进该分析的题 {len(x['noRemainingTasks'])} 道：{x['noRemainingTasks']}")
    lines.append(f"- 剔除用例的逐行结果：取自按保存的改动重判、与原结果行逐项一致的 {x['rejudgedRows']} 行，其余取自结果行的失败用例列表")
    if x["rejudgeInconsistent"]:
        lines.append("- 重判与原结果行不一致、未采用的行：" + "；".join(
            f"第 {r['task']} 题 {r['cell']} 第 {r['pass_no']} 遍（{'；'.join(r['mismatches']) or '无说明'}）"
            for r in x["rejudgeInconsistent"]))
    if x["undeterminedRows"]:
        lines.append(f"- 剔除用例的结果无法确定、从该分析中去掉的行 {len(x['undeterminedRows'])} 行：" + "；".join(
            f"第 {r['task']} 题 {r['cell']} 第 {r['pass_no']} 遍" for r in x["undeterminedRows"]))
    lines.append(f"- 有效题 {sp['nValid']} 道；缺失题 {len(sp['missingTasks'])} 道")
    lines.append("")
    lines += effect_table(sp)
    lines.append("")
    for name in ("push", "search"):
        lines.append(f"- 敏感性分析：{res['interfaceConclusions'][name]['text']}")
    lines.append(f"- {interface_agreement_sentence(x['agreement'])}")
    lines.append("")
    return lines


def formal_markdown(res: dict[str, Any]) -> str:
    p = res["primary"]
    s = res["secondary"]
    lines: list[str] = ["# 正式跑分析报告", ""]
    banner = exploratory_banner(p)
    if banner:
        lines += [f"> {banner}", ""]
    lines += ["## 结论（主判据）", ""]
    for name in ("push", "search"):
        lines.append(f"- {res['conclusions'][name]['text']}")
    if res.get("interfaceSensitivity") is not None:
        lines.append(f"- {interface_agreement_sentence(res['interfaceSensitivity']['agreement'])}（见敏感性分析一节）")
    lines.append("")
    lines += ["## 主判据明细", ""]
    lines.append(f"- 有效题 {p['nValid']} 道；要做到的为零的题 {len(p['fEmptyTasks'])} 道：{p['fEmptyTasks']}")
    lines.append(f"- 无法建立两类用例基线的题 {len(p['baselineUnavailableTasks'])} 道（排除在主判据之外）：{p['baselineUnavailableTasks']}")
    if p["missingTasks"]:
        lines.append("- 不进主判据的缺失题：" + "；".join(
            f"第 {m['task']} 题（{'、'.join(m['cellsWithoutResult'])} 无有效结果）" for m in p["missingTasks"]))
    lines.append(f"- 各格遍数：{p['passesPerCell']}")
    lines.append("")
    lines += effect_table(p)
    b = p["baseline"]
    top = int(K.CEILING_SCORE * 100)
    lines += [
        "",
        f"- 推送效果的基线（无推送的 00、01 两格）平均得分 {_v(b['push']['mean'], 1, 100)}%，相对提升约 {_v(b['push']['relative'], 1, 100)}%；"
        f"达到 {top}% 及以上为基线触顶：{'是' if b['push']['ceiling'] else '否'}。",
        f"- 检索效果的基线（不能检索的 00、10 两格）平均得分 {_v(b['search']['mean'], 1, 100)}%，相对提升约 {_v(b['search']['relative'], 1, 100)}%；"
        f"达到 {top}% 及以上为基线触顶：{'是' if b['search']['ceiling'] else '否'}。",
        "- 各格各遍平均得分（描述用）：" + "；".join(
            f"{c}：" + "、".join(f"第 {r} 遍 {_v(v, 1, 100)}" for r, v in sorted(rs.items()))
            for c, rs in sorted(p["cellPassScores"].items())),
        "",
        "## 稳健性分析（混合模型）",
        "",
    ]
    mm = p.get("mixedModel", {})
    if "error" in mm:
        lines.append(f"- 混合模型未拟合出结果：{mm['error']}；稳健性对照不可用，主结论照符号翻转检验。")
    elif mm and not mm["converged"]:
        lines.append("- 混合模型未收敛，稳健性对照不可用，主结论照符号翻转检验。")
        if mm["warnings"]:
            lines.append(f"- 拟合告警：{'；'.join(mm['warnings'])}")
    elif mm:
        for name in ("push", "search"):
            lines.append(
                f"- {LABELS[name]}：系数 {_v(mm['coef'][name], 1, 100)} 个百分点，p = {mm['p'][name]:.4f}，"
                f"Holm 显著：{'是' if mm['holmSignificant'][name] else '否'}"
            )
        lines.append(f"- 收敛：是；方差分量：{ {k: round(v, 6) for k, v in mm['varianceComponents'].items()} }")
        if mm["warnings"]:
            lines.append(f"- 拟合告警：{'；'.join(mm['warnings'])}")
        sens = p["sensitivity"]
        lines.append(f"- 与主检验方向或显著性不一致：{'是，结论对建模方式敏感' if sens['sensitive'] else '否'}")
    if res.get("interfaceSensitivity") is not None:
        lines += [""] + interface_lines(res)
    lines += [""] + settings_lines(res["input"]["settings"])
    lines += ["## 次要判据（探索性）", ""]
    lines.append(
        f"- 交互效应：{_v(s['interaction']['estimate'], 1, 100)} 个百分点，95% 置信区间 {_ci(s['interaction']['ci'])}（探索性）"
    )
    sol = s["solved"]
    lines.append("- 做成率：" + "；".join(f"{c} {_v(v, 1, 100)}%" for c, v in sorted(sol["rateByCell"].items())))
    for name in ("push", "search"):
        lines.append(f"  - {LABELS[name]}对做成率：{_v(sol[name]['estimate'], 1, 100)} 个百分点，95% 置信区间 {_ci(sol[name]['ci'])}（探索性）")
    kf = s["keepFailures"]
    lines.append("- 不许挂一类的失败：" + "；".join(
        f"{c} 合计 {_v(x['total'], 0)}、每步 {_v(x['meanPerStep'], 2)}、有失败的步 {x['stepsWithFailures']}"
        for c, x in sorted(kf["byCell"].items())))
    for name in ("push", "search"):
        est = kf[name]["estimate"]
        lines.append(f"  - {LABELS[name]}对每步失败数：{_v(est, 2)}，95% 置信区间 {_ci_raw(kf[name]['ci'])}（探索性）")
    lc = s["learningCurve"]
    for name in ("push", "search"):
        x = lc[name]
        lines.append(
            f"- 学习曲线（{LABELS[name]}）：斜率为 {_v(x['slope'], 1, 100)}（个百分点 / 从第 1 题到最后一题；95% 置信区间 {_ci(x['slopeCi'])}，探索性）；"
            f"后半段差 {_v(x['halfDifference'], 1, 100)} 个百分点"
        )
    vm = s["versusMinimal"]
    lines.append(f"- 各格对最简 agent（M 只有一遍，区间偏宽；共同题 {vm['n']} 道）：" + "；".join(
        f"{c} {_v(vm[c]['estimate'], 1, 100)}，{_ci(vm[c]['ci'])}" for c in K.CELLS))
    eff = s["efficiency"]
    for part, title in (("worker", "干活"), ("review", "复盘")):
        lines += ["", f"### 效率：{title}（各格中位数 / 90 分位）", ""]
        lines.append("| 指标 | " + " | ".join(K.CELLS + (K.MINIMAL,)) + " | 推送差中位数 | 检索差中位数 |")
        lines.append("|---" * (len(K.CELLS) + 4) + "|")
        for metric, per in eff[part]["byCell"].items():
            cells = [f"{_v(per[c]['median'], 2)} / {_v(per[c]['p90'], 2)}" if c in per else "—" for c in K.CELLS + (K.MINIMAL,)]
            pm = eff[part]["pairedMedian"][metric]
            lines.append(f"| {METRIC_LABELS[metric]} | " + " | ".join(cells) + f" | {_v(pm['push'], 2)} | {_v(pm['search'], 2)} |")
    lines.append("")
    lines.append("- 干活的花费为网关计量的 gateway.costCny（已减去复盘），复盘花费为 gateway.reviewCostCny；复盘只在推送两格有，"
                 "其检索差中位数为 ȳ(11) − ȳ(10) 按题配对。")
    lines += memory_usage_lines(s["memoryUsage"], res["input"])
    tp = res.get("thirdPass")
    if tp is not None:
        lines += ["", "## 第 3 遍补跑判定（只看预算与波动）", ""]
        lines.append(f"- v = {_v(tp['v'], 6)}；剩余预算 B = {_v(tp.get('remaining'), 2)} 元；C3 = {_v(tp.get('c3'), 2)} 元")
        lines.append(spent_line({"gatewayCny": tp.get("spentGateway"), "rowsCny": tp.get("spentRows"),
                                 "difference": tp.get("spentDifference")}))
        for name in ("push", "search"):
            r = tp["byEffect"].get(name)
            if r:
                lines.append(f"- {LABELS[name]}：τ² = {_v(r['tau2'], 6)}，第 3 遍可把最小可分辨效果降低 {_v(r['reduction'], 1, 100)}%")
        d = tp.get("decision")
        lines.append(f"- 判定：{'补第 3 遍' if d else ('不补' if d is False else '无法判定（' + tp.get('reason', '') + '）')}")
    lines += [""] + input_lines(res["input"], res.get("verifyToolFaults"))
    return "\n".join(lines)


def spent_line(sp: dict[str, Any]) -> str:
    """已花的并列写法：网关累计（口径，含作废的步与开跑前探测）、结果行合计与二者之差。"""
    return (f"- 已花（各输出目录网关累计之和，含作废的步与开跑前探测）{_v(sp.get('gatewayCny'), 4)} 元；"
            f"结果行合计 {_v(sp.get('rowsCny'), 4)} 元；二者之差 {_v(sp.get('difference'), 4)} 元")


def _ci_raw(ci) -> str:
    return f"[{ci[0]:.2f}, {ci[1]:.2f}]" if ci else "—"


GATE_TEXT = {
    "stay": "留在 strands（以测试文件路径题面开跑）",
    "switch-repo": "高于 80%，按 197 换仓",
    "retest-with-test-cases": "低于 30%，切为给用例名，01 格在同 15 道题上再跑两遍复测",
    "start-with-test-cases": "用例名题面复测落进 30%–80%，以用例名题面开跑",
    "owner-decides": "用例名题面复测仍低于 30%，交项目负责人另定",
    "retest-above-range": "用例名题面复测高于 80%，计划未规定，交项目负责人裁决",
    None: "无数据",
}
COST_TEXT = {"go": "按计划开跑", "go-third-pass-unlikely": "开跑，事先说明第 3 遍基本无望",
             "owner-decides": "超出 ¥650，不自动删减条件或改跑法，交项目负责人裁决", None: "数据不全"}
CANDIDATE_TEXT = {"raise-budget": "加预算", "off-peak-only": "只在非高峰时段跑", "skip-minimal": "最简 agent 不跑"}


def _cap_lines(title: str, cap: dict[str, Any], what: str) -> list[str]:
    hit = cap.get("hitTemporaryCap")
    temp = cap["temporary"]
    if hit is None:
        verdict = f"结果行没有{what}的撞上限标记，未判"
    elif hit:
        verdict = f"撞了临时上限，正式取两倍：{cap['turns']} 轮、{cap['wallMinutes']} 分钟（报告注明）"
    else:
        verdict = f"没有撞临时上限，正式维持 {cap['turns']} 轮、{cap['wallMinutes']} 分钟"
    return [f"## {title}", "",
            f"- 临时上限 {temp['turns']} 轮、{temp['wallMinutes']} 分钟；以结果行的撞上限标记为准，只上调不下调",
            f"- 撞上限的步：{cap.get('hitSteps')}；实测最大 {_v(cap.get('maxTurns'), 0)} 轮、{_v(cap.get('maxWallMinutes'), 1)} 分钟（只作记录）",
            f"- 判定：{verdict}", ""]


def calibration_markdown(res: dict[str, Any]) -> str:
    c = res["calibration"]
    lines = ["# 校准分析报告", "", "校准结果不进正式结论。", ""]
    lines += settings_lines(res["input"]["settings"])
    dg = c["difficultyGate"]
    by_pass = "、".join(f"第 {k} 遍 {_v(v, 1, 100)}%" for k, v in sorted((dg.get("byPass") or {}).items()))
    lines += ["## 5.1 难度关", "",
              f"- 题面格式：{dg.get('promptFormat') or '未知'}",
              f"- 01 格两遍平均部分得分 {_v(dg.get('meanScore'), 1, 100)}%（{dg.get('steps', 0)} 个步结果、{dg.get('tasks', 0)} 道题；"
              f"要做到的为零的步不计入），各遍 {by_pass or '—'}",
              f"- 判定：{GATE_TEXT[dg.get('decision')]}" + ("；两遍相差超过 20 个百分点，重跑波动大（仍按合计判）" if dg.get("largeRerunGap") else ""),
              f"- 做成率（描述，不参与去留）：{_v(dg.get('solvedRate'), 1, 100)}%", ""]
    co = c["cost"]
    rv = co.get("reviewPerStep") or {}
    lines += ["## 5.2 花费与能跑几遍", "",
              f"- 每步平均花费（含复盘）：01 {_v(co['c01'], 4)}、11 {_v(co['c11'], 4)}、M {_v(co['cM'], 4)} 元；"
              f"其中复盘每步平均：01 {_v(rv.get('01'), 4)}、11 {_v(rv.get('11'), 4)} 元；已折回非高峰价：{'是' if co['offpeakAdjusted'] else '否'}",
              f"- C_pass = {_v(co.get('cPass'), 2)}，C_M = {_v(co.get('cM_total'), 2)}，C_base = {_v(co.get('cBase'), 2)} 元"
              f"（≤ ¥{K.BUDGET_COMFORT_YUAN:.0f} 按计划开跑；≤ ¥{K.BUDGET_YUAN:.0f} 开跑但第 3 遍基本无望）",
              f"- 判定：{COST_TEXT[co.get('decision')]}"]
    if co.get("spent"):
        lines.append(spent_line(co["spent"]))
    if co.get("candidates"):
        lines.append("- 候选（交项目负责人裁决）：" + "；".join(CANDIDATE_TEXT[x] for x in co["candidates"]))
    lines.append("")
    cp = c["contextPeak"]
    if "stepsOverWarn" in cp:
        warn = (f"；压缩触发点 {_v(cp.get('compactionTrigger'), 0)}，超过其 80% 的步 {cp['stepsOverWarn']}"
                + ("，须报告项目负责人" if cp.get("warn") else ""))
    else:
        warn = "；未给压缩触发点，未做检查"
    lines += ["## 5.3 上下文峰值（只记录）", "",
              f"- 中位 {_v(cp.get('median'), 0)}、90 分位 {_v(cp.get('p90'), 0)}、最大 {_v(cp.get('max'), 0)}（{cp.get('n', 0)} 步）" + warn, ""]
    lines += _cap_lines("5.4 每步宽上限", c["stepBudget"], "每步")
    mc = c["memoryCap"]
    lines += ["## 5.5 记忆总量硬上限", "",
              f"- 按字符计；各遍每步平均增长 {mc['growthByPass']}（是否用了每步复盘后的大小：{mc['usedEndOfStepSizes']}）；"
              f"两遍相差超过一倍：{'是' if mc.get('passesDiverged') else '否'}"
              + ("；结果行没有字符数，未给上限" if mc.get("reason") == "memory-chars-missing" else ""),
              f"- 取用增长 {_v(mc.get('growthUsed'), 1)} × 30 → 取整 {_v(mc.get('rounded'), 0)} → 上限 {_v(mc.get('capChars'), 0)} 字符", ""]
    lines += _cap_lines("5.6 复盘上限", c["reviewCap"], "复盘")
    ds = c["designSensitivity"]
    lines += ["## 5.7 设计灵敏度", "",
              f"- 重跑波动 v = {_v(ds['v'], 6)}（01、11 两格各自按题算两遍差的方差的一半，再取简单平均），"
              f"因题而异 τ² = {_v(ds.get('tau2'), 6)}（配对题 {ds['nPaired']} 道；只用方差）",
              f"- 正式跑有效题 n = {ds['formalTasks'] if ds['formalTasks'] else '未给'}，k = {ds['k']}：" + (
                  "；".join(f"R = {r} 时最小可分辨效果约 {pp(m)} 个百分点" for r, m in ds["mde"].items()) if ds.get("mde")
                  else "未算（须给出正式跑有效题数，或方差不可估）"),
              "- 校准的记忆轨迹只有 15 道题，可能低估波动。", ""]
    ts = c.get("temporarySettings")
    if ts is not None:
        yes = {k: ("是" if v else "否") for k, v in ts["matches"].items()}
        lines += ["## 临时值核对", "",
                  f"- 身份头与计划的临时值一致：每步上限 {yes['stepBudget']}，复盘上限 {yes['reviewBudget']}，记忆上限 {yes['memoryLimitChars']}", ""]
    if "sampleCheck" in c:
        sc = c["sampleCheck"]
        lines += ["## 抽题核对", "", f"- 按种子 {K.SAMPLE_SEED} 应抽 {sc['expected']}；与结果中的题一致：{'是' if sc['matches'] else '否'}", ""]
    lines += input_lines(res["input"], None)
    return "\n".join(lines)


METRIC_LABELS = {
    "turns": "轮数",
    "input_miss": "输入 token（未命中）",
    "input_hit": "输入 token（命中）",
    "output_tokens": "输出 token",
    "wall_ms": "墙钟（毫秒）",
    "cost": "花费（元）",
    "review_turns": "轮数",
    "review_input_miss": "输入 token（未命中）",
    "review_input_hit": "输入 token（命中）",
    "review_output": "输出 token",
    "review_tokens": "token 合计",
    "review_wall_ms": "墙钟（毫秒）",
    "review_cost": "花费（元）",
}

MEMORY_LABELS = {
    "memory_entries_after": "每步复盘后的条数",
    "memory_chars_after": "每步复盘后的字符数",
    "mem_worker_add": "干活写入：新增",
    "mem_worker_replace": "干活写入：改写",
    "mem_worker_remove": "干活写入：删除",
    "mem_review_add": "复盘写入：新增",
    "mem_review_replace": "复盘写入：改写",
    "mem_review_remove": "复盘写入：删除",
    "mem_worker_rejected_full": "干活写满被拒",
    "mem_review_rejected_full": "复盘写满被拒",
    "mem_citations": "回复里标出记忆编号的次数",
    "mem_cited_entries": "标出的条目数（每步去重）",
    "mem_basis_citations": "其中写成“依据 [L编号]”的次数",
    "mem_basis_cited_entries": "“依据”涉及的条目数（每步去重）",
    "mem_ref_reads": "读取记忆所引文件的次数（旁证）",
    "review_closing": "收尾复盘次数",
    "review_pre_compaction": "压缩前复盘次数",
    "review_cost": "复盘花费（元）",
    "search_calls_search_sessions": "search_sessions 调用次数",
    "search_calls_read_session_entry": "read_session_entry 调用次数",
    "search_sessions_hit": "命中会话数（每步去重）",
}


def _count_cell(x: dict[str, Any] | None) -> str:
    if not x:
        return "无来源"
    total = x["total"]
    return f"{_v(total, 0 if float(total).is_integer() else 2)} / {_v(x['meanPerStep'], 2)}"


def memory_usage_lines(mu: dict[str, Any], info: dict[str, Any]) -> list[str]:
    lines = ["", "### 记忆使用（探索性）", ""]
    avail = [v.get("available") for v in (info.get("sessions") or [])]
    if not avail or not all(avail):
        lines.append("- 会话文件不可用（输出目录没有 streams/），取自会话文件的计数记为无来源。")
    push_cells = sorted(mu["push"])
    if push_cells:
        lines += ["推送两格（计数为合计 / 每步平均；每步复盘后的大小为平均 / 中位 / 最大）：", ""]
        lines.append("| 项 | " + " | ".join(push_cells) + " |")
        lines.append("|---" * (len(push_cells) + 1) + "|")
        for col in mu["items"]["push"]:
            cells = []
            for c in push_cells:
                x = mu["push"][c][col]
                if col.startswith("memory_"):
                    cells.append(f"{_v(x['mean'], 0)} / {_v(x['median'], 0)} / {_v(x['max'], 0)}" if x else "无来源")
                else:
                    cells.append(_count_cell(x))
            lines.append(f"| {MEMORY_LABELS[col]} | " + " | ".join(cells) + " |")
        lines.append("")
        for c in push_cells:
            ends = mu["push"][c]["endOfPass"]
            text = "；".join(f"第 {p} 遍（第 {e['task']} 题后）{_v(e['entries'], 0)} 条、{_v(e['chars'], 0)} 字符"
                            for p, e in sorted(ends.items()))
            lines.append(f"- {c} 各遍结束时的记忆：{text or '无'}")
    search_cells = sorted(mu["search"])
    if search_cells:
        lines += ["", "检索两格（合计 / 每步平均）：", ""]
        lines.append("| 项 | " + " | ".join(search_cells) + " |")
        lines.append("|---" * (len(search_cells) + 1) + "|")
        for col in mu["items"]["search"]:
            lines.append(f"| {MEMORY_LABELS[col]} | " + " | ".join(_count_cell(mu["search"][c][col]) for c in search_cells) + " |")
    lines += ["", "- 写入次数只数写成功的；标出记忆编号按干活的 agent 回复正文里的 [L编号] 计，另报其中写成“依据 [L编号]”的；"
              "读取所引文件按 read_file 的路径与开工时记忆各条目的引用文件比对；检索计数只数干活的会话。"]
    return lines


def settings_lines(settings: list[dict[str, Any]]) -> list[str]:
    """设置一节：身份头里的题面格式、每步上限、模型设定、压缩配置、记忆上限、复盘模板与复盘上限。"""
    lines = ["## 设置（身份头）", ""]
    for st in settings:
        sb = st["stepBudget"]
        lines.append(f"- 身份摘要 {st['digest']}：仓库 {st['repo']}；条件 {st['conditions']}；题面格式 {st['promptFormat']}")
        lines.append(f"  - 每步上限 {sb['maxTurns']} 轮、{sb['wallClockMs'] / 60_000:g} 分钟")
        if st.get("model"):
            m = st["model"]
            lines.append(f"  - 模型 {m['provider']}/{m['modelId']}，温度 {m['temperature']}，思考 {m['thinking']}，"
                         f"单次输出上限 {m['maxOutputTokens']}")
        if st.get("compaction"):
            cp = st["compaction"]
            lines.append(f"  - 压缩：窗口 {cp['contextWindow']}、预留 {cp['reserveTokens']}、保留最近 {cp['keepRecentTokens']}、"
                         f"触发点 {cp['thresholdTokens']} token")
        if st.get("reviewBudget"):
            rb = st["reviewBudget"]
            lines.append(f"  - 记忆上限 {st['memoryLimitChars']} 字符；复盘模板 {st['reviewTemplate']}；"
                         f"复盘上限 {rb['maxTurns']} 轮、{rb['wallClockMs'] / 60_000:g} 分钟")
    lines.append("")
    return lines


def input_lines(info: dict[str, Any], faults: dict[str, Any] | None) -> list[str]:
    lines = ["## 输入", "", f"- 读入结果行 {info['rows']} 条，规整表记录 {info['records']} 条",
             f"- 结果行里整列为空的字段：{info['fieldsAbsent']}"]
    # 会话文件按输出目录逐个列出（摘要可以相同）；多于一个目录时另列各目录相加的合计
    sessions = info.get("sessions") or []
    for s in sessions:
        where = f"目录 {s['dir']}，摘要 {s['digest']}"
        if s.get("available"):
            lines.append(f"- 会话文件（{where}）：{s['jobs']} 个作业、{s['sessionFiles']} 个会话文件")
        else:
            lines.append(f"- 会话文件（{where}）：不可用（{s.get('reason')}）")
    usable = [s for s in sessions if s.get("available")]
    if len(sessions) > 1:
        lines.append(f"- 会话文件合计（{len(usable)} 个可用目录相加）：{sum(s['jobs'] for s in usable)} 个作业、"
                     f"{sum(s['sessionFiles'] for s in usable)} 个会话文件")
    if faults is not None:
        lines.append("- 验证工具故障次数（各格合计）：" + ("；".join(f"{c} {_v(v, 0)}" for c, v in sorted(faults.items())) or "无"))
    lines.append("")
    return lines


def formal_result(primary, secondary, third_pass, input_info, verify_tool_faults=None,
                  interface=None) -> dict[str, Any]:
    return {
        "kind": "formal",
        "interfaceSensitivity": interface,
        "interfaceConclusions": conclusion_sentences(interface["primary"]) if interface is not None else None,
        "verifyToolFaults": verify_tool_faults,
        "primary": primary,
        "secondary": secondary,
        "conclusions": conclusion_sentences(primary),
        "thirdPass": third_pass,
        "input": input_info,
        "seeds": {"permutation": K.PERMUTATION_SEED, "bootstrap": K.BOOTSTRAP_SEED},
    }
