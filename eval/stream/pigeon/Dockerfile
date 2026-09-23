# 延续式跑批：本仓库流的工作区镜像（决策 148）。
# 构建上下文由 `pigeon eval stream-image-context --repo-profile pigeon` 组装：本文件与历史上最全的一份
# package.json、package-lock.json（锁文件在历史上只增不减，最新一份覆盖全部提交）。
# 依赖装在工作区根的 node_modules（各流起点的 .gitignore 均忽略它），流起点的代码稍后由跑批器经 git bundle 送入。
# 工作区容器运行时恒为无网络（104）。

FROM node:24.12.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json /opt/stream/
RUN cd /opt/stream && npm ci --no-audit --no-fund && mkdir -p /testbed && mv node_modules /testbed/node_modules
# 容器里的一切命令都以非 root 用户执行（与 strands 镜像同一约定）：工作区与测量副本目录归它所有，依赖目录只读即可
RUN useradd --create-home --uid 10001 stream \
 && mkdir -p /measure \
 && chown stream:stream /testbed /measure
USER stream
WORKDIR /testbed
