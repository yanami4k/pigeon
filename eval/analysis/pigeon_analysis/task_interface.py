"""题面的接口说明（决策 374）：静态规则，只看代码，不看任何结果。

对每题名单两段里的测试文件（本题新写或改过的测试文件，以及要做到的用例落在其外时它们所在的测试文件），取人在该步的
最终版本，收集两类引用：
- 对项目包（strands）的导入，文件里任何位置都算（含函数体内），收集法同 316（unguessable.project_imports）；
- 字符串形式的补丁目标：patch / mock.patch / mocker.patch / patch.dict / patch.multiple 的字符串路径，
  monkeypatch.setattr / delattr 的字符串路径形式；patch.object 与 monkeypatch.setattr / delattr 的对象形式
  （对象加属性名字符串），对象须能按该文件的项目内导入换算成模块里的名字，换算不出的只记数量。
字符串路径按人在该步的代码取最长的存在的模块前缀，其余为模块里的名字（至多再带一级属性，如类的方法）。

逐个对照该题开工代码（起点提交）判断存在，规则同 316（unguessable.StartCode：模块路径、模块作用域绑定、子模块；
无法静态判定的模块一律当作存在）；名字后还带一级属性的，再看起点里该类的类体（及能换算出的项目内基类）有没有这个属性，
不是类或基类换算不出即当作存在。不存在的模块与名字逐个从人在该步的代码里取签名：
- 类给构造参数：类体有 __init__ 取其参数（去掉 self）；dataclass、NamedTuple 以字段为位置参数，pydantic BaseModel 与
  TypedDict 以字段为仅限关键字参数（项目内基类的字段排在前面）；没有 __init__ 时沿项目内基类找；基类只有 object、ABC、
  Protocol、Generic 时为空参数；其余（项目外基类、Enum 等）只给名字；
- 函数（含方法）给参数与返回注解；
- 其余只给名字。
注解原样给出；缺省值是常量、名字、属性、负数或空容器的原样给出，否则写作 ...。不给实现、文档字符串与断言。
人的代码里找不到定义、或类的构造参数定不下来的，单列为取不到签名。

已知局限（写进审计）：getattr、importlib 等动态引用不收；测试辅助文件（conftest、夹具）不查；对已存在的名字只判存在，
不判签名是否变了；对已存在的类用到的新属性只在补丁目标里能查到，普通的属性访问不查；断言里的精确文案不处理。
"""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
from typing import Any, Callable, Iterable

from .unguessable import (
    PACKAGE,
    SRC_ROOT,
    ReadFile,
    StartCode,
    _module_scope,
    _resolve_from,
    case_file,
    file_triggers,
    git_reader,
    load_fail_to_pass,
    project_imports,
    task_prompt,
)

# 接口说明一节的说明行（与 src/eval/stream-manifest.ts 的 INTERFACES_HEADING 逐字一致）
INTERFACES_HEADING = ("Modules and names used by these tests that are not in the repository yet "
                      "(listed by signature):")

# 没有构造参数的基类：类体又没有 __init__ 时构造参数为空
_EMPTY_BASES = {"object", "ABC", "Protocol", "Generic"}


def _in_project(module: str) -> bool:
    return module == PACKAGE or module.startswith(PACKAGE + ".")


def _dotted(node: ast.AST) -> str | None:
    """Name 与 Attribute 链的点号写法（a.b.c）；别的表达式为 None。"""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return None if base is None else f"{base}.{node.attr}"
    return None


def _str_arg(call: ast.Call, index: int, keyword: str | None = None) -> str | None:
    if keyword is not None:
        for k in call.keywords:
            if k.arg == keyword and isinstance(k.value, ast.Constant) and isinstance(k.value.value, str):
                return k.value.value
    if len(call.args) > index:
        a = call.args[index]
        if isinstance(a, ast.Constant) and isinstance(a.value, str):
            return a.value
    return None


