# 联网开关、DeepSeek 端点根、输出上限跟模型、只通网关的网络档与外部 agent 条件 审计

- 基线：97c7a63
- 分支：external-agent-condition
- 范围：决策 346（联网工具的开关）、DeepSeek 端点根的环境变量、决策 347（单轮输出上限跟模型走，改决策 063 的缺省值），以及跑批器的两项实验设施（只通网关的网络档、外部 agent 条件）。共五组提交，每组一件。

## 一、联网工具的开关（决策 346）

现状：`web_search` 与 `web_fetch` 在终端界面、命令行对话与续跑、`pigeon run` 中缺省注册；唯一的关法是沙箱断网档（`launch-flags.ts` 的 `webToolsEnabled` 只看 `sandbox.network`）。

改法：
- 设置的 web 一节加 `enabled`（布尔，缺省 true；`state/web-config.ts` 的 `WebSectionSchema`）。web 一节按对象逐层合并，`enabled` 作为标量由高优先层覆盖，与其他标量项同一规则。
- 启动参数 `--no-web`：无取值（进 `VALUELESS_FLAGS`），`parseLaunchFlags` 对各入口一律接受，只对本次运行生效。用法行（终端界面、`pigeon run`、`pigeon resume`、命令行对话的参数提示）补上。
- 判定收在 `webToolsEnabled(flags, web)` 一处：`--no-web`、`web.enabled === false`、沙箱断网档任一成立即不给。入口改用 `webToolsOptionOf(flags, snapshot)`：给则按快照的 web 一节建出配置，不给则不带 `webTools`——两件工具都不注册，系统提示不带 `WEB_TOOLS_SENTENCE`。worker 照父运行面拿同一份（装配本来如此）。终端界面的 `webToolsFor` 改为经 `webToolsOptionOf`，`/reload` 换上新快照后按新设置重算。
- `docs/configuration.md`：各节表里 web 一行补总开关；新增"联网工具的开关"一节（三种关法、worker 与 `/reload` 的行为、示例）。

测试（`src/application/launch-flags-web.test.ts`，5 项）：三种关法各自让两件工具与那句提示都不出现、缺省照旧注册（经 `buildRuntime` 看广告的工具与系统提示）；`--no-web` 无取值且各入口接受；`web.enabled` 的取值与另两种关法的叠加；三层标量覆盖（高优先层说了算，没写的层不改上一层的值）。

变异：去掉 `web.enabled` 判定，2 项变红；去掉 `noWeb` 判定，3 项变红；还原后逐字一致。

## 二、DeepSeek 端点根的环境变量

现状：自带的 DeepSeek 接入与 `web_search` 的 DeepSeek 后端都写死官方地址（`DEEPSEEK_ANTHROPIC_BASE_URL`）；后端在设置里给了 `baseUrl` 时以设置为准。

改法：
- `pi-runtime/deepseek-stream.ts` 加 `DEEPSEEK_BASE_URL_ENV` 与 `resolveDeepSeekBaseUrl(env)`：给了就用它作 Anthropic 兼容端点的根（请求照旧拼 `/v1/messages`）；没给或为空用官方地址；不是 http 或 https 地址（按 `URL` 解析出的协议判）即抛错，报错写明变量名、要求与原值，不含 key。`createDeepSeekStreamFn` 在构造时取值，入口模块加载即报错。
- `web_search` 的 DeepSeek 后端：设置里显式给了 `web.search.deepseek.baseUrl` 以设置为准（此时不读环境变量）；没给时跟 `resolveDeepSeekBaseUrl`；智谱与 Tavily 不受影响。`ResolveWebToolsOptions` 另加测试注入 `searchFetch`。
- 跑批网关的上游（`GATEWAY_UPSTREAM_BASE_URL`）不读这个变量，仍为官方地址。
- `docs/configuration.md` 的"key 走环境变量"一节补一段。

