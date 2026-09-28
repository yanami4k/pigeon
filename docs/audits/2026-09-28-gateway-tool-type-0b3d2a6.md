# 网关兼容：工具定义里的 type 字段（基线 0b3d2a6）

范围：本地模型网关（`src/eval/model-gateway.ts`）转发前去掉工具定义里的 `"type": "custom"`；核对 litellm 1.102.1 的 anthropic 请求转换会加的字段与 DeepSeek Anthropic 兼容接口的支持情况。分支 gateway-tool-type，自 formal-v2 的 0b3d2a6 快进后施工。

## 一、现象与原因

- 现象：最简 agent（mini-swe-agent 2.4.6，经 litellm 1.102.1 的 anthropic 线路）的请求经网关转发到 DeepSeek 的 Anthropic 兼容接口，第一个请求即返回 400：``invalid_request_error: Failed to deserialize the JSON body into the target type: tools[0]: unknown variant `custom`, expected `web_search_20250305` or `web_search_20260209` ``。
- 原因：litellm 把每个 function 工具转成 Anthropic 工具时固定写入 `type="custom"`（`litellm/llms/anthropic/chat/transformation.py` 第 735–739 行）。Anthropic 官方接口接受该值（不写 type 即自定义工具）；DeepSeek 兼容接口把 `type` 当作内置工具类型的枚举，只认它支持的几种，见到 `custom` 即反序列化失败。DeepSeek 文档的 tools 字段表只列 name、input_schema、description（均 Fully Supported）与 cache_control（Ignored），未列 type。

## 二、改法

- 新增 `stripCustomToolType(body)`：读完请求体后调用。请求体解析为 JSON 对象、`tools` 为数组、且其中有 `type` 严格等于 `"custom"` 的项时，只删去这些项的 `type` 字段，整体用 `JSON.stringify` 重新序列化后转发。
- 以下情况返回同一份原始字节、不重新序列化：没有 `type` 为 `"custom"` 的工具项；请求体不是合法 JSON；顶层不是对象（含数组）；`tools` 不是数组。
- 其他 `type` 取值（如 `web_search_20250305`）、工具以外位置的 `type`（消息块、`input_schema` 内、`cache_control` 内）都不碰。
- 为何不影响其他请求：Pigeon 自己经网关的请求不带该字段，走"原字节"分支，一个字节不变，DeepSeek 的前缀缓存命中不受影响。改写后正文长度会变，而网关本来就不向上游转发客户端的 `content-length`（`DROP_REQUEST_HEADERS`），由 fetch 按新正文重算。计量与花费读的是上游响应，与请求体无关，照常。
- 改写只发生在带 `custom` 的请求上：litellm 每次请求都会带齐同一组工具定义且同样改写，同一 agent 前后请求的前缀仍一致。

## 三、litellm 1.102.1 请求字段核对

来源：`pip download litellm==1.102.1 --no-deps` 取得 wheel（`litellm-1.102.1-cp310-abi3-win_amd64.whl`），解压只读源码，未安装。DeepSeek 文档：https://api-docs.deepseek.com/guides/anthropic_api ，2026-09-28 读取，页面无版本号。以下行号相对 wheel 内 `litellm/`；"最简调用"指 messages + tools，无其他参数。Python 路径分析（Rust 分支默认关闭，需 `LITELLM_RUST=1`）。

### 3.1 最简调用默认会带的

