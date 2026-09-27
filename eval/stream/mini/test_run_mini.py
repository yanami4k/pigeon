"""run_mini.py 的离线测试（决策 194 的三处修复）：用装有 mini-swe-agent 的解释器运行
    python -m unittest eval/stream/mini/test_run_mini.py
容器内交卷识别的用例需要本机 Docker 与一个延续式跑批镜像：设 PIGEON_MINI_TEST_IMAGE（如 pigeon-stream-strands:v6），
不设即跳过。
"""

import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_mini  # noqa: E402

REQUEST = {
    "prompt": "p",
    "container": "c",
    "root": "/work",
    "maxTurns": 150,
    "docker": ["docker"],
    "modelBaseUrl": "http://127.0.0.1:1/j/s1%7Cminimal%7C1",
    "model": "deepseek-flash",
    "stepMarker": "m-1",
}


class BuildConfigsTest(unittest.TestCase):
    def test_env_drops_bash_env_and_keeps_step_marker(self):
        config = run_mini.load_swebench_config()
        self.assertEqual(config["environment"]["env"].get("BASH_ENV"), "/root/.bashrc", "上游配置原本带 BASH_ENV")
        _, env_config, _ = run_mini.build_configs(REQUEST, config, Path("out/result.json"))
        self.assertNotIn("BASH_ENV", env_config["env"])
        self.assertEqual(env_config["env"]["PIGEON_STEP_MARKER"], "m-1")
        self.assertEqual(env_config["env"]["PAGER"], "cat", "其余环境变量照旧")
        self.assertEqual(env_config["cwd"], "/work")

    def test_model_kwargs_match_pigeon(self):
        agent_config, _, model_config = run_mini.build_configs(
            REQUEST, run_mini.load_swebench_config(), Path("out/result.json")
        )
        self.assertEqual(agent_config["step_limit"], 150)
        self.assertEqual(agent_config["cost_limit"], 0, "成本上限由网关统一管，这里保持关闭")
        self.assertEqual(model_config["model_name"], "anthropic/deepseek-flash")
        kwargs = model_config["model_kwargs"]
        self.assertEqual(kwargs["max_tokens"], 16384)
        self.assertEqual(kwargs["temperature"], 0)
        self.assertEqual(kwargs["thinking"], {"type": "disabled"})
        self.assertIn("thinking", kwargs["allowed_openai_params"])
        self.assertEqual(kwargs["api_key"], "pigeon-gateway")
        self.assertTrue(kwargs["drop_params"], "配置原值照旧")

    def test_identity_reports_effective_kwargs(self):
        out = run_mini.identity()
        self.assertEqual(out["modelKwargs"]["max_tokens"], 16384)
        self.assertEqual(out["modelKwargs"]["thinking"], {"type": "disabled"})
        self.assertNotIn("api_key", out["modelKwargs"], "身份头不记网关地址与占位 key")


class _Capture(BaseHTTPRequestHandler):
    bodies: list = []
    headers_seen: list = []

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        _Capture.bodies.append(json.loads(body))
        _Capture.headers_seen.append(self.headers)
        reply = {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "deepseek-flash",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 5, "output_tokens": 1, "cache_read_input_tokens": 0},
        }
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class LitellmRequestBodyTest(unittest.TestCase):
    """经 litellm 的 anthropic 线路实际发出的请求体：关思考、输出上限、温度都在。"""

    def test_request_body(self):
        from minisweagent.models.litellm_model import LitellmModel

        server = HTTPServer(("127.0.0.1", 0), _Capture)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            request = {**REQUEST, "modelBaseUrl": f"http://127.0.0.1:{server.server_port}/j/job"}
            _, _, model_config = run_mini.build_configs(
                request, run_mini.load_swebench_config(), Path("out/result.json")
            )
            model = LitellmModel(**model_config)
            model._query([{"role": "user", "content": "hi"}])
        finally:
            server.shutdown()
        body = _Capture.bodies[-1]
        self.assertEqual(body["model"], "deepseek-flash")
        self.assertEqual(body["thinking"], {"type": "disabled"})
        self.assertEqual(body["max_tokens"], 16384)
        self.assertEqual(body["temperature"], 0)
        self.assertEqual(_Capture.headers_seen[-1].get("x-api-key"), "pigeon-gateway")


@unittest.skipUnless(os.environ.get("PIGEON_MINI_TEST_IMAGE"), "未设 PIGEON_MINI_TEST_IMAGE：跳过容器内交卷识别")
class SubmissionInContainerTest(unittest.TestCase):
    """在延续式跑批镜像的容器里（非 root 用户）执行交卷命令：去掉 BASH_ENV 后第一行即交卷标记，能被认出。"""

    @classmethod
    def setUpClass(cls):
        image = os.environ["PIGEON_MINI_TEST_IMAGE"]
        cls.container = subprocess.run(
            ["docker", "run", "-d", "--rm", "--network", "none", "--entrypoint", "sleep", image, "300"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "rm", "-f", cls.container], capture_output=True)

    def _env(self, env_config):
        return run_mini.ExistingContainerEnvironment(container=self.container, image="unused", **env_config)

    def test_submission_recognized(self):
        from minisweagent.exceptions import Submitted

        _, env_config, _ = run_mini.build_configs(
            {**REQUEST, "root": "/tmp"}, run_mini.load_swebench_config(), Path("out/result.json")
        )
        env = self._env(env_config)
        env._start_container()
        user = env.execute({"command": "id -u"})
        self.assertNotEqual(user["output"].strip().splitlines()[0], "0", "以非 root 用户执行")
        with self.assertRaises(Submitted) as raised:
            env.execute({"command": "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && echo diff-body"})
        self.assertEqual(raised.exception.messages[0]["extra"]["submission"].strip(), "diff-body")
        plain = env.execute({"command": "echo hello"})
        self.assertEqual(plain["output"].splitlines()[0], "hello", "输出第一行不再有权限报错")


if __name__ == "__main__":
    unittest.main()