测试：`deepseek-stream.test.ts` 一项（给与不给、空值、三种非法值；报错带变量名与原值、不带 key）；另一项用假的 fetch 捕获实际请求的地址（给定根拼 `/v1/messages`）；`web-tools.test.ts` 一项（优先次序：设置 > 环境变量 > 官方地址；设置给了地址时非法的环境变量不影响；没给时非法值装配即报错），以假的 fetch 捕获实际请求的 URL。

变异：去掉协议校验，2 项变红；搜索后端不跟环境变量，1 项变红；环境变量压过设置，1 项变红；还原后逐字一致。

## 三、单轮输出上限跟模型的上限走（决策 347）

现状：`output-limit.ts` 的 `DEFAULT_MAX_OUTPUT_TOKENS` 为 16,384，`runtime.ts` 未配置时也用它包装 streamFn 并写进注入快照与运行开始条目；DeepSeek 模型定义的 `maxTokens` 为 16,384；跑批器身份记录以 `DEFAULT_MAX_OUTPUT_TOKENS` 为缺省。pi-ai 在调用方没给 `maxTokens` 时用模型的 `maxTokens`，并按剩余上下文收窄（`clampMaxTokensToContext`：窗口减估算的上下文 token 减 4,096）；开思考时 `adjustMaxTokensForThinking` 取"给定值加思考预算"与模型上限的较小者。

改法：
- `runtime.ts`：未配置不包装 streamFn、不写快照的 `maxOutputTokens`（运行开始条目据快照，同样不写）；配置了照旧经 `limitOutputTokens` 传入。占位模型的 `maxTokens` 未配置时为 0（压缩摘要的输出上限此时按上游规则只取 0.8 倍预留量）。
- 删去 `DEFAULT_MAX_OUTPUT_TOKENS`；`output-limit.ts` 加 `FALLBACK_MODEL_MAX_TOKENS = 32,000` 与 `modelOutputLimit(model, requested)`：模型上限缺失或不为正时按 32,000 计并写回交给 provider 的模型对象；调用方给了上限取它与模型上限的较小者，没给不传。自带的 DeepSeek 接入与网关接入共用它（这两处看得到真实模型对象；adapter 交给 streamFn 的是 `maxTokens` 为 0 的占位）。
- DeepSeek 模型定义的 `maxTokens` 改为 393,216（`DEEPSEEK_MAX_TOKENS`）。
- 跑批器：`stream-agents.ts` 加 `STREAM_MAX_OUTPUT_TOKENS = 16,384`；进程内条件没配置时显式传这个值（`effectivePigeonSettings` 的身份记录同值，照旧）；`gatewayStreamFn` 加可选的第三个参数 `modelMaxTokens`，跑批器以 16,384 传入，使网关接入的模型上限保持改动前的 16,384——开思考时请求的 `max_tokens` 与改动前一致（不传时开思考会变为 16,384 加思考预算）。最简 agent 的设置测试改为与 `STREAM_MAX_OUTPUT_TOKENS` 比对。
- worker 继承父运行面冻结快照里的值（原有逻辑），父未配置则 worker 也不配置。
- 与现状不符的注释一并改正：`launch-flags.ts`、`runtime.ts`、`headless-core.ts`、`workers.ts`（两处）的"缺省 16,384"；`runtime.ts`、`headless-core.ts`、`workers.ts` 的"编辑模式缺省 hashline"（现为 replace）；`deepseek-model.ts`、`deepseek-stream.ts`、`snapshot.ts`、`runtime-events.ts` 的相关说明。
- `docs/configuration.md` 新增"单轮输出上限"一节，写明第三方接入模块交给 provider 的模型对象须带 `maxTokens`。