def _file_bindings(tree: ast.Module) -> dict[str, tuple[str, str | None]]:
    """测试文件里项目内导入绑定的名字：名字 → (模块, 模块里的名字)；import 模块绑定的为 (模块, None)。"""
    out: dict[str, tuple[str, str | None]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if _in_project(a.name):
                    if a.asname:
                        out[a.asname] = (a.name, None)
                    else:
                        out[a.name.split(".")[0]] = (a.name.split(".")[0], None)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and _in_project(node.module or ""):
            for a in node.names:
                if a.name != "*":
                    out[a.asname or a.name] = (node.module or "", a.name)
    return out


def _object_path(expr: ast.AST, bindings: dict[str, tuple[str, str | None]]) -> str | None:
    """补丁对象表达式 → 项目内的点号路径（模块加名字）；换算不出为 None。"""
    dotted = _dotted(expr)
    if dotted is None:
        return None
    head, _, rest = dotted.partition(".")
    if head not in bindings:
        return None
    module, name = bindings[head]
    base = module if name is None else f"{module}.{name}"
    return f"{base}.{rest}" if rest else base


def patch_targets(source: str) -> tuple[list[str], int]:
    """测试文件里字符串形式的补丁目标（项目内的点号路径，按出现顺序去重），与换算不出的对象形式的个数。"""
    tree = ast.parse(source)
    bindings = _file_bindings(tree)
    paths: list[str] = []
    unresolved = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        callee = _dotted(node.func) or ""
        last = callee.rpartition(".")[2]
        target: str | None = None
        obj_form = False
        if callee.endswith("patch.object"):
            obj_form = True
        elif last == "patch" or callee.endswith(("patch.dict", "patch.multiple")):
            target = _str_arg(node, 0, "target" if last == "patch" else "in_dict")
        elif callee.endswith(("monkeypatch.setattr", "monkeypatch.delattr")):
            target = _str_arg(node, 0)
            if target is None:
                obj_form = True
            elif last == "setattr" and len(node.args) > 2:
                target = None
        if obj_form:
            attr = _str_arg(node, 1, "attribute")
            if attr is None or not node.args:
                continue
            base = _object_path(node.args[0], bindings)
            if base is None:
                unresolved += 1
                continue
            target = f"{base}.{attr}"
        if target is not None and _in_project(target) and target not in paths:
            paths.append(target)
    return paths, unresolved


class CodeIndex:
    """一个提交里项目包的定义：按模块与名字找到定义它的语句（沿项目内的 from-import 与星号导入追下去）。"""

    def __init__(self, paths: Iterable[str], read: Callable[[str], "str | None"]):
        self.code = StartCode(paths, read)
        self._trees: dict[str, ast.Module | None] = {}

    def tree(self, module: str) -> ast.Module | None:
        if module not in self._trees:
            source = self.code._source_of(module)
            try:
                self._trees[module] = None if source is None else ast.parse(source)
            except SyntaxError:
                self._trees[module] = None
        return self._trees[module]

    def find(self, module: str, name: str,
             seen: frozenset[tuple[str, str]] = frozenset()) -> tuple[str, ast.AST] | None:
        """模块作用域里最后一处绑定 name 的定义（类、函数或赋值语句）与它所在的模块；导入来的追到项目内的源头；
        找不到为 None。"""
        if (module, name) in seen:
            return None
        seen = seen | {(module, name)}
        tree = self.tree(module)
        if tree is None:
            return None
        package = module if self.code._source_is_package(module) else module.rpartition(".")[0]
        found: tuple[str, ast.AST] | None = None
        for node in _module_scope(tree.body):
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
                if not _is_overload(node):
                    found = (module, node)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)) and name in _assigned(node):
                found = (module, node)
            elif isinstance(node, ast.Import):
                if any((a.asname or a.name.split(".")[0]) == name for a in node.names):
                    found = (module, node)
            elif isinstance(node, ast.ImportFrom):
                target = _resolve_from(node, package)
                for a in node.names:
                    if target is None or not _in_project(target):
                        # 项目外导入来的名字：定义不在项目里，只给名字
                        if (a.asname or a.name) == name:
                            found = (module, node)
                    elif a.name == "*" or (a.asname or a.name) == name:
                        found = self.find(target, name if a.name == "*" else a.name, seen) or found
        return found

    def resolve_class(self, module: str, expr: ast.expr) -> tuple[str, ast.ClassDef] | None:
        """基类表达式所指的项目内类（模块里的名字，含经项目内导入带进来的）与它所在的模块；换算不出为 None。"""
        dotted = _dotted(expr.value if isinstance(expr, ast.Subscript) else expr)
        hit = self.find(module, dotted) if dotted is not None and "." not in dotted else None
        if hit is None or not isinstance(hit[1], ast.ClassDef):
            return None
        return hit[0], hit[1]


