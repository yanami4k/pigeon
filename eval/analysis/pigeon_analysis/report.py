"""输出：一份 Markdown 报告与一份机器可读的 JSON。同一输入两次运行逐字相同。"""

from __future__ import annotations

import json
import math
import numbers
from typing import Any

import numpy as np

from . import constants as K
from .wording import LABELS, conclusion_sentences, exploratory_banner, fmt_p, pp


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
    lines.append("")
    lines += ["## 主判据明细", ""]
    lines.append(f"- 有效题 {p['nValid']} 道；要做到的为零的题 {len(p['fEmptyTasks'])} 道：{p['fEmptyTasks']}")
    if p["missingTasks"]:
        lines.append("- 不进主判据的缺失题：" + "；".join(
            f"第 {m['task']} 题（{'、'.join(m['cellsWithoutResult'])} 无有效结果）" for m in p["missingTasks"]))
    lines.append(f"- 各格遍数：{p['passesPerCell']}")
    lines.append("")
    lines.append("| 效应 | 估计（百分点） | 95% 置信区间 | 双侧 p | Holm 门槛 | Holm 显著 | dz |")
    lines.append("|---|---|---|---|---|---|---|")
    for name in ("push", "search"):
        e = p["effects"][name]
        lines.append(
            f"| {LABELS[name]} | {_v(e['estimate'], 1, 100)} | {_ci(e['ci'])} | "
            f"{fmt_p(e['p']) if e['p'] is not None else '—'} | {e['holmThreshold'] if e['holmThreshold'] is not None else '—'} | "
            f"{'是' if e['holmSignificant'] else '否'} | {_v(e['dz'], 2)} |"
        )
    b = p["baseline"]
    lines += [
        "",
        f"- 00 格平均得分 {_v(b['mean00'], 1, 100)}%；推送效果相对其变化 {_v(b['pushRelativeTo00'], 1, 100)}%，"
        f"检索效果相对其变化 {_v(b['searchRelativeTo00'], 1, 100)}%。",
        f"- 无推送两格平均得分 {_v(b['noPushMean'], 1, 100)}%（达到 {int(K.CEILING_SCORE * 100)}% 及以上为基线触顶：{'是' if b['ceiling'] else '否'}）。",
        "- 各格各遍平均得分（描述用）：" + "；".join(
            f"{c}：" + "、".join(f"第 {r} 遍 {_v(v, 1, 100)}" for r, v in sorted(rs.items()))
            for c, rs in sorted(p["cellPassScores"].items())),
        "",
        "## 稳健性分析（混合模型）",
        "",
    ]
    mm = p.get("mixedModel", {})
    if "error" in mm:
        lines.append(f"- 混合模型未拟合出结果：{mm['error']}；无法比较。")
    elif mm:
        for name in ("push", "search"):
            lines.append(
                f"- {LABELS[name]}：系数 {_v(mm['coef'][name], 1, 100)} 个百分点，p = {mm['p'][name]:.4f}，"
                f"Holm 显著：{'是' if mm['holmSignificant'][name] else '否'}"
            )
        lines.append(f"- 收敛：{'是' if mm['converged'] else '否（系数与 p 值仅供参考）'}；方差分量：{ {k: round(v, 6) for k, v in mm['varianceComponents'].items()} }")
        if mm["warnings"]:
            lines.append(f"- 拟合告警：{'；'.join(mm['warnings'])}")
        sens = p["sensitivity"]
        lines.append(f"- 与主检验方向或显著性不一致：{'是，结论对建模方式敏感' if sens['sensitive'] else '否'}")
    lines += ["", "## 次要判据（探索性）", ""]
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
    lines += ["", "### 效率（各格中位数 / 90 分位）", ""]
    eff = s["efficiency"]
    lines.append("| 指标 | " + " | ".join(K.CELLS + (K.MINIMAL,)) + " | 推送差中位数 | 检索差中位数 |")
    lines.append("|---" * (len(K.CELLS) + 4) + "|")
    for metric, per in eff["byCell"].items():
        cells = [f"{_v(per[c]['median'], 2)} / {_v(per[c]['p90'], 2)}" if c in per else "—" for c in K.CELLS + (K.MINIMAL,)]
        pm = eff["pairedMedian"][metric]
        lines.append(f"| {metric} | " + " | ".join(cells) + f" | {_v(pm['push'], 2)} | {_v(pm['search'], 2)} |")
    lines += ["", "### 记忆使用", "", "```json", json.dumps(clean(s["memoryUsage"]), ensure_ascii=False, indent=2, sort_keys=True), "```"]
    tp = res.get("thirdPass")
    if tp is not None:
        lines += ["", "## 第 3 遍补跑判定（只看预算与波动）", ""]
        lines.append(f"- v = {_v(tp['v'], 6)}；剩余预算 B = {_v(tp.get('remaining'), 2)} 元；C3 = {_v(tp.get('c3'), 2)} 元")
        for name in ("push", "search"):
            r = tp["byEffect"].get(name)
            if r:
                lines.append(f"- {LABELS[name]}：τ² = {_v(r['tau2'], 6)}，第 3 遍可把最小可分辨效果降低 {_v(r['reduction'], 1, 100)}%")
        d = tp.get("decision")
        lines.append(f"- 判定：{'补第 3 遍' if d else ('不补' if d is False else '无法判定（' + tp.get('reason', '') + '）')}")
    lines += ["", "## 输入", "", f"- 读入结果行 {res['input']['rows']} 条，规整表记录 {res['input']['records']} 条",
              f"- 待对齐字段中结果行里没有的：{res['input']['pendingFieldsAbsent']}", ""]
    return "\n".join(lines)