测试：
- 实际请求（`deepseek-stream.test.ts`，用真的 `streamSimple`，经调用选项注入假的 fetch 捕获请求体）：未配置时 `max_tokens` 为 393,216，开思考时同样；约 70 万 token 的上下文下收窄为 1,000,000 − 700,000 − 4,096，开思考时同样；配置 4,096 取 4,096、配置 500,000 取 393,216；网关接入未配置按 393,216，跑批器给的 16,384 在开与不开思考时都发 16,384；模型对象没有上限时发 32,000。
- `output-limit.test.ts`：`modelOutputLimit` 的 32,000 兜底（0、负数、NaN、缺失）、较小者与未配置不给。
- `runtime-output-limit.test.ts`：未配置时模型调用不带 `maxTokens`，快照与运行开始条目都没有这个字段；配置值照旧写入。`workers-output-limit.test.ts`：父配置 2,048 时 worker 同值，父未配置时 worker 也不带。
- `stream-agents.test.ts`：Pigeon agent 没配置时模型调用收到 16,384，配置 4,096 时为 4,096；`stream-experiment.test.ts` 的身份记录仍为 16,384；`model-gateway.test.ts` 经网关的请求体按跑批器的接法为 16,384。

变异：快照未配置也写 16,384，3 项变红；去掉 32,000 兜底，2 项变红；去掉"取较小者"，2 项变红；跑批器不显式传 16,384，1 项变红；还原后逐字一致。

## 四、跑批器的"只通网关"网络档（实验设施）

现状：作业容器恒为 `--network none`（`WORKSPACE_NETWORK_ARGS`）；模型网关只听回环地址，作业地址为 `/j/<作业>`，路径前缀之后任意子路径、任意方法都转发，不校验占位 key。

改法：
- 作业地址：`jobBaseUrl(job)` 首次调用即登记该作业并给一个 32 位十六进制随机串（`randomBytes(16)`），地址为 `/j/<作业>/<随机串>`；同一作业取到同一串。进程内条件与最简 agent 同用此规则。
- 路由（`parseJobRoute`）：只认 `POST /j/<作业>/<随机串>/v1/messages`（可带查询串）；作业须登记过、随机串以 `timingSafeEqual` 比对一致。其余（未登记、随机串不对、缺随机串、别的路径、`/v1/messages` 的子路径、非 POST）一律回 404，不读请求体、不发往上游。请求体转发、计量、重试、停批与按作业归账照旧；只替换 key 头。原有的 `stripCustomToolType` 保留：工具的 `type` 为 `custom` 时去掉该字段并重新序列化（未知字段保留），其余情形请求体逐字转发。
- 另听一个地址：`listenInternal(host)` 在给定地址上再起一个同一路由与计量的监听；`jobBaseUrl(job, "internal")` 取该监听上的地址，同一作业同一随机串。只能听一次；没听之前要这个地址即报错。`close()` 关两处监听。
- 网络（`src/eval/gateway-network.ts`）：`createGatewayNetwork(prefix)` 先删同名残留，再 `docker network create --internal --label pigeon.stream=<前缀> <前缀>-gateway-net`，取 IPAM 的网关地址作宿主一侧的地址；`removeGatewayNetwork` 先强制移除仍接在网络上的容器再删网络，网络不存在视为已删。只在有外部 agent 条件时建（第五件），跑批结束在 `finally` 里删。进程内条件与最简 agent 的容器照旧 `--network none`，`assertKeepsWorkspaceOffline` 不变。

单元测试（`model-gateway.test.ts`，3 项，用假上游）：未登记的作业、错的随机串、缺随机串的旧地址、非 messages 路径、messages 的子路径、GET、路径外都回 404，且上游一次都没收到；登记过的地址带查询串照常转发并计量。带未知字段（`output_config` 等，含非规整的空白）的请求体逐字到达上游，key 头换成真 key。内部监听：同一套路由与计量，同一作业同一随机串，未登记的地址 404。原有 46 项照常通过。

变异：去掉登记校验，2 项变红；去掉方法校验，1 项变红；路由放宽到任意子路径，1 项变红；还原后逐字一致。

真容器（`gateway-network.test.ts`，2 项，镜像 pigeon-stream-pigeon:v4，假上游）：
- 接内部网络的容器经内部监听的作业地址发 POST，回 200，假上游收到 1 次。
- 公网：连一个公网 IP 的 443 端口得 `ENETUNREACH`；解析一个公网域名得 `EAI_AGAIN`。
- 宿主一侧地址上的端口：从容器里对 1 至 65535 全部端口逐一尝试连接（每个 300 毫秒），能连上的只有 22 与网关内部监听的端口；其余 65,533 个都连不上。同一时刻宿主上在监听的是全部地址上的 22（sshd）与只在回环地址上的 53（系统的 DNS 存根）。即：外部 agent 条件的容器能连到宿主的 sshd。
- 删网络后网络不在；同名网络重建时，接在旧网络上的残留容器一并移除。

