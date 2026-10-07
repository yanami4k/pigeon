"""对比评测从作业目录里读的计量（分析计划第 3 节"撞上限与作废""Pigeon 的机制使用"、第 5.4 节）：结果行里没有的都从这里取。

作业目录为 streams/<流>-<条件>-<遍次>/（跑批器 src/eval/stream-runner.ts 的 jobDirName），其下：
- <产物目录>/step-<步序>/try-<第几次>/：agent 每运行一次即开一个尝试目录、重做不覆盖（Pigeon 组的产物目录为 pigeon-docker，
  外部 agent 条件为 external）。有结果行的步，尝试数减一即作废重做的次数；没有结果行的步，各次尝试都作废了。
- .pigeon/state/sessions：Pigeon 组的治理根里的会话文件（pi v4 JSONL），sessions-<步序>.json 为该步完成时的会话清单（逐步累积），
  某步的会话 = 该步清单减去上一个完成步的清单（作废尝试的会话已被跑批器移出）。worker 的工作树在 .pigeon/state/worktrees。
- gateway/：网关逐请求留存（src/eval/gateway-retention.ts）：gateway/step-<步序>/try-<第几次>/ 下 requests.jsonl、
  responses.jsonl、replies.gz（各次回复的原始正文，一次一段 gzip，按偏移取）；gateway/blobs 为同一作业共用的系统提示与工具定义。
输出目录下的 peak-pauses.jsonl 为高峰暂停的记录（每次暂停与恢复一行）。

这里只数计数与体积，不把会话或请求的内容带出去。
"""

from __future__ import annotations

import gzip
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from .sessions import SessionSourceError, sessions_root

# agent 每次运行的尝试目录所在（作业目录下）
AGENT_TRY_DIRS = ("pigeon-docker", "external")
RETENTION_DIR = "gateway"
PEAK_PAUSES_FILE = "peak-pauses.jsonl"

SEARCH_TOOLS = {"search_sessions": "mech_search_calls", "read_session_entry": "mech_read_entry_calls",
                "list_sessions": "mech_list_calls"}
WORKER_ENTRY = "pigeon.worker"
PRUNE_ENTRY = "pigeon.prune"
CONTINUATION_ENTRY = "pigeon.continuation"
# 网关留存时去掉的请求头（同 gateway-retention.ts 的 SENSITIVE_HEADER）：留存里出现即说明去鉴权失效
SENSITIVE_HEADER = re.compile(r"auth|key|token|secret|cookie|password", re.IGNORECASE)

# Pigeon 组每步的机制计数（列名）
MECHANISM_COLUMNS = (
    "mech_search_calls",
    "mech_read_entry_calls",
    "mech_list_calls",
    "mech_sessions_hit",
    "mech_workers",
    "mech_worktree_workers",
    "mech_prunes",
    "mech_compactions",
    "mech_continuations",
)


def job_dir(run_dir: Path, stream: str, condition: str, attempt: int) -> Path:
    return run_dir / "streams" / f"{stream}-{condition}-{attempt}"


def _numbered(parent: Path, prefix: str) -> dict[int, Path]:
    if not parent.is_dir():
        return {}
    out: dict[int, Path] = {}
    for p in parent.iterdir():
        if p.is_dir() and p.name.startswith(prefix) and p.name[len(prefix):].isdigit():
            out[int(p.name[len(prefix):])] = p
    return out


def agent_tries(job: Path) -> dict[int, int] | None:
    """每步 agent 运行过几次（尝试目录数）；作业目录里没有尝试目录（未记录）为 None。"""
    found = False
    out: Counter[int] = Counter()
    for sub in AGENT_TRY_DIRS:
        d = job / sub
        if not d.is_dir():
            continue
        found = True
        for seq, step in _numbered(d, "step-").items():
            out[seq] += len(_numbered(step, "try-"))
    return dict(out) if found else None


# ---------- 会话文件里的机制计数 ----------

