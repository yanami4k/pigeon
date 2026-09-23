"""延续式跑批：strands-py 的依赖组合（镜像内使用，决策 148、152）。

每套组合有两个虚拟环境：/opt/venvs/<组合> 为运行环境（Python 3.13，跑测试与 agent 的命令），/opt/lint/<组合> 为 lint 环境
（Python 3.10，与其 CI 的 lint 作业同一 Python 版本，跑 ruff 与 mypy）。两者都按该组合起始提交的日期解析依赖，
只取当时已发布的版本。PATH 上运行环境在前、lint 环境在后：python 落到运行环境，ruff 与 mypy 落到 lint 环境。

三个子命令：
  requirements <pyproject.toml> [runtime|lint]
      列出该版本 pyproject 要求的依赖（本体依赖、all 与 bidi-all 两组可选依赖的递归展开、hatch-test 与
      hatch-static-analysis 两个环境的依赖）。runtime 按 Python 3.13 求值环境标记、不含 ruff 与 mypy；
      lint 按 Python 3.10 求值环境标记。供构建镜像时安装；
  select <pyproject.toml>
      选这一版 pyproject 所属的组合：依赖声明与某组合起始提交完全相同的，即该组合（组合就是在依赖声明变化处切出来的，
      故与"起始日期不晚于该提交的最新一套"一致）；没有完全相同的，按偏好顺序（终点在前）取第一套满足约束的。
      把 /opt/venv 与 /opt/lint/current 两个链接切过去并打印组合名；一套都不满足时退出码 3，并列出各组合的冲突。
判断口径与产率测量时的 envcheck 相同，只是平台标记取容器自身（Linux）。
"""

import os
import sys
import tomllib

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version

VARIANTS = ["end", "V3", "V2", "V1", "V0"]
VENVS = "/opt/venvs"
LINTS = "/opt/lint"
LINK = "/opt/venv"
LINT_LINK = "/opt/lint/current"
HERE = os.path.dirname(os.path.abspath(__file__))
# 运行环境不装的静态检查工具：它们只在 lint 环境里（Python 3.10）
LINT_ONLY = {"ruff", "mypy"}
# 求值环境标记用的 Python 版本
MARKER_PYTHON = {"runtime": "3.13", "lint": "3.10"}


def requirements(pyproject_path, target="runtime"):
    with open(pyproject_path, "rb") as f:
        t = tomllib.load(f)
    proj = t["project"]
    extras = proj.get("optional-dependencies", {})
    reqs = [Requirement(r) for r in proj["dependencies"]]
    # bidi 测试在 bidi-all 并入 all 之前靠 bidi-all 单独装
    todo, seen = ["all", "bidi-all"], set()
    while todo:
        e = todo.pop()
        if e in seen:
            continue
        seen.add(e)
        for r in extras.get(e, []):
            rq = Requirement(r)
            if canonicalize_name(rq.name) == "strands-agents":
                todo.extend(rq.extras)
            else:
                reqs.append(rq)
    envs = t.get("tool", {}).get("hatch", {}).get("envs", {})
    for env in ("hatch-test", "hatch-static-analysis"):
        for r in envs.get(env, {}).get("dependencies", []):
            if isinstance(r, str) and "{root:uri}" not in r:
                rq = Requirement(r)
                if canonicalize_name(rq.name) != "strands-agents":
                    reqs.append(rq)
    version = MARKER_PYTHON[target]
    env = {"python_version": version, "python_full_version": f"{version}.0"}
    out = [r for r in reqs if r.marker is None or r.marker.evaluate(env)]
    if target == "runtime":
        out = [r for r in out if canonicalize_name(r.name) not in LINT_ONLY]
    return out


def load_freeze(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if "==" in line and not line.startswith(("-e", "#")):
                n, v = line.split("==", 1)
                out[canonicalize_name(n)] = Version(v.split("+")[0])
    return out


def violations(reqs, freeze):
    bad = []
    for rq in reqs:
        name = canonicalize_name(rq.name)
        if name not in freeze:
            bad.append(f"{rq} (missing)")
        elif not rq.specifier.contains(freeze[name], prereleases=True):
            bad.append(f"{rq} (have {freeze[name]})")
    return sorted(set(bad))


def declared(pyproject_path):
    return sorted(str(r) for r in requirements(pyproject_path))


def switch(link, target):
    tmp = link + ".next"
    if os.path.lexists(tmp):
        os.remove(tmp)
    os.symlink(target, tmp)
    os.replace(tmp, link)


def use(v):
    switch(LINK, os.path.join(VENVS, v))
    switch(LINT_LINK, os.path.join(LINTS, v))
    print(v)
    return 0


def select(pyproject_path):
    reqs = requirements(pyproject_path)
    installed = [v for v in VARIANTS if os.path.exists(os.path.join(VENVS, v, "freeze.txt"))]
    mine = declared(pyproject_path)
    for v in installed:
        start = os.path.join(HERE, f"pyproject-{v}.toml")
        if os.path.exists(start) and declared(start) == mine:
            if violations(reqs, load_freeze(os.path.join(VENVS, v, "freeze.txt"))):
                break
            return use(v)
    report = []
    for v in installed:
        bad = violations(reqs, load_freeze(os.path.join(VENVS, v, "freeze.txt")))
        if not bad:
            return use(v)
        report.append(f"{v}: {'; '.join(bad)}")
    print("没有满足当前 pyproject 的依赖组合\n" + "\n".join(report), file=sys.stderr)
    return 3


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "requirements" and args[2] in MARKER_PYTHON:
        for r in requirements(args[1], args[2]):
            print(str(r))
        sys.exit(0)
    if len(args) == 2 and args[0] == "requirements":
        for r in requirements(args[1]):
            print(str(r))
        sys.exit(0)
    if len(args) == 2 and args[0] == "select":
        sys.exit(select(args[1]))
    print("用法：stream_env.py requirements <pyproject.toml> [runtime|lint] | select <pyproject.toml>", file=sys.stderr)
    sys.exit(2)
