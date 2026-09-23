# 延续式跑批：strands-py 流的工作区镜像（决策 148、152）。
# 构建上下文由 `pigeon eval stream-image-context --repo-profile strands` 组装：本文件、stream_env.py、
# 五套冻结依赖的版本约束（constraints-<组合>.txt）与各组合起始提交的 pyproject（pyproject-<组合>.toml）。
# 第一阶段联网把五套依赖解析并编译成 wheel 仓；第二阶段只从 wheel 仓离线安装（--no-index），
# 因此有了第一阶段的产物即可断网重建。工作区容器运行时恒为无网络（104）。
# 被测包本身不安装：代码一律经 PYTHONPATH 从工作区（或测量副本）的源码目录导入。但部分测试经 importlib.metadata
# 读 strands-agents 的版本号（产率测量时可编辑安装在场），故每套环境只放一份占位元数据（版本 1.0.0+stream，
# 不含代码），在记下依赖清单之后写入，不参与依赖组合的选择。

FROM python:3.13-slim-bookworm AS wheels
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential portaudio19-dev git \
 && rm -rf /var/lib/apt/lists/*
RUN python -m pip install --no-cache-dir "packaging>=24"
COPY . /opt/stream/
RUN set -e; cd /opt/stream; \
    for v in end V3 V2 V1 V0; do \
      python stream_env.py requirements pyproject-$v.toml > reqs-$v.txt; \
      pip wheel --no-cache-dir --wheel-dir /wheels -c constraints-$v.txt -r reqs-$v.txt; \
    done

FROM python:3.13-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends git libportaudio2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=wheels /wheels /wheels
COPY --from=wheels /opt/stream /opt/stream
RUN set -e; \
    for v in end V3 V2 V1 V0; do \
      python -m venv /opt/venvs/$v; \
      /opt/venvs/$v/bin/pip install --no-cache-dir --no-index --find-links /wheels \
        -c /opt/stream/constraints-$v.txt -r /opt/stream/reqs-$v.txt; \
      /opt/venvs/$v/bin/pip freeze > /opt/venvs/$v/freeze.txt; \
      site=$(/opt/venvs/$v/bin/python -c "import sysconfig; print(sysconfig.get_paths()['purelib'])"); \
      mkdir -p "$site/strands_agents-1.0.0+stream.dist-info"; \
      printf 'Metadata-Version: 2.1\nName: strands-agents\nVersion: 1.0.0+stream\n' \
        > "$site/strands_agents-1.0.0+stream.dist-info/METADATA"; \
    done; \
    ln -s /opt/venvs/end /opt/venv; \
    printf '#!/bin/sh\nexec /opt/venvs/end/bin/python /opt/stream/stream_env.py select "$@"\n' > /opt/stream/select-env; \
    chmod +x /opt/stream/select-env
ENV PATH=/opt/venv/bin:$PATH
# 容器里的一切命令（探针、判题、全量测量、人的基准、验证门、agent 的工具调用、撤回时的 git 操作）都以非 root 用户执行：
# 部分用例依赖"写不了无权限的路径"，以 root 跑会判错。工作区、测量副本目录与 /opt（切换依赖组合时替换 /opt/venv 链接）归它所有
RUN useradd --create-home --uid 10001 stream \
 && mkdir -p /testbed /measure \
 && chown stream:stream /testbed /measure /opt \
 && chown -h stream:stream /opt/venv
USER stream
WORKDIR /testbed