def scan_session(path: Path) -> dict[str, Any]:
    """一个会话文件里的机制计数：三件检索工具的调用次数、检索命中的会话、派出的 worker（角色、是否建工作树、收尾状态）、
    上下文裁剪、压缩与截断续跑条目数。撕裂的末行丢弃，中段坏行报错。"""
    try:
        raw = path.read_text(encoding="utf-8").split("\n")
    except FileNotFoundError:
        raise SessionSourceError(f"缺会话文件：{path.as_posix()}") from None
    last = max((k for k, line in enumerate(raw) if line.strip()), default=-1)
    counts: Counter[str] = Counter()
    hit: set[str] = set()
    roles: Counter[str] = Counter()
    settled: Counter[str] = Counter()
    header = False
    for k, line in enumerate(raw):
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            if k == last:
                continue
            raise SessionSourceError(f"会话文件第 {k + 1} 行不是合法 JSON：{path.as_posix()}") from None
        if e.get("kind") == "header":
            header = True
            continue
        if e.get("kind") != "entry":
            continue
        kind = e.get("type")
        if kind == "compaction":
            counts["mech_compactions"] += 1
        elif kind == "custom":
            data = e.get("data") or {}
            ctype = e.get("customType")
            if ctype == PRUNE_ENTRY:
                counts["mech_prunes"] += 1
            elif ctype == CONTINUATION_ENTRY:
                counts["mech_continuations"] += 1
            elif ctype == WORKER_ENTRY and data.get("event") == "spawned":
                counts["mech_workers"] += 1
                roles[str(data.get("role"))] += 1
                if (data.get("workspace") or {}).get("kind") == "git-worktree":
                    counts["mech_worktree_workers"] += 1
            elif ctype == WORKER_ENTRY and data.get("event") == "settled":
                settled[str(data.get("status"))] += 1
        elif kind == "message":
            msg = e.get("message") or {}
            if msg.get("role") == "assistant":
                for block in msg.get("content") or []:
                    if block.get("type") == "toolCall" and block.get("name") in SEARCH_TOOLS:
                        counts[SEARCH_TOOLS[block["name"]]] += 1
            elif msg.get("role") == "toolResult" and msg.get("toolName") == "search_sessions" and not msg.get("isError"):
                details = msg.get("details") or {}
                # 决策 384 起按会话归并（groups）；此前为逐条命中（hits）
                for item in list(details.get("groups") or []) + list(details.get("hits") or []):
                    if isinstance(item, dict) and isinstance(item.get("sessionId"), str):
                        hit.add(item["sessionId"])
    if not header:
        raise SessionSourceError(f"会话文件没有文件头：{path.as_posix()}")
    return {"counts": counts, "hit": hit, "roles": roles, "settled": settled}


def pigeon_mechanisms(job: Path, seqs: Iterable[int]) -> tuple[dict[int, dict[str, float]], dict[str, Any]]:
    """Pigeon 组一个作业每步的机制计数（列见 MECHANISM_COLUMNS）与作业合计的 worker 角色、收尾状态、磁盘上的工作树数。
    作业目录或会话根不在时整体记为未记录；有会话根而某一步的会话清单或清单里的会话文件缺失即报错。"""
    root = sessions_root(job)
    if not root.is_dir():
        return {}, {"available": False}
    per_step: dict[int, dict[str, float]] = {}
    roles: Counter[str] = Counter()
    settled: Counter[str] = Counter()
    before: set[str] = set()
    files = 0
    for seq in sorted(set(int(s) for s in seqs)):
        listing_file = job / f"sessions-{seq}.json"
        try:
            listing = set(json.loads(listing_file.read_text(encoding="utf-8")))
        except FileNotFoundError:
            raise SessionSourceError(f"缺会话清单：{listing_file.as_posix()}") from None
        new = sorted(listing - before)
        before = listing
        counts: Counter[str] = Counter()
        hit: set[str] = set()
        for rel in new:
            s = scan_session(root / rel)
            counts.update(s["counts"])
            hit |= s["hit"]
            roles.update(s["roles"])
            settled.update(s["settled"])
        files += len(new)
        step = {col: float(counts[col]) for col in MECHANISM_COLUMNS}
        step["mech_sessions_hit"] = float(len(hit))
        step["mech_session_files"] = float(len(new))
        per_step[seq] = step
    worktrees = job / ".pigeon" / "state" / "worktrees"
    on_disk = sum(1 for p in worktrees.iterdir() if p.is_dir()) if worktrees.is_dir() else 0
    return per_step, {"available": True, "sessionFiles": files, "roles": dict(roles), "settled": dict(settled),
                      "worktreesOnDisk": on_disk}


# ---------- 网关留存（5.4） ----------

def _dir_bytes(d: Path) -> int:
    return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())


def _jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").split("\n"):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue  # 写到一半的行
        if isinstance(obj, dict):
            out.append(obj)
    return out


