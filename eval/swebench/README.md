# SWE-bench Verified 判据

外部基准任务源（decisions.md 097 / 102）用到的判据命令。任务源实现在 `src/eval/swebench-source.ts`，跑批入口是 `pigeon eval swebench`。

## 文件

- `judge.py`：判据命令。入参是数据集文件、实例 id、补丁文件（官方预测格式）、运行 id 与判分工作目录；它调官方判分器 `swebench.harness.run_evaluation` 对这一个实例判分，再读该实例的 `report.json` 给出退出码。stdout 的最后一行是一个 JSON 对象（是否已解决、补丁是否打上、两组测试的通过与失败数），随验证记录收入账本。

## 退出码约定

| 退出码 | 含义 | 结果行 |
|---|---|---|
| 0 | 已解决：FAIL_TO_PASS 与 PASS_TO_PASS 全部通过 | 判决通过 |
| 1 | 未解决；空补丁也算未解决 | 判决失败 |
| 2 | 判分设施自身出错：读不出补丁文件、判分器没有产出报告 | 未判定，记错误行，重跑同一输出目录时补跑 |

超时与被信号终止沿用既有口径记未判定。

## 环境前提

- 一个能直接调用的 docker 守护进程，以及各实例的官方评测镜像（命名 `swebench/sweb.eval.x86_64.<实例 id 小写、双下划线换成 _1776_>:latest`）。官方仓库拉不动时可从镜像站取同内容镜像后改成上述名字；跑批与判分都不主动构建镜像。
- 一个装有官方判分器的 Python 环境（已验证版本：swebench 4.1.0）。5.x 版改为由数据集自带镜像字段，与 Verified 现行数据不配套。
- 数据集为 JSONL，每行一个实例，字段沿用官方数据集（`instance_id`、`problem_statement`、`base_commit`、`patch`、`test_patch`、`FAIL_TO_PASS`、`PASS_TO_PASS`、`difficulty` 等）。

## 判分自检

改动判据管道后先用标准答案补丁自检，预期接近全绿；不通过就不要往下跑——否则分数低了分不清是管道坏了还是模型不行：

```
python -m swebench.harness.run_evaluation --dataset_name <数据集 JSONL> --predictions_path gold \
  --run_id gold --namespace swebench --cache_level instance --clean False --max_workers 5
```

自检里未通过的实例要逐个看失败用例：依赖外网的用例（链接检查、远程图片）在访问不到目标站点的网络环境下无法通过，属于环境限制，不是管道问题，也不是模型能解决的。

## 判分容器的代理（可选）

`judge.py --proxy <地址>`（跑批入口为 `pigeon eval swebench --judge-proxy <地址>`）只给判分阶段的评测容器注入 http_proxy / https_proxy / no_proxy；不给则一字不加。取值为 `http(s)://主机:端口`，或 `gateway:端口`——每次判分时现取本机默认路由的网关（`ip route show default`），不缓存：该地址在宿主重启后可能变化，不要写死。no_proxy 为本机回环加判分时从 docker 现取的容器网段，官方测试自起的本地服务与容器间通信不绕代理。

这层只作用于判据进程内由官方判分器创建的评测容器：判分跑的是官方测试脚本，没有模型参与。agent 干活的工作区容器由任务源另行创建，不读这项配置，也不得复用它；`src/eval/swebench-source.test.ts` 有用例钉住这一点。

## 取 diff 的口径

补丁相对仓库根、相对基准提交上的镜像初始状态：环境准备时把初始工作区写成一棵树，收工后再写一棵，取两棵树之差。镜像在基准提交之上自带的未提交改动（为固定依赖版本而改过的构建文件）不进补丁；官方测试补丁涉及的测试文件也不进补丁，且经编辑工具的写入会被直接拒绝。
