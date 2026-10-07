"""对比评测的固定措辞与报告（分析计划第 4 节；404）：按结果自动选用对应句式，不另作解释；花费单独成句，不与得分合并，不写"更好"。"""

from __future__ import annotations

import json
from typing import Any

from . import constants as K
from .comparative import EFFICIENCY_METRICS, GROUP_D, GROUP_P, GROUPS
from .comparative_sources import MECHANISM_COLUMNS
from .report import _ci, _v
from .wording import fmt_p, pp

GROUP_TEXT = {GROUP_P: "Pigeon", GROUP_D: "对照 harness"}

# 主判据指标（404①）：报告里的名称与结论句式里的说法（做成与否时把"要做到的用例通过比例"换成"做成率"）
METRIC_NAME = {"score": "部分得分", "solved": "做成与否"}
METRIC_PHRASE = {"score": "要做到的用例通过比例", "solved": "做成率"}
# 降为次要判据的质量指标（与主判据相对的那个）在次要判据一节的说法
QUALITY_LABEL = {"solved": "做成与否：做成率", "partialScore": "部分得分：平均"}

# 主结论的四种句式
P_BETTER = "significant-p-better"
D_BETTER = "significant-d-better"
EQUIVALENT = "equivalent"
NOT_DETECTED = "not-detected"

COUNT_TEXT = {1: "一", 2: "两", 3: "三"}


def passes_text(passes: dict[str, int]) -> str:
    vals = sorted(set(passes.values()))
    if len(vals) == 1:
        return f"{COUNT_TEXT.get(vals[0], vals[0])}遍"
    return f"{vals[0]}–{vals[-1]} 遍"


def classify(effect: dict[str, Any], significant: bool | None = None) -> str:
    """显著按方向分 P 更好、D 更好；不显著时区间落在 ±M 以内为两组相当，否则为未测出差别。
    significant 缺省取 effect["significant"]；与每题花费两项按 Holm 两步判定时（404②），先由调用方把判定结果写进该键。"""
    sig = effect["significant"] if significant is None else significant
    if sig:
        return P_BETTER if effect["estimate"] > 0 else D_BETTER
    return EQUIVALENT if effect["ciWithinMde"] else NOT_DETECTED


def conclusion(primary: dict[str, Any]) -> dict[str, str]:
    """主结论一句（句式里的指标说法按主判据选定换，404①）；两组平均部分得分都 ≥ 90% 时加"（两组都接近满分）"，
    与混合模型方向或显著性不一致时注明对建模敏感。"""
    e = primary["effect"]
    if e["estimate"] is None:
        return {"kind": "no-data", "text": "没有有效题，无法估计两组之差。"}
    head = f"在 {primary['nValid']} 道题、{passes_text(primary['passesPerGroup'])}下，"
    ci = f"95% 置信区间 [{pp(e['ci'][0])}, {pp(e['ci'][1])}]"
    mde = pp(e["mde"]) if e["mde"] is not None else "—"
    kind = classify(e)
    phrase = METRIC_PHRASE[primary["metric"]]
    if kind == P_BETTER:
        text = (f"{head}Pigeon 每步{phrase}比对照 harness 平均高 {pp(e['estimate'])} 个百分点"
                f"（{ci}；按题配对的符号翻转检验，{fmt_p(e['p'])}）。")
    elif kind == D_BETTER:
        text = (f"{head}Pigeon 每步{phrase}比对照 harness 平均低 {pp(-e['estimate'])} 个百分点"
                f"（{ci}；按题配对的符号翻转检验，{fmt_p(e['p'])}）。")
    elif kind == EQUIVALENT:
        text = (f"{head}两组相当：估计差 {pp(e['estimate'])} 个百分点（{ci}，落在本设计能分辨的最小差距 ±{mde} 个百分点"
                f"以内）。")
    else:
        text = (f"{head}未测出两组的差别：估计差 {pp(e['estimate'])} 个百分点（{ci}）；不能排除约 {mde} 个百分点以上的差距。")
    if primary["bothNearCeiling"]:
        text += "（两组都接近满分）"
    if primary.get("modelSensitive"):
        text += "结论对建模方式敏感，见稳健性分析。"
    return {"kind": kind, "text": text}