def _is_overload(node: ast.AST) -> bool:
    return any((_dotted(d) or "").rpartition(".")[2] == "overload" for d in getattr(node, "decorator_list", []))


def _assigned(node: ast.Assign | ast.AnnAssign) -> set[str]:
    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
    out: set[str] = set()
    for t in targets:
        if isinstance(t, ast.Name):
            out.add(t.id)
        elif isinstance(t, (ast.Tuple, ast.List)):
            out |= {e.id for e in t.elts if isinstance(e, ast.Name)}
    return out


def _class_body(cls: ast.ClassDef) -> Iterable[ast.stmt]:
    return _module_scope(cls.body)


def _class_attr(cls: ast.ClassDef, attr: str) -> ast.AST | None:
    found: ast.AST | None = None
    for node in _class_body(cls):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == attr:
            if not _is_overload(node):
                found = node
        elif isinstance(node, (ast.Assign, ast.AnnAssign)) and attr in _assigned(node):
            found = node
    return found


# ---------- 签名 ----------

def _default(expr: ast.expr) -> str:
    simple = (isinstance(expr, (ast.Constant, ast.Name, ast.Attribute))
              or (isinstance(expr, ast.UnaryOp) and isinstance(expr.operand, ast.Constant))
              or (isinstance(expr, (ast.List, ast.Tuple, ast.Set)) and not expr.elts)
              or (isinstance(expr, ast.Dict) and not expr.keys))
    return ast.unparse(expr) if simple else "..."


def _param(arg: ast.arg, default: ast.expr | None = None, prefix: str = "") -> str:
    text = prefix + arg.arg
    if arg.annotation is not None:
        text += ": " + ast.unparse(arg.annotation)
    if default is not None:
        text += (" = " if arg.annotation is not None else "=") + _default(default)
    return text


def _params(args: ast.arguments, drop_first: bool = False) -> list[str]:
    positional = list(args.posonlyargs) + list(args.args)
    defaults: list[ast.expr | None] = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    out = [_param(a, d) for a, d in zip(positional, defaults)]
    if args.posonlyargs:
        out.insert(len(args.posonlyargs), "/")
    if args.vararg is not None:
        out.append(_param(args.vararg, prefix="*"))
    elif args.kwonlyargs:
        out.append("*")
    out += [_param(a, d) for a, d in zip(args.kwonlyargs, args.kw_defaults)]
    if args.kwarg is not None:
        out.append(_param(args.kwarg, prefix="**"))
    if drop_first and out and out[0] != "/":
        out = out[1:]
        if out and out[0] == "/":
            out = out[1:]
    return out


def _field_style(cls: ast.ClassDef) -> str | None:
    """以字段为参数的类：dataclass 与 NamedTuple 为 "positional"，pydantic 与 TypedDict 为 "keyword"；其余为 None。"""
    for d in cls.decorator_list:
        name = _dotted(d.func if isinstance(d, ast.Call) else d) or ""
        if name.rpartition(".")[2] == "dataclass":
            kw = isinstance(d, ast.Call) and any(
                k.arg == "kw_only" and isinstance(k.value, ast.Constant) and k.value.value is True for k in d.keywords)
            return "keyword" if kw else "positional"
    for b in cls.bases:
        name = (_dotted(b.value if isinstance(b, ast.Subscript) else b) or "").rpartition(".")[2]
        if name == "NamedTuple":
            return "positional"
        if name in ("BaseModel", "TypedDict"):
            return "keyword"
    return None