## 五、跑批器的"外部 agent 条件"（实验设施）

现状：条件名为闭合联合（`StreamCondition`、`CONDITION_SPECS`），CLI 的 `needsPigeon` 写死"不是 minimal 即要 Pigeon"；宿主上的启动器先例为 `commandStepAgent` 与最简 agent 的启动器。

改法：
- 条件名：`StreamCondition` 放开为内置五个加 `ext-<名字>`（名字 `^[a-z0-9][a-z0-9-]{0,31}$`）；`STREAM_CONDITIONS` 仍为内置五个、顺序不变。`ConditionSpec.agent` 可为条件名本身；加可选的 `network: "gateway-only"` 与 `excludePaths`。`runStreams` 收 `conditionSpecs`（外部条件的说明），经 `conditionSpecOf` 取说明。
- 配置（`src/eval/stream-external.ts` 的 `parseExternalAgentConfig` / `loadExternalAgentConfig`）：JSON 对象，字段 `name`、`toolDir`（宿主路径，相对路径按配置文件所在目录解析，须为存在的目录）、`command`（字符串或数组，首项须为容器内绝对路径）、`excludePaths`（工作区相对路径，规整后不得为空、绝对路径、含 `..` 或指向 `.git`）、`env`（变量名须合法；名字像 key 的——与启动器环境去密钥用同一正则 `SECRET_ENV`——一律拒绝；跑批器自己设的变量不得重名）。未知字段即拒绝。
- CLI：`--external-agent <配置文件>` 可重复给；`--conditions` 可混写 `ext-<名字>`；`needsPigeon` 不把外部条件算进去。`externalAgentsFor` 要求每个 `ext-` 条件有同名配置、每份配置对应所跑的条件、名字不重复。用法行与入口注释补写。
- 容器：外部条件的作业容器照现有方式开，网络参数换成 `--network <内部网络>` 与 `--mount type=bind,source=<工具目录>,target=/opt/pigeon-agent,readonly`（`dockerStreamEnvs` 的 `conditionArgs`）；不带 `--user`，用户照镜像的 USER；不改实验镜像，镜像身份与人的基准缓存不变。其余条件的开容器参数不变。
- 每一步（`externalStepAgent`）：以 root 在容器内建 `/tmp/pigeon-agent-io`（含 `artifacts/`，放开写权限），写入请求文件（字段 prompt、directive、root、maxTurns、wallClockMs、modelBaseUrl、model、stepMarker）；`docker exec -w <工作区根>` 运行启动命令，参数为请求文件与结果文件，环境变量带 `PIGEON_STEP_MARKER`、`PIGEON_MODEL_BASE_URL`（内部监听上的作业地址）、`PIGEON_MODEL_API_KEY`（占位 key）、`PIGEON_MODEL`、`PIGEON_AGENT_IO`、`PIGEON_AGENT_ARTIFACTS` 与配置里的附加变量；宿主上 docker 客户端的环境照 `launcherEnv` 去掉密钥类变量。
- 墙钟：起进程、到时杀进程组、限额信号与按步中止杀进程的逻辑从 `commandStepAgent` 抽为 `superviseLauncher`，两者共用（最简 agent 的行为与报错文字不变）。外部条件到墙钟加 30 秒即杀 docker exec 客户端，再以 `clearMarkedProcesses` 清容器里的进程，终态记 `wall-clock-limit`；清不净即报被打断。轮数上限交给启动器；结果行的轮数照旧取网关请求数。
- 产物：不论怎么结束，删容器之前把请求目录（请求、结果与 `artifacts/`）经 `docker cp` 拷到作业目录的 `external/step-<步序>/try-<序号>/`，重做取下一个序号，不覆盖。
- 结果：读拷出的结果文件 `{status, turns?, usage?, interrupted?, report?}`；`report` 为 JSON 对象时原样记进结果行的新字段 `agentReport`（只在外部条件且写了 report 时出现）。
- 提取改动：`StreamWorkspace.worktreeTree(exclude?)` 在给了排除路径时以 `git add -A -- . ":(top,exclude,literal)<路径>"…` 暂存，起止两次同一口径；被排除路径下的嵌套 git 工作树不进树。不给或为空时脚本与参数与之前逐字一致。判题流程不变。
- 身份：批次开始时为每个外部条件算一次身份段，记在 `core.agents["ext-<名字>"]`：配置（名字、启动命令、排除路径、附加变量、挂载点；工具目录不记宿主路径）、工具目录摘要（按相对路径排序，文件记可执行位与内容的 SHA-256，符号链接记指向，目录记名字）、网络档 `gateway-only`、在实验镜像的一次性断网容器里运行"启动命令 --identity"自报的版本（标准输出最后一个非空行，是 JSON 即按 JSON 记，取不到记 null）。沿用 agents 段的规则：不进身份摘要，续跑时两边都记了才逐项比对；core 不加字段。同一份也作外部条件结果行的 `agentSettings`。
- 报告：`stream-report.ts` 的条件顺序为内置条件在前（原顺序），`ext-` 条件按名字排在后面。
- 分析读入（`eval/analysis/pigeon_analysis/reader.py`）：`condition_cell` 把 `ext-<名字>` 读成以条件名为格的行；判断要不要 Pigeon 的身份段、会话计数（`sessions.py`）都只看四格。`eval/analysis/README.md` 补一句。