def reply_signatures(text: str) -> tuple[int, int]:
    """一次回复里思考块的个数与其中签名为空的个数。SSE：content_block_start 起一个块（签名可能在起始里），
    signature_delta 追加签名；非流式：正文 content 里 type 为 thinking 的块。"""
    blocks: dict[int, str] = {}
    lines = [x for x in text.split("\n") if x.startswith("data:")]
    if not lines:
        try:
            body = json.loads(text)
        except json.JSONDecodeError:
            return 0, 0
        thinking = [b for b in (body.get("content") or []) if isinstance(b, dict) and b.get("type") == "thinking"]
        return len(thinking), sum(1 for b in thinking if not b.get("signature"))
    for line in lines:
        try:
            ev = json.loads(line[5:])
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "content_block_start" and (ev.get("content_block") or {}).get("type") == "thinking":
            blocks[int(ev.get("index", len(blocks)))] = ev["content_block"].get("signature") or ""
        elif ev.get("type") == "content_block_delta" and (ev.get("delta") or {}).get("type") == "signature_delta":
            i = int(ev.get("index", -1))
            if i in blocks:
                blocks[i] += ev["delta"].get("signature") or ""
    return len(blocks), sum(1 for s in blocks.values() if not s)


def _echoed_thinking(messages: list[Any]) -> tuple[int, int]:
    """请求里回传的历史思考块个数与其中签名为空的个数（只看留存的增量消息）。"""
    total = empty = 0
    for m in messages:
        if not isinstance(m, dict) or m.get("role") != "assistant" or not isinstance(m.get("content"), list):
            continue
        for b in m["content"]:
            if isinstance(b, dict) and b.get("type") == "thinking":
                total += 1
                empty += 0 if b.get("signature") else 1
    return total, empty


def retention_step(step_dir: Path) -> dict[str, Any]:
    """一步的留存（各次尝试合计）：体积、请求数、存全量与截断的请求、回复状态、多轮请求的 400、思考块签名、请求头里的敏感名。"""
    out: Counter[str] = Counter()
    statuses: Counter[str] = Counter()
    for _, tr in sorted(_numbered(step_dir, "try-").items()):
        requests = {int(r["id"]): r for r in _jsonl(tr / "requests.jsonl") if isinstance(r.get("id"), int)}
        out["tries"] += 1
        out["requests"] += len(requests)
        for r in requests.values():
            msgs = r.get("messages") or {}
            out["fullRequests"] += 1 if msgs.get("full") else 0
            out["truncatedRequests"] += 1 if r.get("truncated") else 0
            out["sensitiveHeaders"] += sum(1 for name in (r.get("headers") or {}) if SENSITIVE_HEADER.search(name))
            t, e = _echoed_thinking(list(msgs.get("delta") or []))
            out["echoedThinking"] += t
            out["echoedThinkingEmptySignature"] += e
        replies = tr / "replies.gz"
        blob = replies.read_bytes() if replies.is_file() else b""
        for resp in _jsonl(tr / "responses.jsonl"):
            status = int(resp.get("status") or 0)
            statuses[str(status)] += 1
            req = requests.get(int(resp.get("id") or 0)) or {}
            if status == 400 and int((req.get("messages") or {}).get("count") or 0) > 1:
                out["multiTurn400"] += 1
            reply = resp.get("reply") or {}
            out["truncatedReplies"] += 1 if reply.get("truncated") else 0
            sl = reply.get("slice")
            if sl and blob:
                text = gzip.decompress(blob[sl["offset"]:sl["offset"] + sl["length"]]).decode("utf-8", "replace")
                t, e = reply_signatures(text)
                out["thinkingBlocks"] += t
                out["thinkingEmptySignature"] += e
    return {"bytes": _dir_bytes(step_dir), **{k: int(v) for k, v in out.items()}, "statuses": dict(statuses)}


def retention_job(job: Path) -> dict[str, Any]:
    """一个作业的留存：按步的计量与作业共用的 blobs 体积；没有留存目录为未记录。"""
    root = job / RETENTION_DIR
    if not root.is_dir():
        return {"available": False}
    steps = {seq: retention_step(d) for seq, d in sorted(_numbered(root, "step-").items())}
    blobs = root / "blobs"
    return {"available": True, "steps": steps, "blobBytes": _dir_bytes(blobs) if blobs.is_dir() else 0}


def peak_pauses(run_dir: Path) -> dict[str, Any]:
    """高峰暂停的记录：暂停与恢复各几次、还没恢复的暂停；没有记录文件即这次没有暂停过。"""
    records = _jsonl(run_dir / PEAK_PAUSES_FILE)
    pauses = [r for r in records if r.get("event") == "pause"]
    resumes = [r for r in records if r.get("event") == "resume"]
    return {"pauses": len(pauses), "resumes": len(resumes), "unresumed": max(0, len(pauses) - len(resumes)),
            "fileExists": (run_dir / PEAK_PAUSES_FILE).is_file()}
