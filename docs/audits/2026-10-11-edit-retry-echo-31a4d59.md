# edit_file 一次多处、模型请求失败重试、命令结果不整段回显（决策 419、420、421）施工审计

基线 31a4d59。三件各自成组提交：419 为 c0825af，420 为 048cb79，421 为 e79c492，各节的审计另在其后的提交里追加。

## 一、edit_file 一次多处修改（决策 419，c0825af）

现状核对：

- 缺省编辑模式为 replace（`src/tools/edit-mode.ts` 的 `DEFAULT_EDIT_MODE`），hashline 为可选项。
- hashline 模式改前已接受一组修改（参数 `edits`）：全部锚点在原坐标系里先校验（标签、越界、范围倒置），范围两两重叠即报错，再查整体有无实际变化，全部通过才整文件写回一次；报错写明 `edits[i]`。该模式的行为未改，只改了工具说明。
- replace 模式改前一次只改一处（`old_string`、`new_string` 必填）。

replace 模式（`src/tools/replace-edit.ts`）：

- 参数：新增可选的 `edits`，元素为 `{ old_string, new_string }`（至少一项）；顶层的 `old_string`、`new_string` 改为可选。两种写法二选一：都给报"只能二选一"，单处缺一项或两种都没给报"缺少 old_string 或 new_string"。单处写法即只有一项的一组。
- 定位与校验：每一项都在改动前的原文（按 LF 规整后）里定位，照原规则逐项校验——新旧相同、未找到、不唯一（出现次数与各处起始行）；未找到时另注明"各处都按改动前的原文定位，不能引用别处改出的文字"。各项按位置排序后查交叠，交叠报"edits[i] 与 edits[j] 的 old_string 在原文里交叠"（同一段原文给两次也落在这里）。各项单看都有变化、合起来与原文相同时按"没有产生任何实际变化"拒绝。多处时报错以 `edits[i] ` 开头；单处写法的报错文案与改前相同。
- 写入：全部通过才拼出新内容，经原有的 `planAndWrite` 写一次（预览、执行共用同一段预检）；任一项不通过即抛错，不写文件。
- 回执与审批 diff：首句为"已在 X 应用 N 处替换（+a −b 行）"。按行归段：一项占起点所在行到终点所在行（终点恰在换行之后时连下一行），行区间相交的几项归为一段。只有一段时与改前相同（整个文件去掉公共前后缀算区间，回执给新文件里的行区间与上下各两行）；几段时首句后加"，共 K 段"，每段一行"第 k 段；新文件第 s–e 行：…"或"第 k 段；删去处在…"，各段起始行按前面各段的增删换算到新文件。审批 diff 每段一个 hunk。
- 工具说明：写明同一文件的多处修改放进一次调用、用 `edits`、各处按改动前的原文定位、互不交叠、全有或全无；"几个文件的修改可以在同一次回复里连发几个 edit_file，会按顺序执行"保留。

hashline 模式（`src/tools/edit-file.ts`）：工具说明改为写明同一文件的多处修改放进一次调用的 `edits`、各处锚点按同一次读取给出、互不重叠、全部通过才一起落盘、任一处不通过整组不写。

测试：

- `src/tools/replace-edit.test.ts` 新增两条：多处成功（两项给出顺序与文件里的顺序相反，回执逐段与 diff 两个 hunk；同一行上的两处合成一段）；任一项不通过（未找到、不唯一、新旧相同）、交叠、同一段原文给两次、两种写法混用、两种都没给，一律报错且文件逐字不变。单处写法由原有用例覆盖，未改。
- hashline 模式的多处成功、任一处不通过整组不写、重叠报错由原有的 `src/tools/hashline.test.ts` 与 `src/tools/edit-file.test.ts` 覆盖。
- `src/application/runtime-edit-mode.test.ts`：replace 版 edit_file 的参数名清单加上 `edits`。
- 变异：在 execute 里先把 `edits` 逐项各写一次、再走整组写入（即去掉"全部校验后才写"），两条新用例变红（整组不写的那条在第一项已写入处失败）；还原后用例全过，文件与提交内容一致。

## 二、模型请求的失败重试（决策 420，048cb79）

pi-ai 0.84.4 的现状（只读核对，未改）：

