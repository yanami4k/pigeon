"""接口不可猜清单的静态规则（决策 316）。用内存里的合成仓库：开工提交 P、人的提交 C。"""

import pytest

from pigeon_analysis.unguessable import (
    OTHER_FAILING_HEADING,
    SHOULD_PASS_HEADING,
    StartCode,
    analyze_task,
    build_list,
    excluded_cases,
    file_triggers,
    mentioned,
    project_imports,
    remaining_cases,
    task_prompt,
)

S = "strands-py/src/strands/"
T = "strands-py/tests/strands/"


def repo(start: dict[str, str], human: dict[str, str]):
    files = {"P": start, "C": {**start, **human}}

    def read(commit, path):
        return files[commit].get(path)

    def tree(commit):
        return sorted(files[commit])

    return read, tree


START = {
    S + "__init__.py": "from .agent import Agent\n",
    S + "agent/__init__.py": "from .agent import Agent as Agent\n",
    S + "agent/agent.py": (
        "import typing\n"
        "from typing import Any as _Any\n"
        "X, (Y, *Z) = 1, (2, 3)\n"
        "limit: int = 3\n"
        "counter = 0\n"
        "counter += 1\n"
        "if typing.TYPE_CHECKING:\n"
        "    from .helpers import Hidden\n"
        "try:\n"
        "    import orjson as fastjson\n"
        "except ImportError:\n"
        "    fastjson = None\n"
        "class Agent:\n"
        "    inner = 1\n"
        "def run():\n"
        "    local_only = 1\n"
        "async def arun():\n"
        "    pass\n"
    ),
    S + "tools/__init__.py": "from .registry import *\n",
    S + "tools/registry.py": "class ToolRegistry:\n    pass\n_private = 1\n",
    S + "lazy.py": "def __getattr__(name):\n    return name\n",
    S + "ext.py": "from somewhere_else import *\n",
    S + "ns/leaf.py": "VALUE = 1\n",
}


def start_code():
    read, tree = repo(START, {})
    return StartCode(tree("P"), lambda p: read("P", p))


class TestPrompt:
    def test_matches_frozen_layout(self):
        # 与冻结代码 taskPromptOf 同一版式：提交信息去掉末尾空白，其后说明行与名单，第二段只在有名单外用例时出现
        p = task_prompt("feat: x\n\nbody  \n\n", [T + "test_a.py"], [T + "test_a.py::t1", T + "test_b.py::t2",
                                                                      T + "test_b.py::t3"])
        assert p == ("feat: x\n\nbody\n\n" + SHOULD_PASS_HEADING + "\n" + T + "test_a.py\n\n"
                     + OTHER_FAILING_HEADING + "\n" + T + "test_b.py\n")

    def test_no_second_list_when_all_inside(self):
        p = task_prompt("m", [T + "test_a.py"], [T + "test_a.py::t1"])
        assert OTHER_FAILING_HEADING not in p
        assert p.endswith(T + "test_a.py\n")

    def test_whole_word(self):
        assert mentioned("Agent", "use the Agent class")
        assert mentioned("_buffer", "fix (_buffer) handling")
        assert not mentioned("audio", "tests/test_audio.py")
        assert not mentioned("Agent", "AgentLoop")
        assert mentioned("audio", "strands/bidi/audio/io.py")


class TestImports:
    def test_collects_project_imports_everywhere(self):
        src = ("import os\nimport strands.agent.agent as aa\nfrom strands.agent import Agent as A, run\n"
               "from strands import *\nfrom . import sibling\nfrom pytest import fixture\n"
               "def test_x():\n    from strands.tools import ToolRegistry\n")
        got = [(i["module"], i["name"]) for i in project_imports(src)]
        assert got == [("strands.agent.agent", None), ("strands.agent", "Agent"), ("strands.agent", "run"),
                       ("strands", None), ("strands.tools", "ToolRegistry")]