测试：
- `stream-external.test.ts`（11 项）：配置解析与规整；名字、未知字段、工具目录、启动命令、排除路径的拒绝；密钥名（含 API_KEY、APIKEY、TOKEN、SECRET、PASSWORD、CREDENTIALS、PRIVATE_KEY、AUTH 各形）与保留名的拒绝；条件说明与容器参数；工具目录摘要随内容、可执行位变化；自报版本的读法；条件与配置的对应；产物目录序号；身份段写入、旧目录续跑加外部条件摘要不变、自报版本或工具目录摘要变了即拒绝并指出项名、只跑内置条件续跑照常；改动提取的脚本口径（不排除时三种写法逐字相同，排除时只差暂存那一句）；开容器参数（用假 docker 记录：内置条件仍为 `--network none` 且无挂载，配了外部条件时其余条件的参数不变，外部条件为内部网络与只读挂载、不带 `--user`）。
- 真容器（`stream-external-docker.test.ts`，3 项，镜像 pigeon-stream-pigeon:v4，真网关加假上游，内部网络；假启动器为仓库内夹具 `src/eval/stream-fixtures/fake-external-agent/launch.mjs`，以镜像自带的 node 运行）：完整一步——经网关发出一次请求（上游收到的请求体带未知字段 `output_config`），结果行条件为 `ext-fake`、终态 completed、轮数 1（网关请求数）、用量取网关计量、`agentReport` 原样记下（HTTP 状态 200、工作目录为工作区根），diff 含 `src/a.txt`、不含 `.agent-state`（其下有文件与带提交的嵌套 git 工作树），判题为 passed，请求、结果与产物拷到 `external/step-<步序>/try-1/`，请求文件字段齐全、模型基址为内部监听上带随机串的作业地址；墙钟 2 秒加余量 2 秒的一步被杀，终态 `wall-clock-limit`、撞宽上限为真，被杀之前写的产物照样拷出；启动命令 `--identity` 自报 `{name, version}`。跑完没有残留容器与网络。
- 分析读入（pytest，3 项）：条件名到格的映射、外部条件行读成自己的格、只有外部条件与最简 agent 的目录不要求 Pigeon 身份段。分析目录全部 282 项通过。
- 不配外部 agent 时：现有跑批器、身份、报告、网关用例全部照常通过；开容器参数、改动提取脚本、身份摘要见上。

