"""延续式跑批的最简 agent 启动器（决策 099、155）：公开的最简实现 mini-swe-agent，原样使用其 SWE-bench 配置，
只改三处——步数上限设为与其他条件同一轮数、不设成本上限（上游模型不在 litellm 的价目表里）、墙钟由跑批器统一计时。
命令在该流已有的断网容器里执行（不另起容器）；模型请求经跑批进程内置的网关，这里只拿到网关地址与占位 key。

用法：python run_mini.py <请求文件> <结果文件>
  请求：{ prompt, container, root, maxTurns, docker, modelBaseUrl, model }
  结果：{ status, turns, usage: { input, output, totalTokens }, exitStatus }；轨迹另存为结果文件旁的 trajectory.json
"""

import json
import sys
from pathlib import Path

import yaml
from minisweagent.agents.default import DefaultAgent
from minisweagent.config import builtin_config_dir
from minisweagent.environments.docker import DockerEnvironment
from minisweagent.models.litellm_model import LitellmModel

PLACEHOLDER_KEY = "pigeon-gateway"


class ExistingContainerEnvironment(DockerEnvironment):
    """在跑批器建好的流容器里执行命令：不起新容器，也不在结束时移除它。"""

    def __init__(self, *, container: str, **kwargs):
        self._existing = container
        super().__init__(**kwargs)

    def _start_container(self):
        self.container_id = self._existing

    def cleanup(self):
        pass


def main() -> int:
    request_file, result_file = Path(sys.argv[1]), Path(sys.argv[2])
    request = json.loads(request_file.read_text(encoding="utf-8"))
    config = yaml.safe_load((builtin_config_dir / "benchmarks" / "swebench.yaml").read_text(encoding="utf-8"))
    agent_config = dict(config["agent"])
    agent_config["step_limit"] = int(request["maxTurns"])
    agent_config["cost_limit"] = 0
    agent_config["output_path"] = result_file.parent / "trajectory.json"
    env_config = dict(config["environment"])
    env_config.pop("environment_class", None)
    env_config["cwd"] = request["root"]
    env_config["executable"] = (request.get("docker") or ["docker"])[0]
    # 本步标记：在容器里执行的每条命令都带上它，跑批器据此在这一步结束后清掉残留进程
    if request.get("stepMarker"):
        env_config["env"] = {**env_config.get("env", {}), "PIGEON_STEP_MARKER": request["stepMarker"]}
    model_config = dict(config["model"])
    model_config["model_name"] = f"anthropic/{request['model']}"
    model_config["model_kwargs"] = {
        **model_config.get("model_kwargs", {}),
        "api_base": request["modelBaseUrl"],
        "api_key": PLACEHOLDER_KEY,
    }
    model_config["cost_tracking"] = "ignore_errors"

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