def _field_params(cls: ast.ClassDef, style: str) -> list[str]:
    """类体里以字段为参数的部分；仅限关键字的字段前带一个 *。"""
    out: list[str] = []
    keyword = style == "keyword"
    for node in cls.body:
        if not (isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)):
            continue
        ann = ast.unparse(node.annotation)
        name = node.target.id
        if ann.rpartition(".")[2] == "KW_ONLY":
            keyword = True
            continue
        if ann.split("[")[0].rpartition(".")[2] == "ClassVar" or (style == "keyword" and name.startswith("_")):
            continue
        text = f"{name}: {ann}"
        value = node.value
        if isinstance(value, ast.Call) and (_dotted(value.func) or "").rpartition(".")[2] in ("field", "Field"):
            kws = {k.arg: k.value for k in value.keywords}
            init = kws.get("init")
            if isinstance(init, ast.Constant) and init.value is False:
                continue
            given = kws.get("default", value.args[0] if value.args else None)
            if given is not None and not (isinstance(given, ast.Constant) and given.value is Ellipsis):
                text += " = " + _default(given)
            elif "default_factory" in kws:
                text += " = ..."
        elif value is not None:
            text += " = " + _default(value)
        if keyword and "*" not in out:
            out.append("*")
        out.append(text)
    return out


def _base_name(expr: ast.expr) -> str:
    return (_dotted(expr.value if isinstance(expr, ast.Subscript) else expr) or "").rpartition(".")[2]


