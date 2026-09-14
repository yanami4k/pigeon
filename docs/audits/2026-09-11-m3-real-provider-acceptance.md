# M3 真实模型链路端到端验收（2026-09-11）

收口缺口：M3 CLI 此前只用 fake streamFn 测试，真实模型链路未端到端验证。本次用真实 provider 跑通三条验收路径 + 冷启动对账。本文件不入库（docs/audits/ 按用户决策保持本地）。

## Provider 与模型

- 凭据侦察（值均已掩码）：`DASHSCOPE_API_KEY=sk-ws-…`、`KIMI_API_KEY=sk-kim…`、`OPENAI_API_KEY=K_CODE…`（非标格式）、`CONTEXT7/FIGMA/TAVILY_API_KEY`（非 LLM）；无 `MOONSHOT_API_KEY`/`ANTHROPIC_API_KEY`。~/.omp/agent/config.yml 显示用户日常用 kimi-code/k3（即 Kimi For Coding 订阅）。
- 用户中途指令：改用其提供的 Kimi key（仅经环境变量 `KIMI_API_KEY` 传入，不落任何文件/日志/本文档）。
- 端点探测：`https://api.moonshot.cn/v1/models` 与 `https://api.moonshot.ai/v1/models` 对该 key 均 401 `Invalid Authentication` → 按既定顺序落到 Kimi For Coding 订阅端点 `https://api.kimi.com/coding`（anthropic-messages 线路），探针 `POST /v1/messages`（model=kimi-for-coding, max_tokens=8）返回 200。
- **实际使用**：pi-ai `streamSimple`（`@earendil-works/pi-ai/api/anthropic-messages`），模型 `kimi-for-coding`（Kimi K2.7 Code，元数据取自 pi-ai 目录 `providers/kimi-coding.models`，含 `compat.allowEmptySignature/forceAdaptiveThinking`）。StreamFn 插件：`tmp/real-stream-fn.mjs`（gitignored），忽略 CLI 传入的快照占位 model，注入目录真实 Model + `options.apiKey`。
- **顺带落地一个延期决策**：M1 登记的「@anthropic-ai/sdk override 0.124.0 首次真实使用前需验证」本次首次实战——三轮完整运行（含流式 thinking、工具调用、多轮 agent loop）无任何 SDK 层错误，override 在运行期工作正常。
- pi-ai 关键签名（dist/api/anthropic-messages.d.ts / types.d.ts）：
  - `export declare const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions>`
  - `StreamFunction<TApi, TOptions> = (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream`
  - `ProviderRequestOptions.apiKey?: string`；`Model` 必填字段 `id/name/api/provider/baseUrl/reasoning/input/cost/contextWindow/maxTokens`。

## 路径一：prompt 模式，人工批准（--root tmp/ws-approve）

stdin 脚本：任务行 → `y` → `:quit`。一次成功。

终端输出摘录：

```
—— 人工审批 ——
工具：edit_file
参数：
{
  "edits": [ { "anchor": "1#91c9", "lines": [ "hello world" ], "op": "replace" } ],
  "path": "hello.txt",
  "snapshot": "8f2a7c66d0fe325e"
}
改动预览：
--- a/hello.txt
+++ b/hello.txt
@@ 1#91c9 @@
-hello worlld
+hello world
 this file has a typo
批准执行？[y/N]
终态：completed（stopReason=stop）
工具执行：2 次
  read_file：approved（policy:auto）→ settled
  edit_file：approved（human）→ settled
```

- 落盘验证：`hello.txt` 变为 `hello world`（编辑真实生效）。
- 账本 `.pigeon/ledger.jsonl`（4 行，无秘密）：read_file intent(approvedBy=policy:auto)+receipt(executed=true)；edit_file intent(approvedBy=human)+receipt(executed=true)。edit_file intent 行：
  `{"kind":"intent","executionId":"exec_01M283XVV…","toolName":"edit_file","rawArgs":{"edits":[{"anchor":"1#91c9","lines":["hello world"],"op":"replace"}],"path":"hello.txt","snapshot":"8f2a7c66d0fe325e"},"decision":{"outcome":"approved","approvedBy":"human",…}}`

## 路径二：prompt 模式，人工拒绝（--root tmp/ws-reject）

stdin 脚本：任务行 → `n` → 理由 `验收测试：这个错别字是故意的，不许改` → `:quit`。一次成功。

- 终端摘要：`edit_file：rejected（human）→ settled`，终态 completed。
- **文件字节不变**：`hello worlld` 原样保留（md5 与初始 fixture 一致）。
- 账本：read_file intent+receipt；edit_file **decision 行携带逐字理由**：
  `{"kind":"decision","toolName":"edit_file","decision":{"outcome":"rejected","approvedBy":"human","reason":"验收测试：这个错别字是故意的，不许改",…},…}`
  + receipt：`"executed":false,"isError":true,"summary":"edit_file 未产生副作用（已拒绝）"`。
- 拒绝理由逐字反馈给模型后模型未重试编辑，正常收尾（stopReason=stop）。

## 路径三：--yolo（--root tmp/ws-yolo）

stdin 脚本：任务行 → `:quit`（无审批交互行）。一次成功。

- **全程未出现「人工审批」提示**；终态 completed。
- 落盘验证：`hello.txt` 变为 `hello world`。
- 账本：两个 intent+receipt 对，`approvedBy=policy:yolo`，`executed=true`。

## 冷启动对账（tmp/reconcile-check.mjs，新进程全新 JsonlLedger 冷读）

```
== ws-approve ==  settled: 2 (read_file policy:auto, edit_file human, 均 executed=true)  rejected: 0  unknown: 0  orphan: 0
== ws-reject ==   settled: 1 (read_file)  rejected: 1 (edit_file reason 逐字, executed=false)  unknown: 0  orphan: 0
== ws-yolo ==     settled: 2 (均 policy:yolo)  rejected: 0  unknown: 0  orphan: 0
```

三个账本均无 OutcomeUnknown、无孤儿 receipt——拒绝路径正确归 `rejected`（决策 4：decision 即闭环，永不入 OutcomeUnknown）。

## 费用与 token 说明

Kimi For Coding 为订阅额度（不按 token 单价计费）；CLI 不打印 usage，未单独抓取。三轮运行各 2 次 API 调用（read 轮 + edit/收尾轮），总耗时各约 10 秒，探针 1 次 max_tokens=8。整体消耗对订阅额度可忽略。

## 偏差与诚实记录

- provider 偏差：最初侦察选定 DashScope（OpenAI 兼容），用户中途改令用其 Kimi key；OpenAI 兼容端点 401 后按预案走 kimi-coding anthropic-messages 线路，与用户指令一致。
- 模型行为：三轮均一次成功，模型严格按 `read_file → edit_file` 顺序调用、锚点/快照标签逐字正确，无幻觉工具名、无重试；未需要调整任务措辞。
- 施工返工（均未消耗 API token）：①插件初版从 `providers/kimi-coding` 导入 `KIMI_CODING_MODELS`（正确路径是 `providers/kimi-coding.models`），CLI 加载即报错退出，未发起 API 调用；②对账脚本把 `ReconcileReport.unknown` 误写成 `outcomeUnknown`，修正后重跑。
- `tmp/`（插件、三个工作区、对账脚本）全部 gitignored，未 commit 任何东西；`git status --short` 为空。
