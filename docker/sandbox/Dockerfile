# Pigeon 日常沙箱的通用镜像：Ubuntu 24.04，含 git、Python 3、Node 与常用命令行工具，以非 root 用户 pigeon 运行。
# 首次开沙箱时由 Pigeon 构建，标签带本文件内容（与底镜像名）的哈希，之后直接用缓存。
# 国内网络可经构建参数替换底镜像与软件源：
#   BASE_IMAGE    底镜像名（缺省 ubuntu:24.04，可换成镜像站上的同版本镜像）
#   APT_MIRROR    apt 软件源根地址（如 https://mirrors.aliyun.com/ubuntu）
#   PIP_INDEX_URL pip 索引地址（同时写进镜像，容器里的 pip 照此安装）
#   NPM_REGISTRY  npm 源（同时写进镜像，容器里的 npm 照此安装）
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ARG APT_MIRROR=
ARG PIP_INDEX_URL=
ARG NPM_REGISTRY=
ENV DEBIAN_FRONTEND=noninteractive
# 容器是一次性的：允许 pip 直接装进系统环境（Ubuntu 24.04 缺省拒绝，agent 常因此卡住）
ENV PIP_BREAK_SYSTEM_PACKAGES=1

RUN set -eux; \
    if [ -n "$APT_MIRROR" ]; then \
      for f in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do \
        [ -f "$f" ] && sed -i -E "s#https?://(archive|security|ports)\.ubuntu\.com/ubuntu(-ports)?/?#${APT_MIRROR%/}/#g" "$f" || true; \
      done; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      git ca-certificates curl wget openssh-client \
      python3 python3-pip python3-venv python-is-python3 \
      nodejs npm \
      ripgrep fd-find jq tree less file patch procps unzip zip xz-utils \
      build-essential; \
    ln -s /usr/bin/fdfind /usr/local/bin/fd; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    if [ -n "$PIP_INDEX_URL" ]; then printf '[global]\nindex-url = %s\n' "$PIP_INDEX_URL" > /etc/pip.conf; fi; \
    if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY" --location=global; fi

# Ubuntu 24.04 自带 uid 1000 的 ubuntu 用户：换成 pigeon
RUN set -eux; \
    if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi; \
    useradd -m -u 1000 -s /bin/bash pigeon; \
    mkdir -p /workspace; \
    chown pigeon:pigeon /workspace

USER pigeon
WORKDIR /workspace