变异：去掉提取改动时的排除（真容器），diff 出现 `.agent-state/nested` 的 `Subproject commit` 与 `.agent-state/notes.txt`，1 项变红；不记 report（真容器），1 项变红；作业容器不换参数（真容器，网络与挂载一并缺），1 项变红；只把网络换成 none（真容器），轮数为 0，1 项变红；工具目录摘要不看可执行位，1 项变红；去掉密钥名校验，1 项变红；分析读入去掉 `ext-` 分支，3 项变红。均还原后逐字一致。

### 实验镜像里能否直接运行官方的 Node 24 linux-x64 二进制

- 取 nodejs.org 的 node-v24.12.0-linux-x64.tar.xz，按官方 SHASUMS256.txt 校验通过，解压后以只读挂载放到容器的 `/opt/pigeon-agent`，以 `--network none` 起容器、以镜像的用户运行。
- pigeon-stream-strands:v6（Debian 12，glibc 2.36，用户 stream，uid 10001，镜像自身没有 node）与 pigeon-stream-pigeon:v4（Debian 12，glibc 2.36，用户 stream，uid 10001，镜像自带 node v24.12.0）：都能直接运行该二进制，输出 v24.12.0、x64；`fetch` 可用；能调用 `sh` 与 `git`（2.39.5）；能写 `/tmp`。挂载点写入被拒（只读文件系统）。
- 发行包里的 `npm` 以 `#!/usr/bin/env node` 起头：在 strands:v6 里因 PATH 上没有 node 而失败，在 pigeon:v4 里可运行（11.6.2）。工具目录里的脚本须以 node 的绝对路径调用，或由配置的附加变量把其 bin 目录放进 PATH。

## verify 的实际运行情况

- 机器：服务器 pigeon-verify，8 vCPU、31 GB 内存，Docker 29.8.1，Node v24.12.0；已载入实验镜像只读使用，未构建、未删除；测试建的网络与容器用完即删。
- 提交 814ac64：`npm run lint`、`npm run check`、`node --test --test-concurrency=6 "src/**/*.test.ts"`、`npm run deps` 依次全过。测试 1,619 项：通过 1,617，失败 0，跳过 2（两项只在 Windows 上运行的用例）；真容器用例全部实际运行。deps：572 个模块，无违规。
- 全端口扫描另以 `PIGEON_GATEWAY_NET_SCAN=1` 单独运行一次（缺省只扫常见端口与网关端口）。
- 含本审计的提交上另跑一次 verify，结果追加在下一节。

## 含本审计的提交上的 verify

- 提交 077f261（在 814ac64 之上只加本审计文件），同一台服务器：`npm run lint`、`npm run check`、`node --test --test-concurrency=6 "src/**/*.test.ts"`、`npm run deps` 依次全过。测试 1,619 项：通过 1,617，失败 0，跳过 2（两项只在 Windows 上运行的用例）。deps：572 个模块，无违规。
- 服务器上以本分支测试前缀命名的容器与网络已全部删除（其中一个容器与一张网络留自一次被超时终止的测试运行）；实验镜像与其余镜像未改动。

## 补记：sshd 可达、跑批器进程内条件的输出上限、custom 的去除

- sshd 可达：照现状接受，不加防火墙，不改代码（事实见第四节"宿主一侧地址上的端口"）。
- 跑批器进程内条件的输出上限：照现状保留 16,384——`STREAM_MAX_OUTPUT_TOKENS` 与跑批器给 `gatewayStreamFn` 传 16,384 的做法不变。
- custom 的去除：外部 agent 条件免除。

