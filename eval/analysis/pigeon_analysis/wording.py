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
        lo, hi = e["ci"]
        ci = f"95% 置信区间 [{pp(lo)}, {pp(hi)}]"
        if kind == DETECTED_POSITIVE:
            text = (
                f"在 {n} 道题、{r} 遍下，{label}使每步要做到的用例通过比例平均提高 {pp(e['estimate'])} 个百分点"
                f"（{ci}；按题配对的符号翻转检验，Holm 校正后显著，{fmt_p(e['p'])}）。"
            )
        elif kind == DETECTED_NEGATIVE:
            text = (
                f"在 {n} 道题、{r} 遍下，{label}使每步要做到的用例通过比例平均降低 {pp(-e['estimate'])} 个百分点"
                f"（{ci}；按题配对的符号翻转检验，Holm 校正后显著，{fmt_p(e['p'])}）。"
            )
        else:
            mde = e["mdeFormal"]
            mde_s = pp(mde) if mde is not None else "—"
            text = (
                f"在 {n} 道题、{r} 遍下，未测出{label}的改善：估计差 {pp(e['estimate'])} 个百分点（{ci}）。"
                f"本设计能以 80% 把握分辨的最小效果约为 {mde_s} 个百分点，因此不能排除小于约 {mde_s} 个百分点的效果。"
            )
            # 基线触顶按无推送两格定义（第 4 节），只挂在推送效果的"未测出"句后
            if name == "push" and primary["baseline"]["ceiling"]:
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