def exploratory_banner(primary: dict[str, Any]) -> str | None:
    if not primary["exploratory"]:
        return None
    return f"缺失题 {len(primary['missingTasks'])} 道，超过有效题 {primary['nValid']} 道的 10%，以下结论降格为探索性。"


def mixed_note(primary: dict[str, Any]) -> str | None:
    mm = primary.get("mixedModel")
    if not mm:
        return None
    if "error" in mm:
        return f"混合模型未拟合出结果（{mm['error']}），稳健性对照不可用，主结论照主检验。"
    if not mm["converged"]:
        return "混合模型未收敛，稳健性对照不可用，主结论照主检验。"
    return None


# ---------- 每题花费（关键次要判据，404②③） ----------

def _ci_yuan(ci: Any, digits: int = 3) -> str:
    return f"[{ci[0]:.{digits}f}, {ci[1]:.{digits}f}]" if ci else "—"


def _saving_view(cost: dict[str, Any]) -> tuple[float, tuple[float, float] | None]:
    """省钱一方的口径：配对差 dc = c(P) − c(D) 为负即 Pigeon 省；金额与区间都折成"省多少"的正数。"""
    est = float(cost["estimate"])
    ci = cost["ci"]
    if est < 0:
        return -est, ((-ci[1], -ci[0]) if ci else None)
    return est, (tuple(ci) if ci else None)


def cost_conclusion(kind: str, cost: dict[str, Any], significant: bool) -> str:
    """花费结论（404②③）：一律单独成句，不写"更好"。主判据不显著且区间落在 ±M 以内（两组相当）而花费显著时，
    用定稿句式"质量相当，[某组]每题平均省 X 元（Y%，95% 区间 [a, b]）"；其余情形照实报数值。"""
    if cost["estimate"] is None:
        return "每题花费：没有两组都有花费记录的有效题，无法比较。"
    if not significant:
        p_text = fmt_p(cost["p"]) if cost["p"] is not None else "p —"
        return (f"每题花费（非高峰折算）的配对差（Pigeon − 对照 harness）平均 {_v(cost['estimate'], 3)} 元"
                f"（95% 区间 {_ci_yuan(cost['ci'])}；按题配对的符号翻转检验，{p_text}），按 Holm 两步未达显著。")
    saver = GROUP_TEXT[GROUP_P] if cost["estimate"] < 0 else GROUP_TEXT[GROUP_D]
    x, ci = _saving_view(cost)
    pct = f"{abs(cost['relative']) * 100:.1f}%，" if cost["relative"] is not None else ""
    saving = f"{saver}每题平均省 {x:.3f} 元（{pct}95% 区间 {_ci_yuan(ci)}）"
    if kind == EQUIVALENT:
        return f"质量相当，{saving}。"
    return f"每题花费差异显著（Holm 两步）：{saving}。"


# ---------- 报告 ----------

METRIC_LABELS = {
    "cost_offpeak": "花费（元，按非高峰价折算）",
    "cost": "花费（元，实付，含高峰；参照）",
    "input_miss": "输入 token（未命中）",
    "input_hit": "输入 token（命中）",
    "output_tokens": "输出 token（含思考）",
    "wall_ms": "墙钟（分钟）",
    "turns": "请求数",
}
# 报告里的显示：（小数位，换算）；墙钟由毫秒换成分钟
METRIC_FORMAT = {"cost_offpeak": (3, 1.0), "cost": (3, 1.0), "wall_ms": (1, 1 / 60_000)}

MECH_LABELS = {
    "mech_search_calls": "search_sessions 调用次数",
    "mech_read_entry_calls": "read_session_entry 调用次数",
    "mech_list_calls": "list_sessions 调用次数",
    "mech_sessions_hit": "检索命中的会话数（每步去重）",
    "mech_workers": "派出的 worker 数",
    "mech_worktree_workers": "其中建工作树的 worker 数",
    "mech_prunes": "上下文裁剪次数",
    "mech_compactions": "上下文压缩次数",
    "mech_continuations": "截断续跑次数",
}


def _steps(xs: list[dict[str, Any]]) -> str:
    if not xs:
        return "无"
    return "、".join(f"第 {x['task']} 步第 {x['pass']} 遍" + (f"（{x['group']}）" if "group" in x else "") for x in xs)


