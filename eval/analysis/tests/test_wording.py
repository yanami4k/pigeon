from pigeon_analysis.wording import conclusion_sentences, exploratory_banner, fmt_p


def primary(push, search=None, ceiling=False, sensitive=None, exploratory=False):
    search = search or dict(estimate=0.001, ci=[-0.01, 0.012], p=0.8, holmSignificant=False, mdeFormal=0.06)
    return {
        "nValid": 80,
        "passesPerCell": {"00": 2, "01": 2, "10": 2, "11": 2},
        "effects": {"push": push, "search": search},
        "baseline": {"ceiling": ceiling},
        "sensitivity": {"byEffect": sensitive or {}},
        "exploratory": exploratory,
        "missingTasks": [1] * 9,
    }


def eff(est, sig, p=0.01, ci=(0.01, 0.09), mde=0.05):
    return dict(estimate=est, ci=list(ci), p=p, holmSignificant=sig, mdeFormal=mde)


def test_positive():
    s = conclusion_sentences(primary(eff(0.052, True, p=0.0031)))["push"]
    assert s["kind"] == "detected-positive"
    assert s["text"] == (
        "在 80 道题、2 遍下，推送记忆使每步要做到的用例通过比例平均提高 5.2 个百分点"
        "（95% 置信区间 [1.0, 9.0]；按题配对的符号翻转检验，Holm 校正后显著，p = 0.0031）。"
    )


def test_negative():
    s = conclusion_sentences(primary(eff(-0.04, True, ci=(-0.07, -0.01))))["push"]
    assert s["kind"] == "detected-negative"
    assert "平均降低 4.0 个百分点" in s["text"]


def test_not_detected_with_mde():
    s = conclusion_sentences(primary(eff(0.02, False, p=0.2, ci=(-0.01, 0.05), mde=0.061)))["push"]
    assert s["kind"] == "not-detected"
    assert s["text"] == (
        "在 80 道题、2 遍下，未测出推送记忆的改善：估计差 2.0 个百分点（95% 置信区间 [-1.0, 5.0]）。"
        "本设计能以 80% 把握分辨的最小效果约为 6.1 个百分点，因此不能排除小于约 6.1 个百分点的效果。"
    )


def test_significant_but_uncorrected_is_not_detected():
    # p < 0.05 但 Holm 未过：仍是"未测出"，不写改善
    s = conclusion_sentences(primary(eff(0.03, False, p=0.04)))["push"]
    assert s["kind"] == "not-detected"


def test_ceiling_appended_only_to_push_not_detected():
    out = conclusion_sentences(primary(eff(0.01, False), ceiling=True))
    assert out["push"]["text"].endswith("（基线触顶）")
    assert "基线触顶" not in out["search"]["text"]
    out = conclusion_sentences(primary(eff(0.05, True), ceiling=True))
    assert "基线触顶" not in out["push"]["text"]


def test_sensitive_sentence():
    out = conclusion_sentences(primary(eff(0.05, True), sensitive={"push": True, "search": False}))
    assert out["push"]["text"].endswith("结论对建模方式敏感，见稳健性分析。")
    assert "敏感" not in out["search"]["text"]


def test_search_label():
    out = conclusion_sentences(primary(eff(0.0, False)))
    assert "未测出可检索历史会话的改善" in out["search"]["text"]


def test_uneven_passes():
    p = primary(eff(0.05, True))
    p["passesPerCell"] = {"00": 2, "01": 3, "10": 3, "11": 3}
    assert "2–3 遍下" in conclusion_sentences(p)["push"]["text"]


def test_banner():
    assert exploratory_banner(primary(eff(0.0, False), exploratory=True)).startswith("缺失题 9 道")
    assert exploratory_banner(primary(eff(0.0, False))) is None


def test_fmt_p_zero():
    assert fmt_p(0.0) == "p < 1e-5"
    assert fmt_p(0.01234) == "p = 0.0123"