改法（`model-gateway.ts`、`stream-runner.ts`、`stream-external.ts`）：
- `jobBaseUrl(job, options)` 的第二个参数改为选项 `{ on?, verbatimBody? }`（`on` 即原来的监听选择）。登记作业时记下随机串与是否逐字转发；同一作业前后声明不一致即报错。
- 转发时按登记的声明取：逐字转发的作业，请求体一字不改，只替换 key 头；其余作业照旧经 `stripCustomToolType` 去掉工具定义里的 `"type": "custom"`。判定只看登记时的声明，不看请求内容。
- `ConditionSpec` 加 `verbatimRequestBody`；`externalConditionSpec` 置为真。跑批器登记外部条件的作业地址时带 `{ on: "internal", verbatimBody: true }`；内置条件仍以 `jobBaseUrl(key)` 登记，调用不变。
- 说明：`--external-agent` 的用法注释（`src/cli/index.ts`）与 `eval/analysis/README.md` 讲外部条件的一处，各加同一段：外部条件的请求体逐字转发，网关不做兼容改写；有的客户端库会给工具定义加 `"type": "custom"`（例如 litellm 的 Anthropic 线路），DeepSeek 的 Anthropic 兼容端点见到它会回 400（unknown variant `custom`），这类 agent 须自己去掉该字段。

测试：
- `model-gateway.test.ts`（2 项，假上游）：同一份带 `"type": "custom"` 工具定义、未知字段与非规整空白（换行、制表符、冒号与逗号两侧的空格）的请求体，经外部条件的作业地址发出，上游收到的字节与发出的逐字相同，key 头为真 key；经进程内条件的作业地址发出，custom 被去掉、其余字段（含未知字段）保留。同一作业前后声明不一致即报错，一致时取到同一地址。原有网关用例照常通过。
- 真容器（`stream-external-docker.test.ts` 的完整一步）：假启动器发出带 custom 工具、未知字段与非规整空白的请求体并把发出的字节存进产物；上游收到的字节与之逐字相同。
- `stream-external.test.ts`：外部条件的条件说明带 `verbatimRequestBody: true`。

变异：去掉网关的免除判定（一律经 `stripCustomToolType`），网关用例 1 项、真容器完整一步 1 项变红；跑批器登记外部条件时不声明逐字转发，真容器完整一步 1 项变红；还原后逐字一致。

verify：提交 50b0474，同一台服务器：`npm run lint`、`npm run check`、`node --test --test-concurrency=6 "src/**/*.test.ts"`、`npm run deps` 依次全过。测试 1,621 项：通过 1,619，失败 0，跳过 2（两项只在 Windows 上运行的用例）。deps：572 个模块，无违规。测试建的容器与网络都已删除。

## 补记：输出上限、外部 agent 条件与网络档的修正

改法（提交 613441e）：
- 跑批器进程内条件的网关接入（`stream-experiment.ts` 的 `streamGatewayStreamFn`）：没配置单轮输出上限时以 16,384 作模型上限传给 `gatewayStreamFn`；配置了的不另设模型上限，按 DeepSeek 模型定义的上限与配置值取较小者，配置值原样生效。此前配置了大于 16,384 的值、不开思考时，请求被压到 16,384，而身份与 `agentSettings` 记的是配置值。
- 外部 agent 配置的附加环境变量：在 `SECRET_ENV` 之外另查 `EXTERNAL_SECRET_ENV`（`(^|_)KEYS?(_|$)`、`PASS`、`COOKIE`、`BEARER`、`SESSION`、`CERT`，不分大小写），任一命中即拒绝；`launcherEnv` 用的 `SECRET_ENV` 不变。
- 只通网关的网络：建网加 `-o com.docker.network.bridge.enable_icc=false`，同一网络上的容器之间不互连。
- 逐字转发的作业：网关加可选的 `model`（本批的模型名，跑批装配传入）；逐字转发的作业上只读地解析请求体的 `model`，不是合法 JSON、缺 `model` 或与本批不符即回 400（`invalid_request_error`，说明请求的与本批的模型名），不发往上游，计入该作业计量的 `rejectedRequests`（只在发生时出现）；结果行的 `gateway` 段在本步有被拒的请求时带 `rejectedRequests`。请求体的字节不改。其余作业不核对。
- 外部条件的墙钟：在清进程与拷产物之前取。
- 拷出的文件：容器的请求目录拷到 `try-<序号>/io/`；请求文件由宿主另写一份可信副本到 `try-<序号>/request.json`；结果文件经 `readLauncherResult` 读，`lstat` 不是普通文件（符号链接、目录等）即拒读，按读不到处理（终态 unknown）。
- 工具目录：解析后的路径含逗号、引号或换行即拒绝（原样拼进 `--mount`）；是根目录或家目录即拒绝。
- 假启动器自报 `turns` 为 99，结果行仍记网关请求数 1。
- 文字：`eval/analysis/README.md` 删去与分析读入无关的逐字转发说明（只留在 `--external-agent` 的用法注释）；`docs/configuration.md` 写明"模型定义没有上限时发 32,000"只适用于跑批网关的接入或第三方自构的模型，自带的 DeepSeek 为 393,216；`src/cli/index.ts` 的入口注释改为"内置条件断网，外部 agent 条件接只通模型网关的网络"；`DEEPSEEK_BASE_URL` 非法时报错里的地址去掉用户名与密码（`redactUserinfo`）；网络档用例的公网探测目标换成文档保留地址（TEST-NET-3），断言不变。