| 字段 | 来源 | DeepSeek 文档 | 结论 |
|---|---|---|---|
| 头 `x-api-key` | `llms/anthropic/common_utils.py` 819–825 | Fully Supported | 兼容 |
| 头 `anthropic-version: 2023-06-01` | 同文件 885 | Ignored | 被忽略 |
| 头 `accept`、`content-type`、`User-Agent: litellm/1.102.1` | 同文件 886–887；`llms/custom_httpx/http_handler.py` 139–146 | 未提及 | 标准 HTTP 头 |
| `model` | `llms/anthropic/chat/transformation.py` 2034 | 须用 DeepSeek 模型名 | 兼容（由配置填 DeepSeek 名） |
| `messages`（text、tool_use、tool_result 块） | 同文件 1958–1967；`litellm_core_utils/prompt_templates/factory.py` | Fully Supported | 兼容 |
| `system`（块数组形式，有 system 消息时） | transformation.py 1953–1955 | Fully Supported | 兼容 |
| `max_tokens`（调用方未传时自动补） | transformation.py 325–348、1988–1994 | Fully Supported | 兼容；取值见 3.3 |
| `tools[].name`、`description`、`input_schema` | transformation.py 712–906 | Fully Supported | 兼容 |
| `tools[].type = "custom"` | transformation.py 735–739 | 未列 | 400，本次已由网关去掉 |
| `stream`（stream=True 时） | transformation.py 1497–1498 | Fully Supported | 兼容 |

- `anthropic-beta`：最简调用不带。仅在 computer use、files、mcp、code execution、structured outputs、context management 等特性出现时加（common_utils.py 853–899，transformation.py 1826–1846）。DeepSeek 文档：对 /messages Ignored。prompt caching 已不加 beta 头，`cache_control` 只在原消息或工具自带时透传；DeepSeek 文档：Ignored。
- `metadata`：仅传了 `user=` 或 metadata.user_id 时加，且只保留 `user_id`（transformation.py 1535–1540、1996–2013）。DeepSeek 文档：user_id 支持、其余忽略。兼容。
- `thinking` / `output_config`：仅传了 thinking 或 reasoning_effort 时加。DeepSeek 文档：thinking 支持（budget_tokens 忽略），output_config 只支持 effort。
- `temperature`、`top_p`、`stop_sequences`、`tool_choice`：仅调用方传了才加。DeepSeek 文档：temperature、stop_sequences、tool_choice 支持（`disable_parallel_tool_use` 被忽略）；top_p 非思考模式固定为 1.0。

### 3.2 DeepSeek 文档标为不支持或未提及、且 litellm 可能发出的

仅在调用方用到对应特性时出现，最简调用不发：

- `output_format` / `output_config.format` 与 structured-outputs beta（传 response_format 且模型表标了原生结构化输出时；transformation.py 1512–1533）：文档只支持 `output_config.effort`，未提 format。
- `document` 块、`redacted_thinking`、code_execution / mcp_tool_* / container_upload 块：文档 Not Supported，未说明报错还是忽略。
- 顶层 `cache_control`、`context_management`、`speed`，工具的 `defer_loading` / `allowed_callers` / `input_examples`，`authorization: Bearer`（仅 AUTH_TOKEN、oauth 前缀或 use_bearer_for_custom_base）：文档未提及。
- 非 OpenAI 参数的额外关键字参数会原样进请求体顶层（`utils.py` 4885）；presence_penalty、seed 等在本地直接报 `UnsupportedParamsError`。

### 3.3 需要留意的默认行为

- `max_tokens` 缺省值按模型名查 litellm 模型表的 max_output_tokens，查不到用 4096（`constants.py` 488，可用环境变量覆盖）。内置备份表中 deepseek-v4-pro / deepseek-v4-flash 为 393216，deepseek-chat 为 8192，deepseek-reasoner 为 65536；litellm 默认联网拉取模型表，实际值可能不同。
- 回传 assistant 的 thinking 块时，没有 signature 的块被丢弃（factory.py 2302–2322、2670）。

## 四、测试与变异

新增三例（`src/eval/model-gateway.test.ts`，假上游记下收到的正文）：

1. tools 含两项 `type:"custom"`、一项 `web_search_20250305`、一项不带 type，消息与 `input_schema` 内也有 `type`：上游收到的正文等于去掉那两项 type 后的 `JSON.stringify` 结果；响应透传，作业计量（请求数、输入、输出、缓存读写、上游故障）与花费等于一次 SSE 请求的值。
2. 不带 custom 的请求，正文含多余空白、非字母序键、`1.0`、`é`、`\/` 转义、消息字符串里含 `{"type":"custom"}` 字样：上游收到的正文逐字等于原文；计量与花费照常。
3. 非法 JSON、顶层为数组、`tools` 为对象三种正文（均含 `"type":"custom"` 字样）：逐字原样转发；每个作业计量与花费照常。