def _ci_raw(ci) -> str:
    return f"[{ci[0]:.2f}, {ci[1]:.2f}]" if ci else "—"


def calibration_markdown(res: dict[str, Any]) -> str:
    c = res["calibration"]
    lines = ["# 校准分析报告", "", "校准结果不进正式结论。", ""]
    sr = c["solvedRate"]
    dec = {"stay": "留在 strands", "switch-repo": "按 197 换仓", "below-threshold": "低于 30%，处理另定", None: "无数据"}
    lines += ["## 3.1 做成率门槛", "",
              f"- 01 格两遍合计做成率 {_v(sr.get('rate'), 1, 100)}%（{sr.get('steps', 0)} 个步结果），各遍 {sr.get('byPass')}",
              f"- 判定：{dec[sr.get('decision')]}" + ("；两遍相差超过 20 个百分点，重跑波动大" if sr.get("largeRerunGap") else ""), ""]
    co = c["cost"]
    cdec = {"go": "按计划开跑", "go-third-pass-unlikely": "开跑，但第 3 遍基本无望", "owner-decides": "超出 ¥650，交项目负责人裁决", None: "数据不全"}
    lines += ["## 3.2 每遍花费", "",
              f"- 每步平均花费（含复盘）：01 {_v(co['c01'], 4)}、11 {_v(co['c11'], 4)}、M {_v(co['cM'], 4)} 元；已折回非高峰价：{'是' if co['offpeakAdjusted'] else '否'}",
              f"- C_pass = {_v(co.get('cPass'), 2)}，C_M = {_v(co.get('cM_total'), 2)}，C_base = {_v(co.get('cBase'), 2)} 元",
              f"- 判定：{cdec[co.get('decision')]}", ""]
    cp = c["contextPeak"]
    lines += ["## 3.3 上下文峰值（只记录）", "",
              f"- 中位 {_v(cp.get('median'), 0)}、90 分位 {_v(cp.get('p90'), 0)}、最大 {_v(cp.get('max'), 0)}（{cp.get('n', 0)} 步）"
              + (f"；超过压缩触发点 80% 的步 {cp['stepsOverWarn']}" if "stepsOverWarn" in cp else "；未给压缩触发点，未做检查"), ""]
    sb = c["stepBudget"]
    lines += ["## 3.4 每步预算上限", "",
              f"- 实测最大 {_v(sb.get('maxTurns'), 0)} 轮、{_v(sb.get('maxWallMinutes'), 1)} 分钟；撞临时上限：{'是' if sb.get('hitTemporaryCap') else '否'}",
              f"- 正式上限：{_v(sb.get('turns'), 0)} 轮、{_v(sb.get('wallMinutes'), 0)} 分钟；封顶生效：{'是' if sb.get('capApplied') else '否'}", ""]
    mc = c["memoryCap"]
    lines += ["## 3.5 记忆总量硬上限", "",
              f"- 按 {mc['column']} 计；各遍每步平均增长 {mc['growthByPass']}；两遍相差超过一倍：{'是' if mc.get('passesDiverged') else '否'}",
              f"- 取用增长 {_v(mc.get('growthUsed'), 1)} × 30 → 取整 {_v(mc.get('rounded'), 0)} → 上限 {_v(mc.get('capChars'), 0)} 字符", ""]
    rc = c["reviewCap"]
    lines += ["## 3.6 复盘上限", "",
              f"- 实测最大 {_v(rc.get('maxTurns'), 0)} 轮、{_v(rc.get('maxWallMinutes'), 1)} 分钟；撞临时上限：{'是' if rc.get('hitTemporaryCap') else '否'}",
              f"- 正式上限：{_v(rc.get('turns'), 0)} 轮、{_v(rc.get('wallMinutes'), 0)} 分钟", ""]
    ds = c["designSensitivity"]
    lines += ["## 3.7 设计灵敏度", "",
              f"- 重跑方差 v = {_v(ds['v'], 6)}，因题而异 τ² = {_v(ds.get('tau2'), 6)}（配对题 {ds['nPaired']} 道；只用方差）",
              f"- 正式跑 n = {ds['formalTasks']}（{c['mdeTasksSource']}），k = {ds['k']}：" + (
                  "；".join(f"R = {r} 时最小可分辨效果约 {pp(m)} 个百分点" for r, m in ds["mde"].items()) if ds.get("mde") else "无法计算"),
              "- 校准的记忆轨迹只有 15 道题，可能低估波动。", ""]
    if "sampleCheck" in c:
        sc = c["sampleCheck"]
        lines += ["## 抽题核对", "", f"- 按种子 {K.SAMPLE_SEED} 应抽 {sc['expected']}；与结果中的题一致：{'是' if sc['matches'] else '否'}", ""]
    lines += ["## 输入", "", f"- 读入结果行 {res['input']['rows']} 条，规整表记录 {res['input']['records']} 条",
              f"- 待对齐字段中结果行里没有的：{res['input']['pendingFieldsAbsent']}", ""]
    return "\n".join(lines)


def formal_result(primary, secondary, third_pass, input_info) -> dict[str, Any]:
    return {
        "kind": "formal",
        "primary": primary,
        "secondary": secondary,
        "conclusions": conclusion_sentences(primary),
        "thirdPass": third_pass,
        "input": input_info,
        "seeds": {"permutation": K.PERMUTATION_SEED, "bootstrap": K.BOOTSTRAP_SEED},
    }