def _short(x: Any, limit: int = 120) -> str:
    s = x if isinstance(x, str) else json.dumps(x, ensure_ascii=False, sort_keys=True)
    return s if len(s) <= limit else s[:limit] + "…"


def settings_lines(info: dict[str, Any]) -> list[str]:
    g = info["groups"]
    lines = ["## 设置（身份头）", "", f"- P 为 Pigeon 组（--group-a {g[GROUP_P]}），D 为对照组（--group-b {g[GROUP_D]}）"]
    for s in info["identities"]:
        wall = s["wallClockMs"] / 60_000 if s["wallClockMs"] is not None else None
        lines.append(f"- 目录 {s['dir']}，身份摘要 {s['digest']}：每步墙钟 {_v(wall, 0)} 分钟（两组都不限轮数）；"
                     f"选题 {_short(s['taskSelection'])}；高峰暂停 {_short(s['peakPause'])}；网关留存 {_short(s['gatewayRetention'])}；"
                     f"跑批器代码 {_short(s['harness'])}")
        for grp in GROUPS:
            a = s["agents"][grp]
            lines.append(f"  - {grp}：" + (f"产物或工具目录摘要 {a['digest']}，自报版本 {_short(a['selfReported'])}" if a
                                           else "身份头里没有这一组的段"))
    lines.append("")
    return lines


def input_lines(info: dict[str, Any]) -> list[str]:
    lines = ["## 输入", "", f"- 读入结果行 {info['rows']} 条，两组的题步记录 {info['records']} 条，其余条件的行 {info['ignoredRows']} 条（跳过）"]
    for s in info["spend"]:
        lines.append(f"- 目录 {s['dir']} 网关累计花费（含作废的步与开跑前探测）："
                     + (f"{_v(s['gatewayCny'], 4)} 元" if s.get("gatewayCny") is not None else f"缺（{s.get('missing')}）"))
    jobs = info["mechanismJobs"]
    if jobs and all(j.get("available") for j in jobs):
        lines.append(f"- Pigeon 组会话文件：{len(jobs)} 个作业、{sum(j['sessionFiles'] for j in jobs)} 个会话文件")
    else:
        lines.append("- Pigeon 组会话文件：未记录（作业目录里没有会话根），机制使用各项记为未记录")
    lines.append("")
    return lines


