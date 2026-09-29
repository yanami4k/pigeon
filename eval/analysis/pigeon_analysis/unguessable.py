"""接口不可猜的测试文件清单（决策 316，分析计划 2026-09-30 第二条修订）：静态规则，只看代码与题面，不看任何结果。

对每题要做到的用例所在的测试文件（取该题提交里人写的最终版本），用 AST 取出它从项目内（strands 包）导入的模块与名字：
from strands... import X、import strands.x.y、带 as 别名的都算，文件里任何位置的导入语句都算。逐个核对：
- 模块在该题开工代码（起点提交）里存在吗：src 下有 <路径>.py、<路径>/__init__.py，或有以 <路径>/ 开头的文件（命名空间包）；
- 名字在开工代码的对应模块里有定义吗：模块作用域里绑定的名字（顶层 def、class、赋值、带注解的赋值、增量赋值、type 语句、
  import 与 from-import 的别名，含顶层 if、try、with、for、while 语句块里的），或该模块下同名的子模块。
  模块里有 from <项目内模块> import * 的，递归取那个模块的名字；有项目外的星号导入或模块级 __getattr__ 的，名字无法静态
  判定，一律当作有定义。
不存在的，再看它是否以整词形式出现在该题题面文字里（照冻结代码 taskPromptOf 生成的 test-files 题面：提交信息、应通过的
测试文件名单与第二段名单）；整词即前后不是 ASCII 字母、数字或下划线。模块不存在时看的是第一个不存在的那一级模块名。
只要有一个"开工时不存在且题面未提及"，这个文件就记为接口不可猜，其中的要做到用例全部剔除。

已知局限（写进审计）：只按导入语句判，mock.patch 的字符串路径、getattr 与 importlib 动态导入不算；测试辅助文件
（conftest、夹具）不查，它们判题时由人的版本放入；文件本身语法错误解析不了的不判为不可猜，单列出来。
"""

from __future__ import annotations

import ast
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Callable, Iterable

# 项目内的包：strands-py/src 下的 strands
PACKAGE = "strands"
SRC_ROOT = "strands-py/src/"

# 冻结代码（src/eval/stream-manifest.ts）题面的两行说明，test-files 格式
SHOULD_PASS_HEADING = ("Test files that should pass after the change (new or updated; their final versions are not in "
                       "the repository and are added when the change is checked):")
OTHER_FAILING_HEADING = "Other test files already in the repository that currently fail and should pass after the change:"

ReadFile = Callable[[str, str], "str | None"]


def case_file(case_id: str) -> str:
    """用例编号里的测试文件路径（"文件::…"的前一段），同冻结代码的 caseFile。"""
    cut = case_id.find("::")
    return case_id if cut < 0 else case_id[:cut]


def _trim_end(text: str) -> str:
    # JavaScript 的 trimEnd：去掉末尾的空白与行终止符
    return re.sub(r"[\s﻿]+$", "", text)


def task_prompt(message: str, judge_tests: list[str], fail_to_pass: list[str]) -> str:
    """照冻结代码 promptFor（test-files 格式）拼这一步的题面：提交信息原文，其后应通过的测试文件名单；要做到的用例有落在
    本题测试文件之外的，另列这些用例所在的测试文件（去重、排序）。"""
    judge = set(judge_tests)
    outside = sorted({case_file(c) for c in fail_to_pass if case_file(c) not in judge})
    parts = [_trim_end(message)]
    if judge_tests:
        parts.append(SHOULD_PASS_HEADING + "\n" + "\n".join(judge_tests))
    if outside:
        parts.append(OTHER_FAILING_HEADING + "\n" + "\n".join(outside))
    return "\n\n".join(parts) + "\n"


def mentioned(word: str, text: str) -> bool:
    """word 是否以整词出现在 text 里：前后都不是 ASCII 字母、数字或下划线。"""
    return re.search(r"(?<![A-Za-z0-9_])" + re.escape(word) + r"(?![A-Za-z0-9_])", text) is not None


def project_imports(source: str) -> list[dict[str, Any]]:
    """测试文件里从项目内导入的模块与名字：每条为 {module, name, line}，name 为 None 表示 import 模块本身。
    相对导入与项目外的导入不计；from 项目内模块 import * 只核对模块。"""
    tree = ast.parse(source)
    out: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == PACKAGE or alias.name.startswith(PACKAGE + "."):
                    out.append({"module": alias.name, "name": None, "line": node.lineno})
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if node.level != 0 or not (mod == PACKAGE or mod.startswith(PACKAGE + ".")):
                continue
            for alias in node.names:
                out.append({"module": mod, "name": None if alias.name == "*" else alias.name, "line": node.lineno})
    out.sort(key=lambda x: (x["line"], x["module"], x["name"] or ""))
    return out


