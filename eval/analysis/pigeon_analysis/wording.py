"""报告的固定措辞（分析计划第 4 节）：按结果自动选用对应句式，不另作解释。"""

from __future__ import annotations

from typing import Any

from . import constants as K

LABELS = {"push": "推送记忆", "search": "可检索历史会话"}

# 句式类别
DETECTED_POSITIVE = "detected-positive"
DETECTED_NEGATIVE = "detected-negative"
NOT_DETECTED = "not-detected"


def pp(x: float) -> str:
    return f"{x * 100:.1f}"


def fmt_p(p: float, flips: int = K.PERMUTATIONS) -> str:
    if p == 0:
        return f"p < {1 / flips:.0e}".replace("e-0", "e-")
    return f"p = {p:.4f}" if p >= 0.0001 else f"p = {p:.1e}"


def fmt_passes(passes: dict[str, int]) -> str:
    vals = sorted(set(passes.values()))
    return str(vals[0]) if len(vals) == 1 else f"{vals[0]}–{vals[-1]}"


def rel_clause(rel: float | None, prefix: str) -> str:
    """相对提升：主效应 ÷ 对应基线两格的平均得分，与百分点并列；基线为 0 时不写。"""
    return f"，{prefix} {rel * 100:.1f}%" if rel is not None else ""


def classify(effect: dict[str, Any]) -> str:
    if effect["holmSignificant"] and effect["estimate"] is not None:
        return DETECTED_POSITIVE if effect["estimate"] > 0 else DETECTED_NEGATIVE
    return NOT_DETECTED


def conclusion_sentences(primary: dict[str, Any]) -> dict[str, dict[str, str]]:
    """两个主效应各一句结论；附加的"基线触顶""结论对建模敏感""探索性"按条件拼上。"""
    n = primary["nValid"]
    r = fmt_passes(primary["passesPerCell"])
    sens = primary.get("sensitivity", {}).get("byEffect", {})
    out: dict[str, dict[str, str]] = {}
    for name in ("push", "search"):
        e = primary["effects"][name]
        label = LABELS[name]
        if e["estimate"] is None:
            out[name] = {"kind": "no-data", "text": f"没有有效题，无法估计{label}的效果。"}
            continue
        kind = classify(e)
        base = primary["baseline"][name]
        rel = base["relative"]
        lo, hi = e["ci"]
        ci = f"95% 置信区间 [{pp(lo)}, {pp(hi)}]"
        if kind == DETECTED_POSITIVE:
            text = (
                f"在 {n} 道题、{r} 遍下，{label}使每步要做到的用例通过比例平均提高 {pp(e['estimate'])} 个百分点"
                f"{rel_clause(rel, '相对提升约')}"
                f"（{ci}；按题配对的符号翻转检验，Holm 校正后显著，{fmt_p(e['p'])}）。"
            )
        elif kind == DETECTED_NEGATIVE:
            text = (
                f"在 {n} 道题、{r} 遍下，{label}使每步要做到的用例通过比例平均降低 {pp(-e['estimate'])} 个百分点"
                f"{rel_clause(-rel if rel is not None else None, '相对降低约')}"
                f"（{ci}；按题配对的符号翻转检验，Holm 校正后显著，{fmt_p(e['p'])}）。"
            )
        else:
            mde = e["mdeFormal"]
            mde_s = pp(mde) if mde is not None else "—"
            text = (
                f"在 {n} 道题、{r} 遍下，未测出{label}的改善：估计差 {pp(e['estimate'])} 个百分点"
                f"{rel_clause(rel, '相对提升约')}（{ci}）。"
                f"本设计能以 80% 把握分辨的最小效果约为 {mde_s} 个百分点，因此不能排除小于约 {mde_s} 个百分点的效果。"
            )
            # 基线触顶（第 4 节、256、272）：推送效果看不带推送的 00、01，检索效果看不能检索的 00、10，
            # 对照组平均部分得分达到 90% 及以上即注明，各效应各自判；只挂在"未测出改善"的结论后，测出显著变好或变差时不挂
            if base["ceiling"]:
                text += "（基线触顶）"
        if sens.get(name):
            text += "结论对建模方式敏感，见稳健性分析。"
        out[name] = {"kind": kind, "text": text}
    return out


def exploratory_banner(primary: dict[str, Any]) -> str | None:
    if primary["exploratory"]:
        return (
            f"缺失题 {len(primary['missingTasks'])} 道，超过有效题 {primary['nValid']} 道的 10%，"
            "以下结论降格为探索性。"
        )
    return None
