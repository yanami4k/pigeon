# 延续式跑批：strands-py 流的工作区镜像（决策 148、152）。
# 构建上下文由 `pigeon eval stream-image-context --repo-profile strands` 组装：本文件、stream_env.py、各依赖组合起始提交的
# pyproject（pyproject-<组合>.toml）与起始提交的日期（env-dates.txt，每行"组合 日期"）。
# 每套组合两个虚拟环境，都按该组合起始提交的日期解析依赖（uv 的 --exclude-newer：只取当时已发布的版本）：
#   /opt/venvs/<组合>：运行环境，Python 3.13，跑测试与 agent 的命令，不装 ruff 与 mypy；
#   /opt/lint/<组合>：lint 环境，Python 3.10（与其 CI 的 lint 作业同一版本），装 ruff、mypy 与类型检查所需的依赖。
# PATH 上运行环境在前、lint 环境在后：python 落到运行环境，ruff 与 mypy 落到 lint 环境。
# 构建时联网；工作区容器运行时恒为无网络（104）。
# 被测包本身不安装：代码一律经 PYTHONPATH 从工作区（或测量副本）的源码目录导入。但部分测试经 importlib.metadata
# 读 strands-agents 的版本号（产率测量时可编辑安装在场），故每套运行环境只放一份占位元数据（版本 1.0.0+stream，
# 不含代码），在记下依赖清单之后写入，不参与依赖组合的选择。

FROM python:3.13-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends git libportaudio2 build-essential portaudio19-dev \
 && rm -rf /var/lib/apt/lists/*
RUN python -m pip install --no-cache-dir "packaging>=24" "uv==0.8.4"
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_NO_CACHE=1 UV_LINK_MODE=copy
RUN uv python install 3.10
COPY . /opt/stream/
RUN set -e; cd /opt/stream; \
    while read -r v date; do \
      [ -n "$v" ] || continue; \
      python stream_env.py requirements pyproject-$v.toml runtime > reqs-$v.txt; \
      python stream_env.py requirements pyproject-$v.toml lint > lint-reqs-$v.txt; \
      uv venv -q --python /usr/local/bin/python3.13 /opt/venvs/$v; \
      uv pip install -q --python /opt/venvs/$v/bin/python --exclude-newer "$date" -r reqs-$v.txt; \
      uv pip freeze --python /opt/venvs/$v/bin/python > /opt/venvs/$v/freeze.txt; \
      site=$(/opt/venvs/$v/bin/python -c "import sysconfig; print(sysconfig.get_paths()['purelib'])"); \
      mkdir -p "$site/strands_agents-1.0.0+stream.dist-info"; \
      printf 'Metadata-Version: 2.1\nName: strands-agents\nVersion: 1.0.0+stream\n' \
        > "$site/strands_agents-1.0.0+stream.dist-info/METADATA"; \
      uv venv -q --python 3.10 /opt/lint/$v; \
      uv pip install -q --python /opt/lint/$v/bin/python --exclude-newer "$date" -r lint-reqs-$v.txt; \
      uv pip freeze --python /opt/lint/$v/bin/python > /opt/lint/$v/freeze.txt; \
    done < env-dates.txt; \
    ln -s /opt/venvs/end /opt/venv; \
    ln -s /opt/lint/end /opt/lint/current; \
    printf '#!/bin/sh\nexec /usr/local/bin/python3 /opt/stream/stream_env.py select "$@"\n' > /opt/stream/select-env; \
    chmod +x /opt/stream/select-env
ENV PATH=/opt/venv/bin:/opt/lint/current/bin:$PATH
# 容器里的一切命令（探针、判题、全量测量、人的基准、验证门、agent 的工具调用、撤回时的 git 操作）都以非 root 用户执行：
# 部分用例依赖"写不了无权限的路径"，以 root 跑会判错。工作区、测量副本目录、/opt 与 /opt/lint（切换依赖组合时在其下
# 替换 /opt/venv 与 /opt/lint/current 链接）归它所有
RUN useradd --create-home --uid 10001 stream \
 && mkdir -p /testbed /measure \
 && chown stream:stream /testbed /measure /opt /opt/lint \
 && chown -h stream:stream /opt/venv /opt/lint/current
USER stream
WORKDIR /testbed