class StartCode:
    """该题开工代码（起点提交）里项目包的样子：模块在不在、模块作用域里绑定了哪些名字。"""

    def __init__(self, paths: Iterable[str], read: Callable[[str], "str | None"]):
        self.paths = {p for p in paths if p.startswith(SRC_ROOT)}
        self.read = read
        self._names: dict[str, tuple[set[str], bool]] = {}

    def _base(self, module: str) -> str:
        return SRC_ROOT + module.replace(".", "/")

    def module_exists(self, module: str) -> bool:
        base = self._base(module)
        return (base + ".py" in self.paths or base + "/__init__.py" in self.paths
                or any(p.startswith(base + "/") for p in self.paths))

    def first_missing(self, module: str) -> str | None:
        """模块路径里第一个不存在的那一级（完整的点号路径）；都存在为 None。"""
        parts = module.split(".")
        for k in range(1, len(parts) + 1):
            prefix = ".".join(parts[:k])
            if not self.module_exists(prefix):
                return prefix
        return None

    def _source_of(self, module: str) -> str | None:
        base = self._base(module)
        for p in (base + ".py", base + "/__init__.py"):
            if p in self.paths:
                return self.read(p)
        return None

    def names(self, module: str, _seen: frozenset[str] = frozenset()) -> tuple[set[str], bool]:
        """模块作用域里绑定的名字，与是否无法静态判定（项目外星号导入、模块级 __getattr__、语法错误）。"""
        if module in self._names:
            return self._names[module]
        source = self._source_of(module)
        if source is None:
            return set(), False
        try:
            tree = ast.parse(source)
        except SyntaxError:
            result: tuple[set[str], bool] = (set(), True)
            self._names[module] = result
            return result
        names: set[str] = set()
        opaque = False
        package = module if self._source_is_package(module) else module.rpartition(".")[0]
        for node in _module_scope(tree.body):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(node.name)
                if node.name == "__getattr__" and not isinstance(node, ast.ClassDef):
                    opaque = True
            elif isinstance(node, ast.Assign):
                for t in node.targets:
                    names |= _target_names(t)
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
                names |= _target_names(node.target)
            elif hasattr(ast, "TypeAlias") and isinstance(node, ast.TypeAlias):
                names |= _target_names(node.name)
            elif isinstance(node, ast.Import):
                for a in node.names:
                    names.add(a.asname or a.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                target = _resolve_from(node, package)
                for a in node.names:
                    if a.name != "*":
                        names.add(a.asname or a.name)
                        continue
                    if target is not None and (target == PACKAGE or target.startswith(PACKAGE + ".")):
                        if target not in _seen and target != module:
                            sub, sub_opaque = self.names(target, _seen | {module})
                            # 保守起见取全部名字（不按下划线与 __all__ 过滤）：只会少判不可猜
                            names |= sub
                            opaque = opaque or sub_opaque
                    else:
                        opaque = True
        result = (names, opaque)
        self._names[module] = result
        return result

    def _source_is_package(self, module: str) -> bool:
        return self._base(module) + "/__init__.py" in self.paths

    def defines(self, module: str, name: str) -> bool:
        """名字在模块里有定义：模块作用域绑定了它，或它是该模块下的子模块；无法静态判定的模块一律算有定义。"""
        if self.module_exists(f"{module}.{name}"):
            return True
        names, opaque = self.names(module)
        return opaque or name in names


def _module_scope(body: list[ast.stmt]) -> Iterable[ast.stmt]:
    """模块作用域里的语句：顶层语句，以及顶层 if、try、with、for、while 语句块里的（仍是模块作用域）。"""
    for node in body:
        yield node
        blocks: list[list[ast.stmt]] = []
        if isinstance(node, (ast.If, ast.For, ast.AsyncFor, ast.While)):
            blocks = [node.body, node.orelse]
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            blocks = [node.body]
        elif isinstance(node, ast.Try) or (hasattr(ast, "TryStar") and isinstance(node, ast.TryStar)):
            blocks = [node.body, node.orelse, node.finalbody] + [h.body for h in node.handlers]
        for b in blocks:
            yield from _module_scope(b)


def _target_names(t: ast.AST) -> set[str]:
    if isinstance(t, ast.Name):
        return {t.id}
    if isinstance(t, (ast.Tuple, ast.List)):
        out: set[str] = set()
        for e in t.elts:
            out |= _target_names(e)
        return out
    if isinstance(t, ast.Starred):
        return _target_names(t.value)
    return set()


def _resolve_from(node: ast.ImportFrom, package: str) -> str | None:
    """from-import 的目标模块（相对导入按所在包换算）；换算不出为 None。"""
    if node.level == 0:
        return node.module
    parts = package.split(".") if package else []
    up = node.level - 1
    if up > len(parts):
        return None
    base = parts[: len(parts) - up]
    if node.module:
        base = base + node.module.split(".")
    return ".".join(base) if base else None


def file_triggers(source: str, start: StartCode, prompt: str) -> list[dict[str, Any]]:
    """一个测试文件的触发项：开工时不存在、题面也未提及的模块或名字。每条 {kind, module, name, line, word}。"""
    out: list[dict[str, Any]] = []
    for imp in project_imports(source):
        missing = start.first_missing(imp["module"])
        if missing is not None:
            word = missing.rpartition(".")[2]
            if not mentioned(word, prompt):
                out.append({"kind": "module", "module": imp["module"], "name": imp["name"], "line": imp["line"],
                            "word": word})
            continue
        if imp["name"] is not None and not start.defines(imp["module"], imp["name"]):
            if not mentioned(imp["name"], prompt):
                out.append({"kind": "name", "module": imp["module"], "name": imp["name"], "line": imp["line"],
                            "word": imp["name"]})
    return out


def analyze_task(
    step: dict[str, Any],
    fail_to_pass: list[str],
    read: ReadFile,
    start_paths: Iterable[str],
) -> dict[str, Any]:
    """一题：要做到的用例按测试文件分组，逐个文件判定。fail_to_pass 为该题要做到的用例。"""
    prompt = task_prompt(step["message"], list(step["judgeTests"]), fail_to_pass)
    start = StartCode(start_paths, lambda p: read(step["parent"], p))
    by_file: dict[str, list[str]] = {}
    for c in fail_to_pass:
        by_file.setdefault(case_file(c), []).append(c)
    files: list[dict[str, Any]] = []
    unparsable: list[str] = []
    excluded = 0
    for f in sorted(by_file):
        source = read(step["commit"], f)
        if source is None:
            unparsable.append(f)
            continue
        try:
            triggers = file_triggers(source, start, prompt)
        except SyntaxError:
            unparsable.append(f)
            continue
        if triggers:
            files.append({"file": f, "cases": len(by_file[f]), "triggers": triggers,
                          "caseIds": sorted(by_file[f])})
            excluded += len(by_file[f])
    return {
        "seq": step["seq"],
        "commit": step["commit"],
        "parent": step["parent"],
        "failToPass": len(fail_to_pass),
        "excluded": excluded,
        "remaining": len(fail_to_pass) - excluded,
        "files": files,
        "unparsable": unparsable,
    }


def build_list(
    steps: list[dict[str, Any]],
    fail_to_pass: dict[int, list[str]],
    read: ReadFile,
    tree: Callable[[str], list[str]],
) -> dict[str, Any]:
    """全部题的清单与汇总。steps 为清单里 kind 为 task 的步；fail_to_pass 按步序给要做到的用例。"""
    tasks = [analyze_task(s, fail_to_pass[s["seq"]], read, tree(s["parent"])) for s in steps]
    flagged = [t for t in tasks if t["excluded"] > 0]
    return {
        "rule": "decisions 316",
        "summary": {
            "tasks": len(tasks),
            "tasksWithUnguessableFiles": len(flagged),
            "unguessableFiles": sum(len(t["files"]) for t in tasks),
            "failToPassCases": sum(t["failToPass"] for t in tasks),
            "excludedCases": sum(t["excluded"] for t in tasks),
            "tasksWithNoRemainingCases": sorted(t["seq"] for t in tasks if t["failToPass"] > 0 and t["remaining"] == 0),
            "unparsableFiles": sum(len(t["unparsable"]) for t in tasks),
        },
        "tasks": tasks,
    }


def excluded_cases(list_data: dict[str, Any]) -> dict[int, set[str]]:
    """清单 → 按步序剔除的用例编号（被判不可猜的文件里的全部要做到用例）；没有剔除的题不列。"""
    out: dict[int, set[str]] = {}
    for t in list_data["tasks"]:
        ids = {c for f in t["files"] for c in f["caseIds"]}
        if ids:
            out[int(t["seq"])] = ids
    return out


def remaining_cases(list_data: dict[str, Any]) -> dict[int, int]:
    """清单 → 按步序剔除后剩余的要做到用例数。"""
    return {int(t["seq"]): int(t["remaining"]) for t in list_data["tasks"]}


# ---------- 命令行：从人的仓库、流清单与两类用例预计算结果生成清单 ----------

def git_reader(repo: Path) -> tuple[ReadFile, Callable[[str], list[str]]]:
    def read(commit: str, path: str) -> str | None:
        r = subprocess.run(["git", "-C", str(repo), "show", f"{commit}:{path}"], capture_output=True)
        return r.stdout.decode("utf-8") if r.returncode == 0 else None

    def tree(commit: str) -> list[str]:
        r = subprocess.run(["git", "-C", str(repo), "ls-tree", "-r", "--name-only", commit, SRC_ROOT],
                           capture_output=True, check=True)
        return r.stdout.decode("utf-8").splitlines()

    return read, tree


def load_fail_to_pass(steps: list[dict[str, Any]], classes_dir: Path) -> dict[int, list[str]]:
    """各题要做到的用例：<提交>.classes.json 的 failToPass。"""
    out: dict[int, list[str]] = {}
    for s in steps:
        data = json.loads((classes_dir / f"{s['commit']}.classes.json").read_text(encoding="utf-8"))
        out[int(s["seq"])] = list(data["failToPass"])
    return out


def generate(manifest: Path, repo: Path, classes_dir: Path, out: Path) -> dict[str, Any]:
    steps = [s for s in json.loads(manifest.read_text(encoding="utf-8"))["steps"] if s["kind"] == "task"]
    read, tree = git_reader(repo)
    data = build_list(steps, load_fail_to_pass(steps, classes_dir), read, tree)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    return data
