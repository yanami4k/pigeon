"""题面接口说明的抽取规则（决策 374）。用内存里的合成仓库：开工提交 P、人的提交 C。"""

from pigeon_analysis.task_interface import (
    build,
    coverage,
    patch_targets,
    prompt_with_interfaces,
    render_section,
    task_interfaces,
)
from pigeon_analysis.unguessable import task_prompt

S = "strands-py/src/strands/"
T = "strands-py/tests/strands/"

START = {
    S + "__init__.py": "",
    S + "agent/__init__.py": "from .agent import Agent\n",
    S + "agent/agent.py": "class Base:\n    def run(self):\n        pass\n\nclass Agent(Base):\n    pass\n",
}

HUMAN = {
    S + "agent/agent.py": (
        "from dataclasses import dataclass, field\n"
        "from pydantic import BaseModel, Field\n"
        "from typing import TypedDict, overload\n"
        "from rich.console import Console\n"
        "class Base:\n    def run(self):\n        pass\n"
        "    def _retry(self, times: int = 3) -> bool:\n        return True\n\n"
        "class Agent(Base):\n    pass\n\n"
        "def helper(x: int, *, scale: float = 1.0, cb=lambda: 0) -> str:\n"
        "    \"\"\"SECRET_DOC\"\"\"\n    return 'SECRET_BODY'\n\n"
        "async def fetch(url: str) -> bytes:\n    raise NotImplementedError\n\n"
        "@dataclass(kw_only=False)\nclass Config:\n    name: str\n    tags: list[str] = field(default_factory=list)\n"
        "    hidden: int = field(default=0, init=False)\n    limit: int = 5\n\n"
        "class Settings(BaseModel):\n    mode: str = Field('fast')\n    _cache: dict = {}\n\n"
        "class Shape(TypedDict):\n    w: int\n\n"
        "class Plain(Agent):\n    pass\n\n"
        "class Failure(Exception):\n    pass\n\n"
        "class Built:\n    def __init__(self, a, b: int = -1, *rest, **kw):\n        self.a = a\n\n"
        "TIMEOUT = 30\n"
    ),
    S + "agent/__init__.py": "from .agent import Agent, helper as helper\n",
    S + "bidi/__init__.py": "",
    S + "bidi/audio.py": "class Buffer:\n    def __init__(self, size: int):\n        pass\n",
}


def repo(start: dict[str, str], human: dict[str, str]):
    files = {"P": start, "C": {**start, **human}}

    def read(commit, path):
        return files[commit].get(path)

    def tree(commit):
        return sorted(files[commit])

    return read, tree


def run(test_source: str, f2p_extra: dict[str, str] | None = None):
    human = {**HUMAN, T + "test_new.py": test_source, **(f2p_extra or {})}
    read, tree = repo(START, human)
    step = {"seq": 3, "commit": "C", "parent": "P", "message": "feat: x\n", "judgeTests": [T + "test_new.py"]}
    f2p = [T + "test_new.py::a"] + [f + "::b" for f in (f2p_extra or {})]
    return task_interfaces(step, f2p, read, tree("P"), tree("C")), step, f2p, read, tree


def lines(result):
    return render_section(result["interfaces"]).splitlines()[1:]