def _constructor(index: CodeIndex, module: str, cls: ast.ClassDef, depth: int = 0) -> list[str] | None:
    """类的构造参数；定不下来为 None。"""
    init = _class_attr(cls, "__init__")
    if isinstance(init, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return _params(init.args, drop_first=True)
    style = _field_style(cls)
    bases = [index.resolve_class(module, b) if depth < 10 else None for b in cls.bases]
    if style is not None:
        inherited = [p for b in bases if b is not None and _field_style(b[1]) is not None
                     for p in (_constructor(index, b[0], b[1], depth + 1) or []) if p != "*"]
        own = _field_params(cls, style)
        if style == "keyword":
            fields = inherited + [p for p in own if p != "*"]
            return ["*"] + fields if fields else []
        return inherited + own
    for b, expr in zip(bases, cls.bases):
        if b is not None:
            return _constructor(index, b[0], b[1], depth + 1)
        if _base_name(expr) not in _EMPTY_BASES:
            return None
    return []


def signature(index: CodeIndex, module: str, qualname: str) -> tuple[dict[str, Any], str | None]:
    """人的代码里 module 中 qualname（名字，或 类.属性）的签名：{name, kind, params, returns}；取不到时另给原因。
    kind 为 class、function、async function 或 other；params 为参数表（不带括号），returns 为返回注解，没有为 None。"""
    head, _, attr = qualname.partition(".")
    hit = index.find(module, head)
    node = hit[1] if hit is not None else None
    if hit is not None:
        module = hit[0]
    if attr:
        found = _lookup_attr(index, module, node, attr) if isinstance(node, ast.ClassDef) else None
        node = found if isinstance(found, ast.AST) else None
    entry: dict[str, Any] = {"name": qualname, "kind": "other", "params": None, "returns": None}
    if node is None:
        return entry, "definition not found"
    if isinstance(node, ast.ClassDef):
        params = _constructor(index, module, node)
        entry["kind"] = "class"
        if params is None:
            return entry, "constructor not determined"
        entry["params"] = ", ".join(params)
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        entry["kind"] = "async function" if isinstance(node, ast.AsyncFunctionDef) else "function"
        entry["params"] = ", ".join(_params(node.args))
        entry["returns"] = ast.unparse(node.returns) if node.returns is not None else None
    return entry, None


# ---------- 一题与全部题 ----------

def _split_path(human: StartCode, path: str) -> tuple[str, str]:
    """点号路径 → (人的代码里存在的最长模块前缀, 其余的名字)；名字至多两级（名字.属性）。"""
    parts = path.split(".")
    for k in range(len(parts), 0, -1):
        module = ".".join(parts[:k])
        if human.module_exists(module):
            return module, ".".join(parts[k:k + 2])
    return parts[0], ".".join(parts[1:3])


# 类的属性查不下去（有换算不出的项目外基类）：存在与否无法静态判定
_OPAQUE = object()


def _lookup_attr(index: CodeIndex, module: str, cls: ast.ClassDef, attr: str, depth: int = 0) -> Any:
    """类体里（及能换算出的项目内基类里）定义 attr 的语句；没有为 None；有换算不出的基类（object 等除外）时为 _OPAQUE。"""
    node = _class_attr(cls, attr)
    if node is not None:
        return node
    opaque = False
    for expr in cls.bases:
        base = index.resolve_class(module, expr)
        if base is None:
            opaque = opaque or _base_name(expr) not in _EMPTY_BASES
        elif depth < 10:
            hit = _lookup_attr(index, base[0], base[1], attr, depth + 1)
            if isinstance(hit, ast.AST):
                return hit
            opaque = opaque or hit is _OPAQUE
    return _OPAQUE if opaque else None


def _start_has_attr(index: CodeIndex, module: str, head: str, attr: str) -> bool:
    """起点里 module 中的 head 有没有属性 attr：不是类，或查不下去，一律当作有。"""
    hit = index.find(module, head)
    if hit is None or not isinstance(hit[1], ast.ClassDef):
        return True
    return _lookup_attr(index, hit[0], hit[1], attr) is not None


def task_interfaces(step: dict[str, Any], fail_to_pass: list[str], read: ReadFile,
                    start_paths: Iterable[str], human_paths: Iterable[str]) -> dict[str, Any]:
    """一题的接口说明：缺的模块（newModule）与其中缺的名字及签名，按模块、名字排序。"""
    start = CodeIndex(start_paths, lambda p: read(step["parent"], p))
    human = CodeIndex(human_paths, lambda p: read(step["commit"], p))
    judge = list(step["judgeTests"])
    files = judge + sorted({case_file(c) for c in fail_to_pass} - set(judge))
    wanted: list[tuple[str, str]] = []
    unparsable: list[str] = []
    unresolved = 0
    for f in files:
        source = read(step["commit"], f)
        try:
            if source is None:
                raise SyntaxError(f)
            refs = [(i["module"], i["name"] or "") for i in project_imports(source)]
            paths, n = patch_targets(source)
        except SyntaxError:
            unparsable.append(f)
            continue
        unresolved += n
        refs += [_split_path(human.code, p) for p in paths]
        wanted += [r for r in refs if r not in wanted]
    modules: dict[str, dict[str, Any]] = {}
    missing_sig: list[dict[str, str]] = []
    for module, qualname in wanted:
        head, _, attr = qualname.partition(".")
        if head and human.code.module_exists(f"{module}.{head}") and not start.code.module_exists(
                f"{module}.{head}"):
            # from 包 import 新的子模块：记为新模块
            module, head, attr = f"{module}.{head}", "", ""
        elif start.code.first_missing(module) is not None:
            # 模块不存在时只看名字本身，不再看其下的属性
            attr = ""
        elif not head or (start.code.defines(module, head)
                          and (not attr or _start_has_attr(start, module, head, attr))):
            continue
        elif not start.code.defines(module, head):
            attr = ""
        entry = modules.setdefault(module, {"module": module,
                                            "newModule": start.code.first_missing(module) is not None, "names": []})
        name = f"{head}.{attr}" if attr else head
        if not name or any(n["name"] == name for n in entry["names"]):
            continue
        sig, reason = signature(human, module, name)
        entry["names"].append(sig)
        if reason is not None:
            missing_sig.append({"module": module, "name": name, "reason": reason})
    interfaces = [dict(m, names=sorted(m["names"], key=lambda n: n["name"])) for _, m in sorted(modules.items())]
    return {"seq": step["seq"], "commit": step["commit"], "parent": step["parent"], "interfaces": interfaces,
            "signatureMissing": missing_sig, "unresolvedPatchObjects": unresolved, "unparsable": unparsable}


def render_section(interfaces: list[dict[str, Any]]) -> str:
    """接口说明一节（与 src/eval/stream-manifest.ts 的 interfacesSection 同一版式）；没有内容为空串。"""
    if not interfaces:
        return ""
    lines = [INTERFACES_HEADING]
    for m in interfaces:
        lines.append(m["module"] + (" (new module)" if m["newModule"] else ""))
        for n in m["names"]:
            lines.append("  " + render_name(n))
    return "\n".join(lines)


def render_name(n: dict[str, Any]) -> str:
    if n["kind"] == "other" or n["params"] is None:
        return ("class " if n["kind"] == "class" else "") + n["name"]
    keyword = {"class": "class", "function": "def", "async function": "async def"}[n["kind"]]
    returns = f" -> {n['returns']}" if n["returns"] is not None else ""
    return f"{keyword} {n['name']}({n['params']}){returns}"


def prompt_with_interfaces(step: dict[str, Any], fail_to_pass: list[str], interfaces: list[dict[str, Any]]) -> str:
    """带接口说明的 test-files 题面：316 的题面版式之后接上接口说明一节。"""
    base = task_prompt(step["message"], list(step["judgeTests"]), fail_to_pass)
    section = render_section(interfaces)
    return base if not section else base[:-1] + "\n\n" + section + "\n"


def manifest_digest(manifest: Path) -> str:
    """清单文件的摘要，同跑批器 manifestDigestOf：内容逐字的 sha256 取前 16 位。"""
    return hashlib.sha256(manifest.read_bytes()).hexdigest()[:16]


def build(steps: list[dict[str, Any]], fail_to_pass: dict[int, list[str]], read: ReadFile,
          tree: Callable[[str], list[str]], digest: str) -> dict[str, Any]:
    tasks = [task_interfaces(s, fail_to_pass[s["seq"]], read, tree(s["parent"]), tree(s["commit"])) for s in steps]
    return {
        "rule": "decisions 374",
        "manifestDigest": digest,
        "summary": {
            "tasks": len(tasks),
            "tasksWithInterfaces": sum(1 for t in tasks if t["interfaces"]),
            "newModules": sum(1 for t in tasks for m in t["interfaces"] if m["newModule"]),
            "names": sum(len(m["names"]) for t in tasks for m in t["interfaces"]),
            "signatureMissing": sum(len(t["signatureMissing"]) for t in tasks),
            "unresolvedPatchObjects": sum(t["unresolvedPatchObjects"] for t in tasks),
            "unparsableFiles": sum(len(t["unparsable"]) for t in tasks),
        },
        "tasks": tasks,
    }


def coverage(steps: list[dict[str, Any]], fail_to_pass: dict[int, list[str]], read: ReadFile,
             tree: Callable[[str], list[str]], data: dict[str, Any]) -> dict[str, Any]:
    """覆盖检查：用 316 的规则重判，题面换成带接口说明的新题面；列出仍有触发项的文件与用例。"""
    by_seq = {t["seq"]: t["interfaces"] for t in data["tasks"]}
    remaining: list[dict[str, Any]] = []
    for s in steps:
        f2p = fail_to_pass[s["seq"]]
        prompt = prompt_with_interfaces(s, f2p, by_seq.get(s["seq"], []))
        start = StartCode(tree(s["parent"]), lambda p, s=s: read(s["parent"], p))
        by_file: dict[str, int] = {}
        for c in f2p:
            by_file[case_file(c)] = by_file.get(case_file(c), 0) + 1
        for f in sorted(by_file):
            source = read(s["commit"], f)
            try:
                triggers = [] if source is None else file_triggers(source, start, prompt)
            except SyntaxError:
                continue
            if triggers:
                remaining.append({"seq": s["seq"], "file": f, "cases": by_file[f], "triggers": triggers})
    return {
        "tasks": len({r["seq"] for r in remaining}),
        "files": len(remaining),
        "cases": sum(r["cases"] for r in remaining),
        "remaining": remaining,
    }


def generate(manifest: Path, repo: Path, classes_dir: Path, out: Path,
             coverage_out: Path | None = None) -> dict[str, Any]:
    steps = [s for s in json.loads(manifest.read_text(encoding="utf-8"))["steps"] if s["kind"] == "task"]
    read, tree = git_reader(repo)
    f2p = load_fail_to_pass(steps, classes_dir)
    data = build(steps, f2p, read, tree, manifest_digest(manifest))
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    if coverage_out is not None:
        cov = coverage(steps, f2p, read, tree, data)
        coverage_out.write_text(json.dumps(cov, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return data