测试：
- `deepseek-stream.test.ts`：跑批器进程内条件的网关接入，没配置时开与不开思考都发 16,384，配置 32,000、不开思考时发 32,000（真的 `streamSimple`，假 fetch 捕获请求体）；非法地址的报错脱敏（带协议、无协议、只有用户名三种）。
- `stream-external.test.ts`：`DEEPSEEK_KEY`、`OPENAI_KEY`、`ACCESS_KEY`、`KEY`、`KEY_ID`、`SIGNING_KEYS`、`DB_PASS`、`PASSPHRASE`、`SESSION_COOKIE`、`BEARER`、`HTTP_BEARER_VALUE`、`SESSION_ID`、`CLIENT_CERT` 拒绝，`KEYBOARD_LAYOUT`、`MONKEY_MODE` 等放行；结果文件是指向宿主路径的符号链接即拒读、目录拒读、普通文件照读；工具目录含逗号、双引号、单引号、换行，以及根目录、家目录都拒绝。
- `model-gateway.test.ts`：逐字转发的作业 model 不符、不是 JSON、缺 model 都回 400、上游一次未收到、`rejectedRequests` 为 3；相符的逐字转发；进程内条件不核对、不出现该字段；按步做差带上被拒的次数。
- 真容器（`gateway-network.test.ts`）：网络的 `enable_icc` 为 false；两个容器各在 8080 监听（各自从回环连得上），互相连对方的 8080 都连不上，两者都能经网关的作业地址拿到 200。
- 真容器（`stream-external-docker.test.ts`）：网关带本批模型名，假启动器的请求通过核对、逐字到达上游；可信的请求副本与拷出的请求内容一致；结果、产物在 `io/` 下；轮数为网关请求数 1（启动器自报 99）。

变异（本机）：没配置也传 16,384 → 1 项变红；去掉更严的密钥名规则 → 1 项变红；去掉 model 核对 → 1 项变红；工具目录的逗号引号、根目录、家目录检查各去掉 → 各 1 项变红；去掉脱敏 → 1 项变红；均还原后逐字一致。

变异（服务器）：建网时把互连打开 → 网络选项的断言变红；再去掉该断言、互连打开 → 一个容器连上了另一个容器的 8080，"互相连不通"的断言变红；结果文件去掉普通文件检查 → 链接到宿主文件的内容被读出，1 项变红；不写可信的请求副本 → 真容器完整一步 1 项变红；结果行不取网关请求数 → 轮数为启动器自报的 99，真容器完整一步 1 项变红；均还原后逐字一致，测试建的容器与网络都已删除。

真容器（服务器 pigeon-verify 重新开机后，同一规格，镜像未改动）：网络档 3 项、外部 agent 条件 3 项与配置等单元用例 13 项全部通过；宿主一侧地址上能连的常见端口与网关端口仍为 22 与网关端口；公网 TCP 为 `ENETUNREACH`，公网 DNS 为 `EAI_AGAIN`。

verify：提交 613441e：`npm run lint`、`npm run check`、`node --test --test-concurrency=6 "src/**/*.test.ts"`、`npm run deps` 依次全过。测试 1,627 项：通过 1,625，失败 0，跳过 2（两项只在 Windows 上运行的用例）。deps：572 个模块，无违规。
