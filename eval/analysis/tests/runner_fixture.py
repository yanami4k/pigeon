"""按合并推送记忆与每日沙箱之后 formal-v2 的跑批器输出造测试用的输出目录：results.jsonl、identity.json、
各作业目录下的会话清单、会话文件（pi v4 JSONL）与开工记忆快照。字段与 src/eval/stream-results.ts、stream-identity.ts、
state/session-entries.ts、memory/update-memory-tool.ts、memory/search-tools.ts 一致。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pigeon_analysis.reader import CONDITION_TO_CELL

CELL_TO_CONDITION = {v: k for k, v in CONDITION_TO_CELL.items()}
DIGEST = "0123456789abcdef"


def memory(chars, entries=None, size=None):
    return {"bytes": size if size is not None else chars, "entries": entries if entries is not None else chars // 150,
            "entryChars": chars}


def review_facts(turns=12, wall_ms=90_000, tokens=30_000, closing=1, pre=0, hit=False):
    return {"closing": closing, "preCompaction": pre, "turns": turns, "tokens": tokens, "wallMs": wall_ms,
            "hitLimit": hit, "failures": []}


def runner_row(cell, seq, attempt, passed, total, *, keep_failed=0, cost=0.4, review_cost=None, peak=40_000,
               mem_start=None, mem_end=None, review=None, **kw):
    """一条结果行；推送两格缺省带复盘与记忆大小，其余格这些为 null。total 为 0 时得分与做成记 null。"""
    push = cell in ("10", "11")
    if push:
        mem_start = mem_start if mem_start is not None else memory(0, entries=0)
        mem_end = mem_end if mem_end is not None else memory(0, entries=0)
        review = review if review is not None else review_facts()
        review_cost = review_cost if review_cost is not None else 0.02
    elif cell != "M":
        mem_start = mem_start if mem_start is not None else memory(0, entries=0)
        mem_end = mem_end if mem_end is not None else memory(0, entries=0)
    row = {
        "repo": "strands",
        "stream": "tasks",
        "condition": CELL_TO_CONDITION[cell],
        "attempt": attempt,
        "seq": seq,
        "kind": "task",
        "commit": f"c{seq}",
        "outcome": "passed" if total and passed == total else "failed",
        "start": f"p{seq}",
        "diff": f"streams/tasks-{CELL_TO_CONDITION[cell]}-{attempt}/diffs/step-{seq}.diff",
        "envOpenMs": 1000,
        "judged": True,
        "repairRounds": None if cell == "M" else 0,
        "finalVerdict": None if cell == "M" else "pass",
        "humanTestRestores": None if cell == "M" else 0,
        "verifyToolFaults": None if cell == "M" else 0,
        "agentChangedDeps": False,
        "humanFailsGate": False,
        "runIdentity": DIGEST,
        "agentSettings": None,
        "judging": {
            "failToPass": {"passed": passed, "total": total},
            "score": (passed / total) if total else None,
            "passToPass": {"failed": keep_failed, "total": 50},
            "solved": (passed == total and keep_failed == 0) if total else None,
            "failedCases": {"failToPass": [], "passToPass": [], "truncated": False},
            "excludedFlaky": 1,
        },
        "baselineUnavailable": None,
        "memoryAtStart": mem_start,
        "memoryAtEnd": mem_end,
        "hitStepBudget": False,
        "hitReviewBudget": (review["hitLimit"] if review else None),
        "review": review,
        "envPrefetched": False,
        "quality": None,
        "status": "completed",
        "turns": 40,
        "usage": {"input": 1000, "output": 500, "cacheRead": 9000, "cacheWrite": 0, "totalTokens": 10500,
                  "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
        "agentWallMs": 600_000,
        "wallMs": 700_000,
        "limitPauses": [],
        "gateway": {"queueMs": 0, "accountRequests": [3], "peakInFlight": 1, "costCny": cost,
                    "reviewCostCny": review_cost if push else None, "peakInputTokens": peak},
        "admissionWaitMs": 0,
        "harnessRef": {"commit": "h", "dirty": False},
    }
    row.update(kw)
    return row


def identity(conditions=("search-only", "search-push", "minimal"), *, prompt_format="test-files",
             step_budget=(300, 3_600_000), review_budget=(40, 900_000), memory_limit=12_000, pigeon=True, **core_kw):
    core: dict[str, Any] = {
        "repo": "strands",
        "manifestDigest": "m",
        "image": "img",
        "budget": {"maxTurns": step_budget[0], "wallClockMs": step_budget[1]},
        "conditions": list(conditions),
        "stepScope": "fixed-start",
        "promptFormat": prompt_format,
        "promptLayout": "two lists",
        "taskSelection": {"method": "all"},
        "maxSteps": None,
        "agents": {},
    }
    if pigeon:
        core["agents"]["pigeon"] = {
            "provider": "deepseek", "modelId": "deepseek-flash", "temperature": 0, "thinking": "off",
            "maxOutputTokens": 16384,
            "compaction": {"contextWindow": 1_000_000, "reserveTokens": 16_384, "keepRecentTokens": 20_000,
                           "thresholdTokens": 983_616},
            "memoryLimitChars": memory_limit, "reviewTemplate": "v1",
            "reviewBudget": {"maxTurns": review_budget[0], "wallClockMs": review_budget[1]},
        }
    core["agents"]["minimal"] = {"model": "deepseek-flash", "miniSweAgent": "1", "litellm": "1", "modelKwargs": None}
    core.update(core_kw)
    return {"core": core, "info": {"concurrency": 4, "harness": {"commit": "h", "dirty": False}}, "digest": DIGEST}


def write_run(run_dir: Path, rows, ident=None, torn=False, gateway_cny: float | None | str = "rows") -> Path:
    """gateway_cny：网关花费记录 gateway-spend.json 的 totalCny；缺省为结果行合计（没有作废的步、没有探测），
    给数即写该数，None 为不写这个文件。"""
    run_dir.mkdir(parents=True, exist_ok=True)
    if gateway_cny is not None:
        if gateway_cny == "rows":
            gateway_cny = sum(float((r.get("gateway") or {}).get("costCny") or 0.0)
                              + float((r.get("gateway") or {}).get("reviewCostCny") or 0.0)
                              for r in rows if isinstance(r, dict))
        (run_dir / "gateway-spend.json").write_text(
            json.dumps({"totalCny": gateway_cny, "requests": 1, "peakRequests": 0}), encoding="utf-8")
    conditions = sorted({r["condition"] for r in rows if isinstance(r, dict) and "condition" in r})
    ident = ident if ident is not None else identity(conditions)
    (run_dir / "identity.json").write_text(json.dumps(ident, ensure_ascii=False, indent=2), encoding="utf-8")
    text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    if torn:
        text += '{"condition": "neither", "seq'
    f = run_dir / "results.jsonl"
    f.write_text(text, encoding="utf-8")
    return f


# ---------- 会话文件 ----------

class SessionBuilder:
    """造一个 pi v4 会话文件：文件头、Run 开始条目、消息条目。"""

    def __init__(self, session_id: str, parent: str | None = None):
        self.lines: list[dict[str, Any]] = [{"kind": "header", "version": 4, "id": session_id, "createdAt": 0,
                                             "cwd": "/job/workspace", **({"parentSessionId": parent} if parent else {})}]
        self.n = 0
        self.session_id = session_id

    def _entry(self, **kw):
        self.n += 1
        self.lines.append({"kind": "entry", "id": f"e{self.n}", "parentId": f"e{self.n - 1}" if self.n > 1 else None,
                           "seq": self.n, "timestamp": 1000 + self.n, **kw})
        return self

    def run_start(self, review_kind: str | None = None):
        data: dict[str, Any] = {"version": 1, "runId": f"r{self.n}", "startedAt": 0, "systemPrompt": "..."}
        if review_kind:
            data["memoryReview"] = {"kind": review_kind, "template": "v1"}
        return self._entry(type="custom", customType="pigeon.run-start", data=data)

    def assistant(self, text=None, calls=(), usage=(0, 0, 0)):
        content: list[dict[str, Any]] = []
        if text is not None:
            content.append({"type": "text", "text": text})
        content.append({"type": "thinking", "thinking": "依据 [L99] 只是思考"})
        for cid, name, args in calls:
            content.append({"type": "toolCall", "id": cid, "name": name, "arguments": args})
        u = {"input": usage[0], "cacheRead": usage[1], "output": usage[2], "cacheWrite": 0,
             "totalTokens": sum(usage), "cost": {"total": 0}}
        return self._entry(type="message", message={"role": "assistant", "content": content, "usage": u,
                                                    "stopReason": "toolUse"})

    def result(self, cid, name, details, is_error=False, text="ok"):
        return self._entry(type="message", message={"role": "toolResult", "toolCallId": cid, "toolName": name,
                                                    "content": [{"type": "text", "text": text}],
                                                    "details": details, "isError": is_error, "timestamp": 0})

    def memory_write(self, cid, action, written=True, rejected=None):
        self.assistant(calls=[(cid, "update_memory", {"action": action, "fact": "f", "refs": ["src/a.py"], "reason": "r"})])
        d: dict[str, Any] = {"action": action, "written": written, "limitChars": 12000}
        if rejected:
            d["rejected"] = rejected
        return self.result(cid, "update_memory", d)

    def text(self, torn=False) -> str:
        out = "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in self.lines)
        return out + ('{"kind":"entry","type":"mess' if torn else "")


def write_job(run_dir: Path, condition: str, attempt: int, steps: dict[int, list[SessionBuilder]],
              snapshots: dict[int, str] | None = None, layout: str = "legacy") -> Path:
    """一个作业目录：steps 为 {步序: 这一步新增的会话}；会话清单逐步累积。snapshots 为 {步序: 开工时 MEMORY.md 文本}。
    layout 为会话根的布局：legacy 即 .pigeon/sessions（正式跑的数据），state 即决策 325 起的 .pigeon/state/sessions。"""
    job = run_dir / "streams" / f"tasks-{condition}-{attempt}"
    root = job / ".pigeon" / ("state" if layout == "state" else "") / "sessions"
    sess_dir = root / "--job-workspace--"
    sess_dir.mkdir(parents=True, exist_ok=True)
    listing: list[str] = []
    for seq in sorted(steps):
        for k, sb in enumerate(steps[seq]):
            name = f"2026-09-28T00-00-{seq:02d}-{k:03d}Z_{sb.session_id}.jsonl"
            (sess_dir / name).write_text(sb.text(), encoding="utf-8")
            listing.append(f"--job-workspace--/{name}")
        (job / f"sessions-{seq}.json").write_text(json.dumps(sorted(listing)), encoding="utf-8")
    for seq, text in (snapshots or {}).items():
        d = job / "learned-snapshots" / f"step-{seq}" / "learned"
        d.mkdir(parents=True, exist_ok=True)
        (d / "MEMORY.md").write_text(text, encoding="utf-8")
    return job


MEMORY_MD = """# 学到的记忆

- [L1] 事实：a 模块的 f 要先初始化
  引用：src/a.py::f, 用户要求（会话 s0）
  理由：r
- [L2] 事实：b 的测试很慢
  引用：tests/test_b.py
  理由：r
"""
