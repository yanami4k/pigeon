"""延续式跑批：strands-py 的依赖组合（镜像内使用，决策 148、152）。

两个子命令：
  requirements <pyproject.toml>  列出该版本 pyproject 要求的依赖（本体依赖、all 与 bidi-all 两组可选依赖的递归展开、
                                 hatch-test 与 hatch-static-analysis 两个环境的依赖），供构建镜像时解析与离线安装；
  select <pyproject.toml>        按偏好顺序（窗口终点在前、越早越后）选第一套满足约束的已装依赖组合，
                                 把 /opt/venv 链接切过去并打印组合名；一套都不满足时退出码 3，并列出各组合的冲突。
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
LINK = "/opt/venv"


def requirements(pyproject_path):
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
    return [r for r in reqs if r.marker is None or r.marker.evaluate()]


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


def select(pyproject_path):
    reqs = requirements(pyproject_path)
    report = []
    for v in VARIANTS:
        freeze_path = os.path.join(VENVS, v, "freeze.txt")
        if not os.path.exists(freeze_path):
            continue
        bad = violations(reqs, load_freeze(freeze_path))
        if not bad:
            tmp = LINK + ".next"
            if os.path.lexists(tmp):
                os.remove(tmp)
            os.symlink(os.path.join(VENVS, v), tmp)
            os.replace(tmp, LINK)
            print(v)
            return 0
        report.append(f"{v}: {'; '.join(bad)}")
    print("没有满足当前 pyproject 的依赖组合\n" + "\n".join(report), file=sys.stderr)
    return 3


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("requirements", "select"):
        print("用法：stream_env.py requirements|select <pyproject.toml>", file=sys.stderr)
        sys.exit(2)
    if sys.argv[1] == "requirements":
        for r in requirements(sys.argv[2]):
            print(str(r))
        sys.exit(0)
    sys.exit(select(sys.argv[2]))