def primary_lines(p: dict[str, Any]) -> list[str]:
    e = p["effect"]
    lines = ["## 主判据明细", "",
             f"- 主判据指标：{METRIC_NAME[p['metric']]}（{METRIC_PHRASE[p['metric']]}；404①按试跑选定，--primary 显式给出）",
             f"- 有效题 {p['nValid']} 道：{p['validTasks']}",
             f"- 要做到的为空的步 {len(p['fEmptyTasks'])} 道（照常跑，不进主判据分母）：{p['fEmptyTasks']}",
             f"- 无法建立两类用例基线的步 {len(p['baselineUnavailableTasks'])} 道：{p['baselineUnavailableTasks']}"]
    if p["missingTasks"]:
        lines.append("- 不进主判据的缺失题：" + "；".join(
            f"第 {m['task']} 步（{'、'.join(m['cellsWithoutResult'])} 无有效结果）" for m in p["missingTasks"])
            + f"；占有效题 {_v(p['missingRatio'], 1, 100)}%")
    else:
        lines.append("- 缺失题：无")
    lines += [f"- 各组遍数：P {p['passesPerGroup'][GROUP_P]}、D {p['passesPerGroup'][GROUP_D]}", "",
              "| 项 | 值 |", "|---|---|",
              f"| 估计差 Δ（P − D，百分点） | {_v(e['estimate'], 1, 100)} |",
              f"| 95% 置信区间（按题自助法 {K.BOOTSTRAPS:,} 次） | {_ci(e['ci'])} |",
              f"| 双侧 p（按题配对的符号翻转 {K.PERMUTATIONS:,} 次） | {fmt_p(e['p']) if e['p'] is not None else '—'} |",
              f"| 显著（Holm 两步判定，见 Holm 一节；原始双侧 5% 为 {'是' if e.get('rawSignificant') else '否'}） | {'是' if e['significant'] else '否'} |",
              f"| dz = mean(d) ÷ sd(d) | {_v(e['dz'], 2)} |",
              f"| 相对差 Δ ÷ ȳ(D) 的平均 | {_v(e['relative'], 1, 100)}% |",
              f"| sd(d)（百分点） | {_v(e['sd'], 1, 100)} |",
              f"| 最小可分辨差距 M = 2.80 × sd(d) ÷ √n（百分点） | {_v(e['mde'], 1, 100)} |",
              f"| 区间落在 ±M 以内 | {'是' if e['ciWithinMde'] else '否'} |", "",
              f"- 两组平均{METRIC_NAME[p['metric']]}（有效题上 ȳ 的平均）：P {_v(p['groupMeans'][GROUP_P], 1, 100)}%、"
              f"D {_v(p['groupMeans'][GROUP_D], 1, 100)}%",
              f"- 两组平均部分得分（“两组都接近满分”的注记按部分得分，第 4 节）：P {_v(p['scoreGroupMeans'][GROUP_P], 1, 100)}%、"
              f"D {_v(p['scoreGroupMeans'][GROUP_D], 1, 100)}%；两组都 ≥ 90%：{'是' if p['bothNearCeiling'] else '否'}",
              "- 各组各遍平均得分（描述用）：" + "；".join(
                  f"{g}：" + "、".join(f"第 {r} 遍 {_v(v, 1, 100)}" for r, v in sorted(p["groupPassScores"][g].items()))
                  for g in GROUPS),
              f"- 随机种子：置换 {K.COMPARATIVE_PERMUTATION_SEED}，自助法 {K.COMPARATIVE_BOOTSTRAP_SEED}", ""]
    lines += ["## 稳健性分析（混合模型 y ~ 组 + (1|题) + (1|作业)）", ""]
    mm = p.get("mixedModel") or {}
    note = mixed_note(p)
    if note:
        lines.append(f"- {note}")
        if mm.get("warnings"):
            lines.append(f"- 拟合告警：{'；'.join(mm['warnings'])}")
    elif mm:
        lines.append(f"- 组系数（P − D）{_v(mm['coef'], 1, 100)} 个百分点，p = {mm['p']:.4f}，显著：{'是' if mm['significant'] else '否'}；"
                     f"收敛：是；方差分量 { {k: round(v, 6) for k, v in mm['varianceComponents'].items()} }，"
                     f"残差方差 {mm['residualVariance']:.6f}")
        if mm["warnings"]:
            lines.append(f"- 拟合告警：{'；'.join(mm['warnings'])}")
        lines.append(f"- 与主检验方向或显著性不一致：{'是，结论对建模方式敏感' if p['modelSensitive'] else '否'}")
    lines.append("")
    return lines