本机先跑 `src/eval/model-gateway.test.ts`：46 条全过。变异反向验证（同一文件）：

| 变异 | 结果 |
|---|---|
| A：去掉改写调用（`const body = await readAll(req)`） | 仅第 1 例失败，45/46 |
| B：改写误伤——无论有无 custom 都重新序列化 | 仅第 2 例失败，45/46 |
| 还原 | 与备份逐字节一致（cmp），46/46 |

## 五、verify 的实际运行情况

在验证服务器 pigeon-verify（8 vCPU、31 GB 内存，Node v24.12.0）上，提交 680d50f，`npm ci` 后逐步运行；开跑前无其他 `node --test` 进程，测试并发取 6：

- tsc（`npm run check`）：通过。
- 测试（`node --test --test-concurrency=6 "src/**/*.test.ts"`）：1141 条，1139 通过、0 失败、2 跳过，测试步约 109 秒。
- depcruise（`npm run deps`）：通过，416 个模块无违规。
- lint（`npm run lint`）：1 个错误，为 `eval/analysis/tests/fixtures/runner-sample.json` 的格式（biome 要求把多行数组收成一行）。该文件出自 ab90f4d，本分支未改动；在 formal-v2 的 0b3d2a6 上对该文件单独运行 biome 同样报这 1 个错误。其余 400 个文件（含本次改动的两个文件）通过。本次未改该文件。

真实模型接口的端到端验证不在本段做，结果另行追加。

## 六、追加：fixture 格式化与 max_tokens 取值

### 6.1 fixture 格式化

- 单独一个提交（ad30691）：对 `eval/analysis/tests/fixtures/runner-sample.json` 只运行 biome 格式化，把多行数组收成一行，内容不改。该文件只被 `eval/analysis/tests/test_calibration.py` 用 `json.load` 读取。用 Python 的 `json.load` 读改前与改后的文件，两者解析结果完全相等。
- 本机 `biome check .`：401 个文件，0 错误。

### 6.2 max_tokens：已显式设为 16384，缺省补值不生效

第 3.3 节所述"litellm 按模型表补 max_tokens 缺省值"的路径，最简 agent 走不到。原因如下：

- `eval/stream/mini/run_mini.py` 的 `model_kwargs` 显式传入 `max_tokens`，取 `MAX_OUTPUT_TOKENS = 16384`；同时显式传入温度 0 与 `thinking: {"type": "disabled"}`。
- `eval/stream/mini/test_run_mini.py` 断言 `max_tokens` 为 16384、温度为 0、thinking 为 disabled。

### 6.3 verify（pigeon-verify，ad30691）

同一台服务器，同一目录，检出 ad30691，`git status --porcelain` 为空。开跑前没有其他 `node --test` 进程，测试并发取 6。

- lint：401 个文件，0 错误。tsc 与 depcruise 均通过（depcruise 无违规）。
- 测试第一次：1141 条，1138 通过、1 失败、2 跳过。
  - 失败的是 `src/application/fork-session.test.ts` 中"/fork 命令：解析 --at 与新输入…"一例，报错为 `Run 号前缀 … 不唯一（2 个）`。
  - 原因与 i1 集成冒烟审计第三节记录的相同：两次 Run 在同一毫秒内开始，单调 ULID 只在末位加一，该用例截去末 2 位作前缀，于是两次 Run 落在同一前缀下。
  - 该文件单独重跑 20 次，通过 16 次，说明单独运行也会偶发失败，与本段改动无关，本段未修改。
- 测试第二次（同一提交，全量，并发 6）：1141 条，1139 通过、0 失败、2 跳过，约 108 秒。