- `utils/provider-retry.js` 的 `retryProviderRequest`：连接失败（状态码缺失）与 408、409、429、5xx 重试，响应头 `x-should-retry` 优先；有 `retry-after-ms` 或 `retry-after` 照它等，超过 `maxRetryDelayMs`（缺省 60 秒）直接报错；否则按 0.5 秒起翻倍、封顶 8 秒、减去至多四分之一的随机量退避。次数取请求选项 `maxRetries`，缺省 0。等待可被中止信号打断。
- anthropic-messages、openai-completions、openai-responses、azure-openai-responses 四条线路把开始收回复之前的那次请求包在它里面，SDK 自身的重试关着（`maxRetries: 0`），调用选项里的 `fetch` 交给 SDK 客户端，一次尝试即一次 fetch。
- 回调：`onPayload` 在第一次发送前调一次，`onResponse` 只在重试结束、拿到成功响应后调一次，`retryProviderRequest` 本身没有回调；三者都看不出发生了重试。
- google-generative-ai 与 google-vertex 两条线路遇到自带的 `fetch` 直接报错（"Custom fetch is not supported"），bedrock-converse-stream 不走 fetch。

改法：

- 设置：新节 `modelRequest`，键 `maxRetries`（整数，不小于 0，缺省 4，0 为不重试），`src/state/model-request-config.ts`；`src/state/settings.ts` 登记该节并加取值函数 `modelRequestMaxRetriesOf`。三层合并、未知键报错、`/reload` 比较随节表生效。`docs/configuration.md` 加一节"模型请求的失败重试"与节表一行。
- 包装：`src/pi-runtime/request-retry.ts` 的 `withRequestRetries` 包在模型接入的 streamFn 外层，每次调用在选项里放 `maxRetries`。`buildRuntime`（`src/application/runtime.ts`）用它包一次，主请求（再套温度与单轮输出上限的包装）、压缩摘要与网页提炼三处都用包过的这一个。终端界面、逐行对话、`pigeon run`、续接与 worker 都经 `buildRuntime` 装配。
- 记录：调用选项里的 `fetch` 换成一个按次计数的包装（建在调用方给的 fetch 或全局 fetch 之上），每次模型请求一个。一次尝试失败（非 2xx 响应，或 fetch 抛错）之后又发起了下一次尝试，即记一次重试：第几次（本次请求内从 1 起）、上一次的 HTTP 状态码（连接失败时没有，改记错误文字，至多 200 字）、上一次失败到这次发起之间的实测毫秒数。记录在重发那一刻写，失败之后没有再发的（400、次数用完）不记。记录出错不影响请求。
- 接管条件：只在接入模块声明的线路属于上面四条时才换 `fetch`。模型信息声明（`ModelInfoDeclarationSchema`，`src/state/model-info.ts`）新增可选字段 `api`（pi-ai 模型对象的同名字段，此前已在认得的键里、不告警）；自带的 DeepSeek 接入的声明加上 `api: "anthropic-messages"`。没声明或声明为其他线路的模块照样收到 `maxRetries`，只是不记。
- 会话记录：新条目 `pigeon.request-retry`（`src/state/session-entries.ts`），数据为 `version`、`runId`（Run 之外的请求，如 Run 开始前或手动的压缩摘要，不带）、`retry`、`status`、`error`、`waitMs`、`retriedAt`。会话视图（`src/state/session-view.ts`）认作 `request-retry`，按 `runId` 归到 Run；`pigeon trace` 的 Run 摘要与 `pigeon replay` 的条目各列一行（`src/application/format.ts` 的 `requestRetryLine`："模型请求重试第 n 次：上一次 HTTP 429 ｜ 等待 x 秒"，连接失败写"连接失败（错误文字）"）。
- 与决策 417 的去图重试：400 不在 pi-ai 的重试之列，请求照旧以 400 收尾，由运行面的去图重试处理，两者不重叠。重试发生在一次模型请求之内，不增加轮数。

测试：

- `src/pi-runtime/request-retry.test.ts`：自带的 DeepSeek 接入与真的 anthropic-messages 线路，调用选项注入假的 fetch（失败响应带 `retry-after-ms: 1`）。429、503 之后成功：共发 3 次，回调两次（第 1 次 429、第 2 次 503）；连接失败一次后成功：记录没有状态码、带错误文字；400：只发 1 次、不回调、以出错收尾；次数给 1 时两次 429 后以出错收尾、共发 2 次；接管条件的线路判断。
- `src/application/request-retry-wiring.test.ts`：装配层冒烟——空设置时取值为 4；设置 `modelRequest.maxRetries` 为 2、HTTP 层（替换全局 fetch，用完还原）依次回 429、503、429：共发 3 次，Run 以出错收尾，会话视图里这个 Run 有两条 `request-retry`（429、503）。
- 测试用的假 HTTP 层 `scriptedFetch`、`failedReply` 放在 `src/pi-runtime/fixtures.ts`。
- 变异：去掉包装里传的 `maxRetries`，上述两个文件的三条重试用例变红（只有线路判断那条不受影响）；还原后全过。
- 原有经真 pi-ai 线路发请求的用例（`deepseek-stream.test.ts`、`runtime-thinking.test.ts`）在自己的选项里显式给 `fetch` 与 `maxRetries: 0`，覆盖包装给的值，行为不变。
