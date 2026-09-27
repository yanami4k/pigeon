"""延续式跑批的最简 agent 启动器（决策 099、155、194）：公开的最简实现 mini-swe-agent，沿用其 SWE-bench 配置的
系统与题面模板，只改以下几处——
  步数上限设为与其他条件同一轮数；不设成本上限（花费由网关统一计价与封顶）；墙钟由跑批器统一计时；
  去掉配置里的 BASH_ENV：它指向 /root/.bashrc，容器以非 root 用户执行命令时读不了，每条命令输出的第一行都是权限报错，
    交卷标记（要求在第一行）永远认不出；本项目的镜像用 ENV 设好 PATH，不需要 rc 文件；
  模型参数与 Pigeon 一致（决策 203）：单次输出上限 16384、温度 0、关思考。
命令在该流已有的断网容器里执行（不另起容器）；模型请求经跑批进程内置的网关，这里只拿到网关地址与占位 key。

用法：python run_mini.py <请求文件> <结果文件>
  请求：{ prompt, container, root, maxTurns, docker, modelBaseUrl, model }
  结果：{ status, turns, usage: { input, output, totalTokens }, exitStatus }；轨迹另存为结果文件旁的 trajectory.json
另：python run_mini.py --identity 打印 mini-swe-agent 与 litellm 的版本及实际生效的模型参数（身份头用）
"""

import json
import sys
from pathlib import Path

import yaml
from minisweagent.config import builtin_config_dir
from minisweagent.environments.docker import DockerEnvironment

PLACEHOLDER_KEY = "pigeon-gateway"
# 与 Pigeon 一致的模型参数（决策 203）
MAX_OUTPUT_TOKENS = 16384
TEMPERATURE = 0
# litellm 的 anthropic 线路只对它认得出"支持推理"的模型接收 thinking，deepseek-flash 不在它的表里，drop_params 为真时会被
# 静默丢掉；allowed_openai_params 放行这一个参数，请求体里才会带上 thinking disabled（DeepSeek 不发 thinking 即默认开思考）
THINKING = {"type": "disabled"}
# 配置里要去掉的环境变量
DROPPED_ENV = ("BASH_ENV",)


class ExistingContainerEnvironment(DockerEnvironment):
    """在跑批器建好的流容器里执行命令：不起新容器，也不在结束时移除它。"""

    def __init__(self, *, container: str, **kwargs):
        self._existing = container
        super().__init__(**kwargs)

    def _start_container(self):
        self.container_id = self._existing

    def cleanup(self):
        pass


def load_swebench_config() -> dict:
    return yaml.safe_load((builtin_config_dir / "benchmarks" / "swebench.yaml").read_text(encoding="utf-8"))


def model_kwargs(config: dict, base_url: str | None) -> dict:
    """实际发给 litellm 的模型参数：配置原值加上网关地址、占位 key 与和 Pigeon 一致的输出上限、温度、思考开关。"""
    allowed = list(config.get("model", {}).get("model_kwargs", {}).get("allowed_openai_params") or [])
    return {
        **config.get("model", {}).get("model_kwargs", {}),
        **({"api_base": base_url, "api_key": PLACEHOLDER_KEY} if base_url is not None else {}),
        "max_tokens": MAX_OUTPUT_TOKENS,
        "temperature": TEMPERATURE,
        "thinking": THINKING,
        "allowed_openai_params": [*allowed, *(p for p in ("thinking",) if p not in allowed)],
    }


def build_configs(request: dict, config: dict, result_file: Path) -> tuple[dict, dict, dict]:
    """由请求与 mini-swe-agent 的 SWE-bench 配置得出 agent、执行环境、模型三份配置。"""
    agent_config = dict(config["agent"])
    agent_config["step_limit"] = int(request["maxTurns"])
    agent_config["cost_limit"] = 0
    agent_config["output_path"] = result_file.parent / "trajectory.json"
    env_config = dict(config["environment"])
    env_config.pop("environment_class", None)
    env_config["cwd"] = request["root"]
    env_config["executable"] = (request.get("docker") or ["docker"])[0]
    env = {k: v for k, v in env_config.get("env", {}).items() if k not in DROPPED_ENV}
    # 本步标记：在容器里执行的每条命令都带上它，跑批器据此在这一步结束后清掉残留进程
    if request.get("stepMarker"):
        env["PIGEON_STEP_MARKER"] = request["stepMarker"]
    env_config["env"] = env
    model_config = dict(config["model"])
    model_config["model_name"] = f"anthropic/{request['model']}"
    model_config["model_kwargs"] = model_kwargs(config, request["modelBaseUrl"])
    model_config["cost_tracking"] = "ignore_errors"
    return agent_config, env_config, model_config


def identity() -> dict:
    import importlib.metadata as m

    out: dict = {}
    for k, p in (("miniSweAgent", "mini-swe-agent"), ("litellm", "litellm")):
        try:
            out[k] = m.version(p)
        except Exception:  # noqa: BLE001 —— 取不到即记 null
            out[k] = None
    try:
        out["modelKwargs"] = model_kwargs(load_swebench_config(), None)
    except Exception:  # noqa: BLE001
        out["modelKwargs"] = None
    return out


def main() -> int:
    if sys.argv[1:] == ["--identity"]:
        print(json.dumps(identity()))
        return 0
    from minisweagent.agents.default import DefaultAgent
    from minisweagent.models.litellm_model import LitellmModel

    request_file, result_file = Path(sys.argv[1]), Path(sys.argv[2])
    request = json.loads(request_file.read_text(encoding="utf-8"))
    agent_config, env_config, model_config = build_configs(request, load_swebench_config(), result_file)

    env = ExistingContainerEnvironment(container=request["container"], image="unused", **env_config)
    model = LitellmModel(**model_config)
    agent = DefaultAgent(model, env, **agent_config)
    exit_status = "unknown"
    try:
        info = agent.run(request["prompt"])
        exit_status = info.get("exit_status", "unknown")
    except Exception as e:  # noqa: BLE001 —— 任何异常都如实写进结果文件
        exit_status = type(e).__name__
    usage = {"input": 0, "output": 0, "totalTokens": 0}
    for message in agent.messages:
        response = (message.get("extra") or {}).get("response") or {}
        u = response.get("usage") or {}
        usage["input"] += int(u.get("prompt_tokens") or 0)
        usage["output"] += int(u.get("completion_tokens") or 0)
    usage["totalTokens"] = usage["input"] + usage["output"]
    status = {
        "Submitted": "completed",
        "LimitsExceeded": "turn-limit",
        "TimeExceeded": "wall-clock-limit",
    }.get(exit_status, "failed")
    result_file.write_text(
        json.dumps({"status": status, "turns": agent.n_calls, "usage": usage, "exitStatus": exit_status}),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