class TestStartCode:
    @pytest.mark.parametrize("name", ["Agent", "run", "arun", "X", "Y", "Z", "limit", "counter", "Hidden",
                                      "fastjson", "typing", "_Any"])
    def test_module_scope_bindings(self, name):
        assert start_code().defines("strands.agent.agent", name)

    @pytest.mark.parametrize("name", ["inner", "local_only", "Nope"])
    def test_not_module_scope(self, name):
        assert not start_code().defines("strands.agent.agent", name)

    def test_submodule_counts_as_defined(self):
        assert start_code().defines("strands.agent", "agent")

    def test_project_star_import_is_followed(self):
        s = start_code()
        assert s.defines("strands.tools", "ToolRegistry")
        assert not s.defines("strands.tools", "Missing")

    def test_opaque_modules_define_everything(self):
        s = start_code()
        assert s.defines("strands.lazy", "anything")
        assert s.defines("strands.ext", "anything")

    def test_namespace_package_exists(self):
        s = start_code()
        assert s.module_exists("strands.ns")
        assert s.first_missing("strands.ns.leaf") is None
        assert s.first_missing("strands.bidi.audio.io") == "strands.bidi"


class TestFileTriggers:
    def test_missing_name_not_in_prompt_triggers(self):
        src = "from strands.agent.agent import Agent, _new_helper\n"
        got = file_triggers(src, start_code(), "feat: add things\n")
        assert [(t["kind"], t["word"], t["line"]) for t in got] == [("name", "_new_helper", 1)]

    def test_missing_name_in_prompt_does_not_trigger(self):
        src = "from strands.agent.agent import _new_helper\n"
        assert file_triggers(src, start_code(), "feat: add `_new_helper` to agent\n") == []

    def test_missing_module_uses_first_missing_level(self):
        src = "from strands.bidi.audio import Buffer\n"
        got = file_triggers(src, start_code(), "feat: nothing about it\n")
        assert [(t["kind"], t["word"]) for t in got] == [("module", "bidi")]
        # 第一个不存在的一级在题面里出现即不触发（不再看其下的名字）
        assert file_triggers(src, start_code(), "feat(bidi): new\n") == []

    def test_import_module_statement(self):
        assert file_triggers("import strands.agent.agent\n", start_code(), "") == []
        got = file_triggers("import strands.agent.newmod\n", start_code(), "")
        assert [t["word"] for t in got] == ["newmod"]


class TestTaskAndList:
    STEP = {"seq": 7, "commit": "C", "parent": "P", "message": "feat: add _mentioned\n",
            "judgeTests": [T + "test_new.py"]}

    def human(self):
        return {
            T + "test_new.py": "from strands.agent.agent import _secret\n",
            T + "test_ok.py": "from strands.agent.agent import _mentioned\nfrom strands.agent import Agent\n",
            T + "test_bad.py": "def (:\n",
        }

    def f2p(self):
        return [T + "test_new.py::a", T + "test_new.py::b", T + "test_ok.py::c", T + "test_bad.py::d"]

    def test_analyze_task(self):
        read, tree = repo(START, self.human())
        t = analyze_task(self.STEP, self.f2p(), read, tree("P"))
        assert t["excluded"] == 2 and t["remaining"] == 2 and t["failToPass"] == 4
        assert [f["file"] for f in t["files"]] == [T + "test_new.py"]
        assert t["files"][0]["triggers"][0]["word"] == "_secret"
        # 语法错误的文件不判为不可猜，单列
        assert t["unparsable"] == [T + "test_bad.py"]

    def test_names_are_checked_against_start_not_human_commit(self):
        # 人在该提交里给开工代码新加的名字：按起点判，仍不存在
        human = {**self.human(), S + "agent/agent.py": START[S + "agent/agent.py"] + "_secret = 1\n"}
        read, tree = repo(START, human)
        t = analyze_task(self.STEP, self.f2p(), read, tree("P"))
        assert t["excluded"] == 2

    def test_build_list_summary_and_exclusions(self):
        read, tree = repo(START, self.human())
        other = {"seq": 9, "commit": "C", "parent": "P", "message": "m", "judgeTests": [T + "test_new.py"]}
        f2p = {7: self.f2p(), 9: [T + "test_new.py::a"]}
        data = build_list([self.STEP, other], f2p, read, tree)
        s = data["summary"]
        assert s["tasks"] == 2 and s["tasksWithUnguessableFiles"] == 2 and s["unguessableFiles"] == 2
        assert s["failToPassCases"] == 5 and s["excludedCases"] == 3
        assert s["tasksWithNoRemainingCases"] == [9]
        assert excluded_cases(data) == {7: {T + "test_new.py::a", T + "test_new.py::b"}, 9: {T + "test_new.py::a"}}
        assert remaining_cases(data) == {7: 2, 9: 0}
