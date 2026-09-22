#!/usr/bin/env python3
"""SWE-bench 判据命令：对一个实例的补丁调官方判分器，按结果给退出码。

退出码约定（与任务源一致）：
  0  已解决（FAIL_TO_PASS 与 PASS_TO_PASS 全部通过）
  1  未解决（含空补丁——什么都没改就是没修好）
  2  判分设施自身出错（读不出补丁、判分器异常或没产出报告等），不算任务失败

stdout 的最后一行是一个 JSON 对象，供验证记录收入。
补丁文件是官方预测格式：[{"instance_id", "model_name_or_path", "model_patch"}]。

官方判分器在生成测试规格时会从代码托管站的原始文件地址取各仓库的依赖清单（即使用的是预构建镜像），
且请求不带超时：该地址不可达时会永久挂起。这里在进程内调用判分器，并给这类请求加磁盘缓存、超时与
同内容镜像地址回退；全部失败按判分设施出错处理，不伪造内容。

评测容器的代理（--proxy，可选）：部分实例的官方测试要访问外网（链接检查、取远程图片），访问不到时连标准答案
补丁都判不过。给了 --proxy 才向评测容器注入 http_proxy / https_proxy / no_proxy；不给则一字不加。
这层只作用于本进程内由官方判分器创建的评测容器（名字以 sweb.eval. 开头）——判分跑的是官方测试脚本，没有模型
参与。agent 干活的工作区容器不由本脚本创建，代理配置够不着它，也不得复用到它身上。
--proxy 取值：完整地址（http://主机:端口），或 gateway:端口——每次判分时现取本机默认路由的网关地址
（ip route），不缓存、不写死：该地址在宿主重启后可能变化。
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import traceback
from pathlib import Path

RAW_PREFIX = "https://raw.githubusercontent.com/"
# 同内容镜像：<owner>/<repo>/<commit>/<path> → <镜像>/<owner>/<repo>@<commit>/<path>
RAW_MIRRORS = ["https://fastly.jsdelivr.net/gh/", "https://cdn.jsdelivr.net/gh/"]
FETCH_TIMEOUT = (5, 20)


def finish(code: int, **details) -> None:
    print(json.dumps(details, ensure_ascii=False))
    sys.exit(code)


def tail(path: Path, limit: int = 1500) -> str:
    try:
        return path.read_text(errors="replace")[-limit:]
    except OSError:
        return ""


def install_raw_file_cache(cache_dir: Path) -> None:
    """给判分器取原始文件的请求加缓存、超时与镜像回退（只拦这一类地址，其余请求原样放行）。"""
    import requests

    cache_dir.mkdir(parents=True, exist_ok=True)
    original_get = requests.get

    def cached_response(url: str, status: int, body: bytes):
        response = requests.models.Response()
        response.status_code = status
        response._content = body  # noqa: SLF001 —— 构造一个与真实响应同形的对象
        response.encoding = "utf-8"
        response.url = url
        return response

    def mirror_urls(url: str):
        owner, repo, commit, *rest = url[len(RAW_PREFIX) :].split("/")
        for mirror in RAW_MIRRORS:
            yield f"{mirror}{owner}/{repo}@{commit}/{'/'.join(rest)}"

    def patched_get(url, *args, **kwargs):
        if not isinstance(url, str) or not url.startswith(RAW_PREFIX):
            return original_get(url, *args, **kwargs)
        entry = cache_dir / hashlib.sha256(url.encode()).hexdigest()
        if entry.exists():
            record = json.loads(entry.read_text())
            return cached_response(url, record["status"], record["body"].encode("utf-8"))
        kwargs.setdefault("timeout", FETCH_TIMEOUT)
        last_error = None
        for candidate in [url, *mirror_urls(url)]:
            try:
                response = original_get(candidate, *args, **kwargs)
            except requests.RequestException as error:
                last_error = error
                continue
            # 200 与 404 都是确定的答案（判分器靠 404 判断换下一个候选路径）；其余状态换下一个地址再试
            if response.status_code in (200, 404):
                # 并行的判分进程共用缓存目录：先写临时文件再改名，读方看不到半截内容
                scratch = entry.with_suffix(f".{os.getpid()}.tmp")
                scratch.write_text(json.dumps({"status": response.status_code, "body": response.text}))
                scratch.replace(entry)
                return cached_response(url, response.status_code, response.content)
            last_error = RuntimeError(f"HTTP {response.status_code} from {candidate}")
        raise RuntimeError(f"取不到判分器需要的原始文件：{url}（{last_error}）")

    requests.get = patched_get


# 不走代理的目标：本机回环（官方测试自起的本地服务）与容器网段；容器网段在判分时从 docker 现取后追加
NO_PROXY_BASE = ["localhost", "127.0.0.1", "::1"]
EVAL_CONTAINER_PREFIX = "sweb.eval."
PROXY_VARS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]
NO_PROXY_VARS = ["no_proxy", "NO_PROXY"]


def resolve_proxy(spec: str) -> str:
    """gateway:端口 → 现取默认路由的网关；其余取值须是完整的 http(s) 地址。"""
    if spec.startswith("gateway:"):
        port = spec.split(":", 1)[1]
        if not port.isdigit():
            raise ValueError(f"--proxy 的端口不是数字：{spec}")
        routes = subprocess.run(
            ["ip", "route", "show", "default"], capture_output=True, text=True, timeout=10, check=True
        ).stdout.split()
        if "via" not in routes:
            raise RuntimeError("取不到默认路由的网关（ip route show default 没有 via）")
        return f"http://{routes[routes.index('via') + 1]}:{port}"
    if not spec.startswith(("http://", "https://")):
        raise ValueError(f"--proxy 须为 http(s)://主机:端口 或 gateway:端口：{spec}")
    return spec


def proxy_environment(proxy_url: str, container_subnets: list) -> dict:
    no_proxy = ",".join([*NO_PROXY_BASE, *container_subnets])
    return {**{name: proxy_url for name in PROXY_VARS}, **{name: no_proxy for name in NO_PROXY_VARS}}


def install_eval_container_proxy(proxy_spec: str) -> dict:
    """给本进程内创建的评测容器注入代理环境；返回注入的环境（供验证记录）。"""
    import docker
    from docker.models.containers import ContainerCollection

    proxy_url = resolve_proxy(proxy_spec)
    client = docker.from_env()
    subnets = sorted(
        {
            config["Subnet"]
            for network in client.networks.list()
            for config in ((network.attrs.get("IPAM") or {}).get("Config") or [])
            if config.get("Subnet")
        }
    )
    environment = proxy_environment(proxy_url, subnets)
    original_create = ContainerCollection.create

    def create_with_proxy(self, image, command=None, **kwargs):
        # 只认官方判分器建的评测容器；别的容器（若有）原样放行
        if str(kwargs.get("name", "")).startswith(EVAL_CONTAINER_PREFIX):
            merged = dict(environment)
            merged.update(kwargs.get("environment") or {})
            kwargs["environment"] = merged
        return original_create(self, image, command, **kwargs)

    ContainerCollection.create = create_with_proxy
    return environment


def empty_patch_progress(args) -> dict:
    """空补丁不跑测试：目标用例按定义一条没过（总数取自数据集）；回归用例没有观察值，不报。"""
    try:
        for line in Path(args.dataset).read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("instance_id") == args.instance:
                target = row.get("FAIL_TO_PASS")
                target = json.loads(target) if isinstance(target, str) else target
                return {"progress": {"target": {"passed": 0, "total": len(target)}}}
    except Exception:  # noqa: BLE001 —— 取不到总数就不报连续指标，不影响判决
        pass
    return {}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--instance", required=True)
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--namespace", default="swebench")
    parser.add_argument("--model-name", default="pigeon")
    parser.add_argument("--test-timeout", type=int, default=1800)
    parser.add_argument("--proxy", default=None, help="评测容器的代理：http(s)://主机:端口 或 gateway:端口")
    args = parser.parse_args()

    proxy_env = None
    work_dir = Path(args.work_dir).resolve()
    (work_dir / "reports").mkdir(parents=True, exist_ok=True)
    try:
        predictions = json.loads(Path(args.predictions).read_text())
        patch = next(p["model_patch"] for p in predictions if p["instance_id"] == args.instance)
    except Exception as error:  # noqa: BLE001 —— 任何读不出补丁的情况都是设施问题
        finish(2, resolved=False, reason="predictions-unreadable", error=str(error))

    if not patch.strip():
        finish(1, resolved=False, reason="empty-patch", emptyPatch=True, **empty_patch_progress(args))

    # 判分器的日志目录相对当前目录
    os.chdir(work_dir)
    try:
        install_raw_file_cache(work_dir / "http-cache")
        if args.proxy is not None:
            proxy_env = install_eval_container_proxy(args.proxy)
        from swebench.harness.run_evaluation import main as run_evaluation

        run_evaluation(
            dataset_name=args.dataset,
            split="test",
            instance_ids=[args.instance],
            predictions_path=args.predictions,
            max_workers=1,
            force_rebuild=False,
            cache_level="instance",
            clean=False,
            open_file_limit=4096,
            run_id=args.run_id,
            timeout=args.test_timeout,
            namespace=args.namespace,
            rewrite_reports=False,
            modal=False,
            report_dir=str(work_dir / "reports"),
        )
    except SystemExit:
        raise
    except BaseException as error:  # noqa: BLE001 —— 判分器内部任何异常都是设施问题
        finish(
            2,
            resolved=False,
            reason="harness-exception",
            error=f"{type(error).__name__}: {error}",
            trace=traceback.format_exc()[-1500:],
        )

    instance_dir = (
        work_dir / "logs" / "run_evaluation" / args.run_id / args.model_name.replace("/", "__") / args.instance
    )
    report_file = instance_dir / "report.json"
    if not report_file.exists():
        # 补丁取自 git、相对初始树，打不上即设施缺陷；没有报告一律按设施出错处理，留日志尾部供排查
        finish(2, resolved=False, reason="no-report", log=tail(instance_dir / "run_instance.log"))

    report = json.loads(report_file.read_text())[args.instance]
    status = report.get("tests_status", {})
    counts = {
        key: {"success": len(value.get("success", [])), "failure": len(value.get("failure", []))}
        for key, value in status.items()
    }
    resolved = bool(report.get("resolved"))
    # 连续指标：目标用例（FAIL_TO_PASS）与回归用例（PASS_TO_PASS）各通过几条
    progress = {}
    for name, key in (("target", "FAIL_TO_PASS"), ("regression", "PASS_TO_PASS")):
        if key in counts:
            progress[name] = {
                "passed": counts[key]["success"],
                "total": counts[key]["success"] + counts[key]["failure"],
            }
    finish(
        0 if resolved else 1,
        resolved=resolved,
        patchApplied=bool(report.get("patch_successfully_applied")),
        tests=counts,
        **({"progress": progress} if "target" in progress else {}),
        **({"evalProxy": proxy_env["https_proxy"], "evalNoProxy": proxy_env["no_proxy"]} if proxy_env else {}),
    )


if __name__ == "__main__":
    main()