class TestCollect:
    def test_patch_targets_string_and_object_forms(self):
        src = ("import strands.agent.agent as aa\nfrom strands.agent import Agent\n"
               "@patch('strands.agent.agent.helper')\ndef test_a(monkeypatch, mocker):\n"
               "    monkeypatch.setattr('strands.agent.agent.TIMEOUT', 1)\n"
               "    monkeypatch.setattr(aa, 'fetch', None)\n"
               "    mocker.patch.object(Agent, '_retry')\n"
               "    with mock.patch.dict('strands.agent.agent.REGISTRY', {}):\n        pass\n"
               "    patch.object(some_instance, 'x')\n    patch('os.getcwd')\n")
        paths, unresolved = patch_targets(src)
        assert paths == sorted(paths, key=paths.index)  # 去重、保持出现顺序
        assert set(paths) == {"strands.agent.agent.helper", "strands.agent.agent.TIMEOUT",
                              "strands.agent.agent.fetch", "strands.agent.Agent._retry",
                              "strands.agent.agent.REGISTRY"}
        assert unresolved == 1

    def test_imports_in_function_bodies_and_second_list_files_count(self):
        src = "def test_x():\n    from strands.agent.agent import helper\n"
        other = {T + "test_old.py": "from strands.bidi.audio import Buffer\n"}
        result, *_ = run(src, other)
        assert [m["module"] for m in result["interfaces"]] == ["strands.agent.agent", "strands.bidi.audio"]
        assert {n["name"] for m in result["interfaces"] for n in m["names"]} == {"helper", "Buffer"}


class TestExistence:
    def test_names_present_at_start_are_not_listed(self):
        # Agent、Base.run 起点就有；helper 与 Base._retry 是人新加的
        src = ("from strands.agent.agent import Agent, Base, helper\n"
               "@patch('strands.agent.agent.Base.run')\n@patch('strands.agent.agent.Agent._retry')\ndef test(): pass\n")
        result, *_ = run(src)
        # 新方法经基类取到签名
        assert lines(result) == ["strands.agent.agent", "  def Agent._retry(self, times: int = 3) -> bool",
                                 "  def helper(x: int, *, scale: float = 1.0, cb=...) -> str"]

    def test_new_module_is_marked_and_lists_its_names(self):
        # import 新模块本身也列出，只有模块一行
        result, *_ = run("from strands.bidi.audio import Buffer\nimport strands.bidi\n")
        assert lines(result) == ["strands.bidi (new module)", "strands.bidi.audio (new module)",
                                 "  class Buffer(size: int)"]


class TestSignatures:
    def test_rendered_signatures(self):
        src = ("from strands.agent.agent import helper, fetch, Config, Settings, Shape, Plain, Failure, Built, "
               "TIMEOUT, Console\n")
        result, *_ = run(src)
        assert lines(result) == [
            "strands.agent.agent",
            "  class Built(a, b: int = -1, *rest, **kw)",
            "  class Config(name: str, tags: list[str] = ..., limit: int = 5)",
            "  Console",
            "  class Failure",
            "  class Plain()",
            "  class Settings(*, mode: str = 'fast')",
            "  class Shape(*, w: int)",
            "  TIMEOUT",
            "  async def fetch(url: str) -> bytes",
            "  def helper(x: int, *, scale: float = 1.0, cb=...) -> str",
        ]
        assert result["signatureMissing"] == [
            {"module": "strands.agent.agent", "name": "Failure", "reason": "constructor not determined"}]

    def test_no_implementation_or_docstring(self):
        result, *_ = run("from strands.agent.agent import helper\n")
        text = render_section(result["interfaces"])
        assert "SECRET_DOC" not in text and "SECRET_BODY" not in text and "lambda" not in text


class TestDataAndCoverage:
    def test_build_records_digest_and_coverage_uses_new_prompt(self):
        src = "from strands.agent.agent import helper\n"
        result, step, f2p, read, tree = run(src)
        data = build([step], {3: f2p}, read, tree, "abcd")
        assert data["manifestDigest"] == "abcd" and data["summary"]["names"] == 1
        prompt = prompt_with_interfaces(step, f2p, result["interfaces"])
        assert prompt.startswith(task_prompt(step["message"], step["judgeTests"], f2p).rstrip("\n") + "\n\n")
        assert coverage([step], {3: f2p}, read, tree, data)["cases"] == 0
        # 没有接口说明时同一用例按 316 仍判不可猜
        empty = dict(data, tasks=[dict(data["tasks"][0], interfaces=[])])
        assert coverage([step], {3: f2p}, read, tree, empty)["cases"] == 1
