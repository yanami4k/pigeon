# Pigeon Harness

面向无人值守并行执行与从运行历史学习的 coding agent harness。路线图与设计索引见 [`docs/roadmap/`](docs/roadmap/README.md)。

下文的 `pigeon` 指 `node src/cli/index.ts`；终端界面为 `node src/tui/main.ts`。模型接入照常经 `--stream-fn <模块路径>` 或环境变量 `PIGEON_STREAM_FN` 指定。

## 日常沙箱

加 `--sandbox`，agent 就在一个一次性的 Docker 容器里工作：工具的读写与命令都在容器里执行，最坏只坏掉这个容器。会话文件、放权与记忆（`.pigeon/` 下）仍在本机项目里，不进容器。

```sh
node src/tui/main.ts --sandbox --stream-fn <模块>            # 终端界面
pigeon --sandbox --stream-fn <模块>                         # 命令行对话
pigeon run "修掉 xxx 的 bug" --sandbox --stream-fn <模块>     # 无人值守
```

- **要求**：项目是至少有一个提交的 git 仓库；本机能执行 `docker` 命令。
- **起点**：沙箱从当前分支的最新提交起步。工作目录里未提交的改动不会带进沙箱，开工时会提示一行。
- **交回**：容器里的改动提交到分支 `pigeon/sandbox-<会话号>`，取回到本机仓库的同名分支。不动当前分支、工作目录与未提交的改动，不经网络、不自动推送。会话结束时自动交回一次（`pigeon run` 在返回前交回），会话中可用 `/export` 手动交回。交回后给出查看命令，例如 `git diff main..pigeon/sandbox-<会话号>`。交回后删除容器；交回失败时保留容器，改动还在里面。
- **联网**：缺省联网。`--sandbox-network off` 断网。
- **审批**：缺省全部放行（等同 `--yolo`），把关点在审阅交回的分支。`--sandbox-approval prompt` 改回逐条询问；此时 `[d]`（按目录放权）不建放权，按批准一次处理。
- **续跑**：`pigeon resume <会话号> --sandbox` 从该会话交回的分支新开容器接着干；没有交回过的会报错。
- **验证命令**：`--verify-command` 与 `.pigeon/verify.json` 的验证命令在容器里执行。
- **暂不支持**：`/fork` 与 `--retry-on-fail`（分叉）、`/spawn` 等 worker 命令、终端界面里的 `/resume` 换绑。在沙箱里使用会报错并说明原因。
- **残留容器**：进程异常退出会留下带 `pigeon.sandbox` 标签的容器。下次开沙箱时会列出来；`pigeon sandbox list` 查看，`pigeon sandbox clean` 删除（只删残留，在用的不动）。

### 镜像

缺省用 Pigeon 自带的通用镜像（[`docker/sandbox/Dockerfile`](docker/sandbox/Dockerfile)：Ubuntu 24.04，含 git、Python 3、Node、ripgrep 等，以非 root 用户运行）。首次使用时构建，之后直接用缓存。

国内网络构建时可替换底镜像与软件源（环境变量，或 `.pigeon/sandbox.json` 的 `build` 段，后者优先）：

| 环境变量 | `build` 字段 | 含义 |
|---|---|---|
| `PIGEON_SANDBOX_BASE_IMAGE` | `baseImage` | 底镜像名（缺省 `ubuntu:24.04`） |
| `PIGEON_SANDBOX_APT_MIRROR` | `aptMirror` | apt 软件源根地址，如 `https://mirrors.aliyun.com/ubuntu` |
| `PIGEON_SANDBOX_PIP_INDEX` | `pipIndex` | pip 索引地址（同时写进镜像） |
| `PIGEON_SANDBOX_NPM_REGISTRY` | `npmRegistry` | npm 源（同时写进镜像） |

项目也可以在 `.pigeon/sandbox.json` 里改用别的镜像（须带 git）：

```json
{ "image": "python:3.12" }
```

或指向项目自己的 Dockerfile（构建上下文缺省为其所在目录）：

```json
{ "dockerfile": "ci/Dockerfile", "context": "." }
```

### 在服务器上用 tmux 挂着

在服务器上跑沙箱会话，断开 SSH 后会话照常进行，之后再接回：

```sh
ssh <用户>@<服务器>
cd <项目>
tmux new -s pigeon                         # 开一个 tmux 会话
node src/tui/main.ts --sandbox --stream-fn <模块>
# 按 Ctrl-b 再按 d 脱离；可以直接断开 SSH
```

再次登录后接回：

```sh
ssh <用户>@<服务器>
tmux attach -t pigeon                      # 接回原会话
tmux ls                                    # 忘了名字时列出全部会话
```

无人值守的任务同理，可在 tmux 里跑 `pigeon run ... --sandbox`，结束后输出里写明交回的分支。

交回的分支在服务器上的仓库里。取到本机有两种办法：

```sh
# 办法 A：本机直接经 SSH 从服务器仓库取这一条分支
git fetch <用户>@<服务器>:<项目路径> pigeon/sandbox-<会话号>:pigeon/sandbox-<会话号>

# 办法 B：服务器上打 bundle，拷回本机再取
git bundle create /tmp/sandbox.bundle pigeon/sandbox-<会话号>          # 在服务器上
scp <用户>@<服务器>:/tmp/sandbox.bundle .                              # 在本机
git fetch sandbox.bundle pigeon/sandbox-<会话号>:pigeon/sandbox-<会话号>
```

也可以在服务器上自行推送到代码托管平台，再在本机拉取；Pigeon 不会自动推送。
