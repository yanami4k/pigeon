"""会话文件里的记忆使用与检索计数（分析计划第 3 节"记忆使用"与"效率"；决策 261）。

结果行不记这些计数，来源是跑批输出目录里保留的会话文件：
- 作业目录 streams/tasks-<条件>-<遍次>/ 即该作业的治理根；其下 sessions-<步序>.json 为该步完成时 .pigeon/sessions 下全部
  会话文件的清单（相对会话根、分隔符为 /、逐步累积）。某步的会话 = 该步清单减去同一作业上一个完成步的清单；
  作废尝试的会话已被跑批器移出治理根，不在清单里。
- 会话文件为 pi v4 JSONL：首行文件头，其余每行一个条目；消息条目 type 为 message，自定义条目 type 为 custom。
  复盘会话由干活的会话分叉而来，开头带着干活会话的历史副本；其自己的部分从带 memoryReview 的 pigeon.run-start 条目开始，
  只数这之后的条目。没有这种条目的会话即干活的会话（回炉各轮是同一会话里的后续 Run）。
- 每步开工时的记忆为 learned-snapshots/step-<步序>/learned/MEMORY.md，"引用："行列出条目所引的文件。

最简 agent 没有会话文件，这些计数对它为空。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable

RUN_START = "pigeon.run-start"
UPDATE_MEMORY = "update_memory"
READ_FILE = "read_file"
SEARCH_SESSIONS = "search_sessions"
READ_SESSION_ENTRY = "read_session_entry"
MEMORY_ACTIONS = ("add", "replace", "remove")

# 干活的 agent 在回复里标出的记忆编号（推送提示要求"依据 [L3]"这样的写法）
CITATION = re.compile(r"\[L([1-9]\d*)\]")
REFS_LINE = re.compile(r"^ {2}引用：(.+)$")
REFS_SEPARATOR = ", "
USER_REF_PREFIX = "用户要求"


class SessionSourceError(ValueError):
    """会话来源缺失或格式不对：说清是哪个文件、哪一项，不静默补默认值。"""


def job_dir_name(condition: str, attempt: int) -> str:
    # 跑批器的作业目录名：流名（恒为 tasks）-条件-遍次
    return f"tasks-{condition}-{attempt}"


def _read_json(path: Path, what: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SessionSourceError(f"缺{what}：{path.as_posix()}") from None


def read_session(path: Path) -> dict[str, Any]:
    """读一个会话文件，只留计数需要的部分：是否复盘会话及其种类、工具调用、工具结果、回复文字与用量。
    复盘会话只取它自己的部分（带 memoryReview 的 run-start 之后）。撕裂的末行丢弃。"""
    try:
        raw_lines = path.read_text(encoding="utf-8").split("\n")
    except FileNotFoundError:
        raise SessionSourceError(f"缺会话文件：{path.as_posix()}") from None
    entries: list[dict[str, Any]] = []
    last = max((k for k, raw in enumerate(raw_lines) if raw.strip()), default=-1)
    for k, raw in enumerate(raw_lines):
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            if k == last:
                continue  # 撕裂的末行
            raise SessionSourceError(f"会话文件第 {k + 1} 行不是合法 JSON：{path.as_posix()}") from None
        entries.append(obj)
    if not entries or entries[0].get("kind") != "header":
        raise SessionSourceError(f"会话文件没有文件头：{path.as_posix()}")
    body = [e for e in entries[1:] if e.get("kind") == "entry"]
    review_kind = None
    start = 0
    for k, e in enumerate(body):
        if e.get("type") == "custom" and e.get("customType") == RUN_START:
            tag = (e.get("data") or {}).get("memoryReview")
            if isinstance(tag, dict):
                review_kind = tag.get("kind")
                start = k + 1
                break
    calls: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    texts: list[str] = []
    usage = {"input": 0.0, "cacheRead": 0.0, "output": 0.0}
    for e in body[start:]:
        if e.get("type") != "message":
            continue
        msg = e.get("message") or {}
        role = msg.get("role")
        if role == "assistant":
            for block in msg.get("content") or []:
                if block.get("type") == "text":
                    texts.append(block.get("text", ""))
                elif block.get("type") == "toolCall":
                    calls.append({"id": block.get("id"), "name": block.get("name"),
                                  "arguments": block.get("arguments") or {}})
            u = msg.get("usage") or {}
            for key in usage:
                usage[key] += float(u.get(key) or 0)
        elif role == "toolResult":
            results.append({"id": msg.get("toolCallId"), "name": msg.get("toolName"),
                            "details": msg.get("details") or {}, "isError": bool(msg.get("isError"))})
    return {"review": review_kind is not None, "reviewKind": review_kind, "calls": calls, "results": results,
            "texts": texts, "usage": usage}


def memory_refs(memory_md: str) -> set[str]:
    """MEMORY.md 各条目"引用："行里的文件（去掉 ::符号 后缀）；用户要求一类不是文件，不计。"""
    refs: set[str] = set()
    for line in memory_md.split("\n"):
        m = REFS_LINE.match(line)
        if not m:
            continue
        for ref in m.group(1).split(REFS_SEPARATOR):
            ref = ref.strip()
            if not ref or ref.startswith(USER_REF_PREFIX):
                continue
            ref = _norm_path(ref.split("::", 1)[0])
            if ref:
                refs.add(ref)
    return refs


def _norm_path(p: str) -> str:
    p = p.replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    return p


def reads_referenced_file(path: str, refs: set[str]) -> bool:
    """读取的路径是否指向某条记忆所引的文件：相同，或以 /引用路径 结尾（容器内的绝对路径）。"""
    p = _norm_path(path)
    return any(p == r or p.endswith("/" + r.lstrip("/")) for r in refs)


def step_metrics(sessions: list[dict[str, Any]], push: bool, search: bool, refs: set[str]) -> dict[str, float]:
    """一步的计数。推送格：干活与复盘各自的新增、改写、删除次数（写成功的），写满被拒次数，回复里标出记忆编号的次数与
    涉及的条目数，读取记忆所引文件的次数；复盘的输入（未命中 / 命中）与输出 token。检索格：两件检索工具的调用次数与命中会话数。"""
    out: dict[str, float] = {}
    worker = [s for s in sessions if not s["review"]]
    reviews = [s for s in sessions if s["review"]]
    if push:
        for who, group in (("worker", worker), ("review", reviews)):
            counts = {a: 0 for a in MEMORY_ACTIONS}
            full = 0
            for s in group:
                for r in s["results"]:
                    if r["name"] != UPDATE_MEMORY:
                        continue
                    d = r["details"]
                    if d.get("written") is True and d.get("action") in counts:
                        counts[d["action"]] += 1
                    if d.get("rejected") == "full":
                        full += 1
            for a in MEMORY_ACTIONS:
                out[f"mem_{who}_{a}"] = float(counts[a])
            out[f"mem_{who}_rejected_full"] = float(full)
        cited = [int(m) for s in worker for t in s["texts"] for m in CITATION.findall(t)]
        out["mem_citations"] = float(len(cited))
        out["mem_cited_entries"] = float(len(set(cited)))
        out["mem_ref_reads"] = float(sum(
            1 for s in worker for c in s["calls"]
            if c["name"] == READ_FILE and isinstance(c["arguments"].get("path"), str)
            and reads_referenced_file(c["arguments"]["path"], refs)))
        out["review_input_miss"] = float(sum(s["usage"]["input"] for s in reviews))
        out["review_input_hit"] = float(sum(s["usage"]["cacheRead"] for s in reviews))
        out["review_output"] = float(sum(s["usage"]["output"] for s in reviews))
    if search:
        out["search_calls_search_sessions"] = float(sum(1 for s in worker for c in s["calls"] if c["name"] == SEARCH_SESSIONS))
        out["search_calls_read_session_entry"] = float(sum(1 for s in worker for c in s["calls"] if c["name"] == READ_SESSION_ENTRY))
        hit = {h.get("sessionId") for s in worker for r in s["results"] if r["name"] == SEARCH_SESSIONS and not r["isError"]
               for h in (r["details"].get("hits") or [])}
        out["search_sessions_hit"] = float(len(hit - {None}))
    return out


def load_session_metrics(run_dir: Path, rows: Iterable[dict[str, Any]], cell_of: dict[str, str]) -> tuple[dict[tuple[str, int, int], dict[str, float]], dict[str, Any]]:
    """读一个输出目录里各 Pigeon 作业的会话文件，按（格、步序、遍次）给出计数。
    没有 streams 目录时整体记为不可用（报告注明）；有目录而某一步的会话清单、会话文件或开工记忆快照缺失即报错。"""
    streams = run_dir / "streams"
    if not streams.is_dir():
        return {}, {"available": False, "reason": "no-streams-dir"}
    jobs: dict[tuple[str, int], list[int]] = {}
    mem_entries: dict[tuple[str, int, int], float] = {}
    for row in rows:
        cell = cell_of.get(row.get("condition"))
        if cell is None or cell == "M":
            continue
        key = (row["condition"], int(row["attempt"]))
        jobs.setdefault(key, []).append(int(row["seq"]))
        start = row.get("memoryAtStart")
        mem_entries[(row["condition"], int(row["attempt"]), int(row["seq"]))] = float(start["entries"]) if start else 0.0
    out: dict[tuple[str, int, int], dict[str, float]] = {}
    files = 0
    for (condition, attempt), seqs in sorted(jobs.items()):
        cell = cell_of[condition]
        push, search = cell[0] == "1", cell[1] == "1"
        job = streams / job_dir_name(condition, attempt)
        before: set[str] = set()
        for seq in sorted(set(seqs)):
            listing = set(_read_json(job / f"sessions-{seq}.json", "会话清单"))
            new = sorted(listing - before)
            before = listing
            sessions = [read_session(job / ".pigeon" / "sessions" / rel) for rel in new]
            files += len(sessions)
            refs: set[str] = set()
            if push:
                snap = job / "learned-snapshots" / f"step-{seq}" / "learned" / "MEMORY.md"
                if snap.is_file():
                    refs = memory_refs(snap.read_text(encoding="utf-8"))
                elif mem_entries.get((condition, attempt, seq), 0.0) > 0:
                    raise SessionSourceError(f"开工时记忆有条目，却缺开工记忆快照：{snap.as_posix()}")
            out[(cell, seq, attempt)] = step_metrics(sessions, push, search, refs)
    return out, {"available": True, "jobs": len(jobs), "sessionFiles": files}