def secondary_lines(s: dict[str, Any]) -> list[str]:
    # 降为次要判据的质量指标：主判据为部分得分时是做成与否（solved），为做成与否时是部分得分（partialScore，404①）
    quality_key = "solved" if "solved" in s else "partialScore"
    sol = s[quality_key]
    kf, lc, eff, cv, mech = (s[k] for k in ("keepFailures", "learning", "efficiency", "capsAndVoids", "mechanisms"))
    lines = ["## 次要判据（探索性，p 值不做校正）", ""]
    lines.append(f"- {QUALITY_LABEL[quality_key]} P {_v(sol['rateByGroup'][GROUP_P], 1, 100)}%、D {_v(sol['rateByGroup'][GROUP_D], 1, 100)}%；"
                 f"配对差 {_v(sol['estimate'], 1, 100)} 个百分点，95% 置信区间 {_ci(sol['ci'])}，"
                 f"{fmt_p(sol['p']) if sol['p'] is not None else 'p —'}（{sol['n']} 道题）")
    kb = kf["byGroup"]
    lines.append("- 不许挂一类的失败：" + "；".join(
        f"{g} 合计 {_v(kb[g]['total'], 0)}、每步 {_v(kb[g]['meanPerStep'], 2)}、有失败的步 {kb[g]['stepsWithFailures']}"
        for g in GROUPS) + f"；配对差每步 {_v(kf['estimate'], 2)} 条，95% 置信区间 "
        + (f"[{kf['ci'][0]:.2f}, {kf['ci'][1]:.2f}]" if kf["ci"] else "—")
        + f"，{fmt_p(kf['p']) if kf['p'] is not None else 'p —'}")
    lines.append(f"- 随题目推进的变化（只作描述）：d(i) 对时间位置的斜率 {_v(lc['slope'], 1, 100)} 个百分点（从第一题到最后一题），"
                 f"95% 置信区间 {_ci(lc['slopeCi'])}；后半段差 {_v(lc['halfDifference'], 1, 100)} 个百分点")
    lines += ["", "### 花费与效率（每步中位数 / 90 分位；配对差为按题 P − D 的中位数）", "",
              "| 指标 | P | D | 配对差中位数 |", "|---|---|---|---|"]
    for m in EFFICIENCY_METRICS:
        per = eff["byGroup"][m]
        digits, scale = METRIC_FORMAT.get(m, (0, 1.0))
        cells = [f"{_v(per[g]['median'], digits, scale)} / {_v(per[g]['p90'], digits, scale)}" if g in per else "—"
                 for g in GROUPS]
        lines.append(f"| {METRIC_LABELS[m]} | " + " | ".join(cells) + f" | {_v(eff['pairedMedian'][m], digits, scale)} |")
    t = eff["totals"]
    lines += ["", "- 合计花费：" + "；".join(f"{g} 非高峰折算 {_v(t[g]['cost_offpeak'], 3)} 元、实付 {_v(t[g]['cost'], 3)} 元"
                                        for g in GROUPS), ""]
    lines += ["### 撞上限与作废", "", "| 项 | P | D |", "|---|---|---|"]
    voids = {g: ("未记录" if cv[g]["voids"] is None else str(cv[g]["voids"])) for g in GROUPS}
    for label, key in (("撞每步墙钟上限的步", "wallCapSteps"), ("以轮数上限收尾的步", "turnLimitSteps"),
                       ("结果行 hitStepBudget 为真的步（含请求数达到身份头轮数的标记，两组都不限轮数，只作参照）", "flaggedSteps"),
                       ("最终缺失的步", "missingSteps")):
        lines.append(f"| {label} | " + " | ".join(f"{len(cv[g][key])}：{_steps(cv[g][key])}" for g in GROUPS) + " |")
    lines.append(f"| 作废重做次数 | {voids[GROUP_P]} | {voids[GROUP_D]} |")
    lines += ["", "### Pigeon 的机制使用（只描述，不作因果解释）", ""]
    if not mech["available"]:
        lines.append("- 会话记录未记录：各项记为未记录。")
    lines += ["| 项 | 合计 / 每步平均 |", "|---|---|"]
    for col in MECHANISM_COLUMNS:
        x = mech["counts"].get(col)
        lines.append(f"| {MECH_LABELS[col]} | " + (f"{_v(x['total'], 0)} / {_v(x['meanPerStep'], 2)}" if x else "未记录") + " |")
    lines += ["", f"- worker 角色：{_short(mech['roles']) if mech['roles'] else '无'}；"
                  f"收尾状态：{_short(mech['settled']) if mech['settled'] else '无'}；作业目录里的工作树 {mech['worktreesOnDisk']} 个",
              "- 检索计数含主会话与 worker 会话；命中会话数取 search_sessions 结果里的会话号去重。", ""]
    return lines

# Holm 两步（404②）各项的说法
HOLM_ITEM_LABEL = {"primary": "主判据", "cost": "每题花费"}


def holm_lines(holm: dict[str, Any]) -> list[str]:
    """Holm 两步的步骤与判定：列出两项的 p、各自是否显著与每一步的比较。"""
    p, sig, keys = holm["p"], holm["significant"], holm["items"]
    lines = [f"## Holm 两步（{HOLM_ITEM_LABEL[keys[0]]}与{HOLM_ITEM_LABEL[keys[1]]}，总误报率 5%）", ""]
    lines.append("- 两项的 p：" + "；".join(
        f"{HOLM_ITEM_LABEL[k]} {fmt_p(p[i]) if p[i] is not None else '—（无有效题，按不显著）'}" for i, k in enumerate(keys)))
    order = sorted((i for i in range(2) if p[i] is not None), key=lambda i: (p[i], i))
    if not order:
        lines.append("- 两项都没有可检验的 p，均按不显著。")
    else:
        first = order[0]
        lines.append(f"- 第 1 步：较小的 p（{HOLM_ITEM_LABEL[keys[first]]}）≤ {K.ALPHA / 2}："
                     + ("是，该项显著，进入第 2 步" if sig[first] else "否，该项不显著；两项均不显著，不进入第 2 步"))
        if sig[first] and len(order) == 2:
            second = order[1]
            lines.append(f"- 第 2 步：较大的 p（{HOLM_ITEM_LABEL[keys[second]]}）≤ {K.ALPHA}："
                         + ("是，该项也显著" if sig[second] else "否，该项不显著"))
    lines.append("- 判定：" + "；".join(f"{HOLM_ITEM_LABEL[k]}显著：{'是' if sig[i] else '否'}" for i, k in enumerate(keys)))
    lines.append("")
    return lines


def cost_lines(cost: dict[str, Any], significant: bool) -> list[str]:
    """每题花费一节（404②）：c(g, i)、配对差与检验、相对差、缺用量的请求合计（大于 0 注明花费可能偏低）。"""
    lines = ["## 每题花费（关键次要判据）", "",
             "- c(g, i) 为该组该题各遍最终有效那次的网关花费（按非高峰价折算）的平均；dc(i) = c(P, i) − c(D, i)；"
             f"两组都有花费的有效题 {cost['n']} 道", "",
             "| 项 | 值 |", "|---|---|",
             f"| 每题平均花费 c(P)（元） | {_v(cost['groupMeans'][GROUP_P], 4)} |",
             f"| 每题平均花费 c(D)（元） | {_v(cost['groupMeans'][GROUP_D], 4)} |",
             f"| mean(dc)（元/题） | {_v(cost['estimate'], 4)} |",
             f"| 95% 置信区间（按题自助法 {K.BOOTSTRAPS:,} 次） | {_ci_yuan(cost['ci'], 4)} |",
             f"| 双侧 p（按题配对的符号翻转 {K.PERMUTATIONS:,} 次） | {fmt_p(cost['p']) if cost['p'] is not None else '—'} |",
             f"| 相对差 mean(dc) ÷ mean(c(D)) | {_v(cost['relative'], 1, 100)}% |",
             f"| 显著（Holm 两步） | {'是' if significant else '否'} |", ""]
    um = cost["usageMissing"]
    low = "；这些请求的用量与花费不在结果行里，花费可能偏低" if any(um[g] > 0 for g in GROUPS) else ""
    lines += [f"- 缺用量的请求（结果行网关一节的 usageMissing）：P 合计 {um[GROUP_P]} 次、D 合计 {um[GROUP_D]} 次{low}", ""]
    return lines

def comparative_markdown(res: dict[str, Any]) -> str:
    p = res["primary"]
    lines = ["# 对比评测分析报告", ""]
    banner = exploratory_banner(p)
    if banner:
        lines += [f"> {banner}", ""]
    lines += ["## 结论（主判据）", "",
              f"- 主判据：{METRIC_NAME[p['metric']]}（{METRIC_PHRASE[p['metric']]}）；依据试跑两组合并的平均部分得分 "
              f"{res['pilotScore'] * 100:.1f}%（404①：≥ 90% 用做成与否，否则用部分得分）",
              f"- {res['conclusion']['text']}"]
    note = mixed_note(p)
    if note:
        lines.append(f"- {note}")
    lines += [f"- {res['costSentence']}", ""]
    lines += holm_lines(res["holm"])
    lines += primary_lines(p)
    lines += cost_lines(res["costCriterion"], res["holm"]["significant"][1])
    lines += settings_lines(res["input"])
    lines += secondary_lines(res["secondary"])
    lines += input_lines(res["input"])
    return "\n".join(lines)


def comparative_result(primary: dict[str, Any], secondary: dict[str, Any], info: dict[str, Any],
                       *, cost: dict[str, Any], holm: dict[str, Any], pilot_score: float) -> dict[str, Any]:
    return {
        "kind": "comparative",
        "primaryMetric": primary["metric"],
        "pilotScore": pilot_score,
        "primary": primary,
        "secondary": secondary,
        "costCriterion": cost,
        "holm": holm,
        "conclusion": conclusion(primary),
        "costSentence": cost_conclusion(classify(primary["effect"]), cost, holm["significant"][1]),
        "input": info,
        "seeds": {"permutation": K.COMPARATIVE_PERMUTATION_SEED, "bootstrap": K.COMPARATIVE_BOOTSTRAP_SEED},
    }


# ---------- 试跑报告 ----------

def _yes(x: bool | None) -> str:
    return "是" if x else ("否" if x is not None else "—")


def pilot_markdown(res: dict[str, Any]) -> str:
    pl = res["pilot"]
    lines = ["# 对比评测试跑报告", "", "试跑结果不进正式结论；以下只看花费、上限与机制是否正常，不看两组得分之差。", ""]
    lines += settings_lines(res["input"])
    sel = pl["primarySelection"]
    lines += ["## 主判据选定（404①）", "",
              f"- 两组合并的平均部分得分 {_v(sel['mergedScore'], 1, 100)}%（{sel['steps']} 步；只看合并水平，不看两组之差）",
              "- 正式跑主判据：" + ("做成与否——comparative 给 --primary solved" if sel["primary"] == "solved"
                                   else "部分得分——comparative 给 --primary partial")
              + f"（合并平均 ≥ {_v(sel['ceiling'], 0, 100)}% 用做成与否，否则用部分得分）", ""]
    sc = pl["sampleCheck"]
    lines += ["## 5.1 抽题", "",
              (f"- 按种子 {K.PILOT_SAMPLE_SEED} 从所给的步里抽 {K.PILOT_TASKS} 道应为 {sc['expected']}，结果里的步 {sc['seen']}；"
               f"一致：{_yes(sc['matches'])}" if sc is not None else "- 未给 --eligible（要做到的不为空的题），未核对抽题"), ""]
    b = pl["budget"]
    lines += ["## 5.2 花费与预算", ""]
    for g in GROUPS:
        x = b["byGroup"][g]
        lines.append(f"- {g}：每步平均 {_v(x['meanOffpeak'], 4)} 元（非高峰折算，{x['steps']} 步），实付平均 {_v(x['meanActual'], 4)} 元；"
                     f"合计折算 {_v(x['totalOffpeak'], 4)} 元、实付 {_v(x['totalActual'], 4)} 元")
    lines += [f"- 正式跑预算 C = 79 × (cP + cD) × 2 × 1.2 = {_v(b['budget'], 2)} 元",
              f"- 实付与折算核对：按高峰价计的步 {len(b['peakBilledSteps'])} 个；实付不在折算 1–2 倍之间（价目对不上）的步："
              f"{_steps(b['priceMismatchSteps'])}",
              "- 以 DeepSeek 控制台账单核对网关计费（差异超过 5% 先查明再开正式跑）不在本脚本内，须另行核对。", ""]
    c = pl["stepCap"]
    lines += ["## 5.3 每步上限", "",
              f"- 身份头每步墙钟 {'、'.join(f'{m:g}' for m in c['wallClockMinutes'])} 分钟；与计划的 {K.PILOT_STEP_WALL_MIN} 分钟一致："
              f"{_yes(c['matchesPlan'])}",
              f"- 撞墙钟上限的步：{_steps(c['hitSteps'])}",
              f"- 以轮数上限收尾的步：{_steps(c['turnLimitSteps'])}",
              f"- 结果行仅因请求数达到身份头轮数而标为撞上限的步（两组都不限轮数，不算撞上限）：{_steps(c['flaggedOnlyByTurns'])}",
              "- 判定：" + ("有步撞了墙钟上限：先看这些步的轨迹，判断是在打转还是题确实做不完；打转先在产品里解决，"
                          f"确实做不完则正式跑上调到 {c['raisedMinutes']} 分钟并在报告里注明" if c["decision"] != "keep"
                          else f"没有步撞墙钟上限，正式跑维持 {K.PILOT_STEP_WALL_MIN} 分钟"), ""]
    lines += ["## 5.4 机制核对", "", "### 网关留存", "", "| 项 | P | D |", "|---|---|---|"]
    rt = pl["retention"]
    lo, hi = K.RETENTION_ESTIMATE_MIB
    rows = [
        ("有留存的步 / 尝试数", lambda x: f"{x['steps']} / {x['tries']}"),
        ("有网关计量却缺留存的步", lambda x: _steps(x["stepsWithoutRetention"])),
        ("每题体积 MiB（中位 / 90 分位 / 最大）", lambda x: (f"{x['sizeMiB']['median']:.2f} / {x['sizeMiB']['p90']:.2f} / "
                                                     f"{x['sizeMiB']['max']:.2f}") if x["sizeMiB"] else "—"),
        (f"体积不在估算 {lo}–{hi} MiB 内的步", lambda x: str(len(x["outsideEstimate"]))),
        ("作业共用的 blobs MiB", lambda x: f"{x['blobMiB']:.2f}"),
        ("请求数 / 存全量的 / 截断的", lambda x: f"{x['requests']} / {x['fullRequests']} / {x['truncatedRequests']}"),
        ("截断的回复", lambda x: str(x["truncatedReplies"])),
        ("回复状态", lambda x: _short(x["statuses"])),
        ("多轮请求的 400", lambda x: str(x["multiTurn400"])),
        ("回复里的思考块 / 其中签名为空的", lambda x: f"{x['thinkingBlocks']} / {x['thinkingEmptySignature']}"),
        ("请求里回传的思考块 / 其中签名为空的", lambda x: f"{x['echoedThinking']} / {x['echoedThinkingEmptySignature']}"),
        ("请求头里名字像鉴权的项", lambda x: str(x["sensitiveHeaders"])),
    ]
    for label, f in rows:
        lines.append(f"| {label} | {f(rt[GROUP_P])} | {f(rt[GROUP_D])} |")
    lines.append("")
    for g in GROUPS:
        ck = rt[g]["checks"]
        lines.append(f"- {g} 核对：每步都有留存 {_yes(ck['everyStepRetained'])}；回复思考块签名都非空 {_yes(ck['signaturesNonEmpty'])}；"
                     f"多轮请求没有 400 {_yes(ck['noMultiTurn400'])}；留存里没有鉴权头 {_yes(ck['noSensitiveHeaders'])}")
        if rt[g]["outsideEstimate"]:
            lines.append(f"  - 体积不在估算内的步（须说明原因）：" + "、".join(
                f"第 {x['task']} 步第 {x['pass']} 遍 {x['mib']:.2f} MiB" for x in rt[g]["outsideEstimate"]))
    lines.append("- 留存里的 key 不在本脚本核对范围（分析不读任何 key）；去鉴权头只按请求头的名字查。")
    w = pl["workers"]
    lines += ["", "### 容器里 Pigeon 派 worker", "",
              (f"- 派出 {_v(w['spawned'], 0)} 个；角色 {_short(w['roles']) if w['roles'] else '无'}；"
               f"收尾状态 {_short(w['settled']) if w['settled'] else '无'}" if w["available"]
               else "- 会话记录未记录")]
    wt = pl["worktrees"]
    lines += ["", "### 工作树占盘（决策 399）", ""]
    if wt["k"] is None:
        lines.append("- Pigeon 组没有会话记录，k 未测出")
    else:
        line = (f"- k = {wt['k']:.3f}（{wt['steps']} 步，每题派出的建工作树的 worker 平均数）；推算 k × 33 MB × 79 × 2 × 1.5 = "
                f"{wt['projectedBytes'] / 1e9:.2f} GB；作业目录里现有工作树 {wt['worktreesOnDisk']} 个")
        lines.append(line)
        if wt.get("freeGb") is None:
            lines.append("- 未给服务器剩余空间（--free-gb），未判")
        else:
            lines.append(f"- 剩余空间 {wt['freeGb']} GB 减 5 GB = {wt['allowedBytes'] / 1e9:.2f} GB；"
                         + ("超过：正式跑前改为跑批器判完一题即删该题的工作树，并在报告里注明" if wt["deleteAfterJudging"]
                            else "不超过：工作树照产品原样不自动删"))
    pk = pl["peakPause"]
    lines += ["", "### 高峰暂停", "",
              (f"- 暂停 {pk['pauses']} 次、恢复 {pk['resumes']} 次、未恢复 {pk['unresumed']} 次" if pk["covered"]
               else "- 试跑期间没有高峰暂停：跨进高峰时的停放与恢复未覆盖")
              + f"；按高峰价计的步 {pk['peakBilledSteps']} 个", ""]
    lines += ["## 作废与缺失", ""]
    for g in GROUPS:
        lines.append(f"- {g}：作废重做 {('未记录' if pl['voids'][g] is None else pl['voids'][g])} 次；缺失的步 {_steps(pl['missing'][g])}")
    lines.append("")
    lines += input_lines(res["input"])
    return "\n".join(lines)
