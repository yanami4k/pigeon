# read_file 认出图片（决策 414）施工审计

基线 6976dc9。提交 8dc3a36（判定与交回）、b1f4217（模型元数据）、fd6ae76（上下文裁剪）、efa123f（回看）、8f9bbe3（测试补强）、55658fc（文档）、3bdadd7（单张字节上限改为 5,000,000）、59add2f 与 151f05a（图片预算不清最近一轮），另加本审计所在的提交。图片缩放未实现，选型见第六节。

## 一、判定与交回（8dc3a36、3bdadd7）

新模块 `src/tools/file-kind.ts`（纯函数，不做 IO）：

- 图片：按文件头认 PNG（签名 + 首块 IHDR）、JPEG（FF D8 FF，逐段跳到第一个帧头 SOF0–SOF15，除去 C4、C8、CC）、GIF（GIF87a/GIF89a）、WebP（RIFF…WEBP，首块 VP8、VP8L、VP8X 三种写法），并读出像素尺寸。扩展名不参与判定。读不出尺寸的仍认作图片，但不交出图片内容。
- 二进制：不是这四种图片时，满足任一条即判为二进制——开头 8000 字节里有 NUL（与 Git 同一口径，UTF-16/32 文本也在此列）；文件头是认得的格式（PDF、ZIP、gzip、xz、7z、ELF、SQLite、WebAssembly、TIFF；只收不会是文本开头的签名，PDF 靠这一条认）；开头 8000 字节里非法 UTF-8 序列的个数超过字节数的一成（按 TextDecoder 解码出的 U+FFFD 个数减去文件里本就写着的 EF BF BD；采样截在多字节字符中间的不算）。其余按文本读，与原来相同。

`read_file`（`src/tools/read-file.ts`）：

- 新选项 `imageInput`（模型能看图）。读到的字节先过上面的判定；图片与二进制整个交回，不分行，`offset`、`limit` 不适用，不带快照与行锚点。details 为 `ReadFileWholeDetails`（`resolvedPath`、`kind` 为 image 或 binary、`bytes`，图片另有 `mimeType`、`width`、`height`、交出了图片才有 `imageSent: true`，二进制另有 `format`）。
- 能交出图片的条件：`imageInput` 为真、读出了尺寸、长边不超过 2000 像素、base64 编码后不超过 5,000,000 字节。结果为一行文字"[路径] 图片 类型 宽×高，N 字节"加一个 pi-ai 的图片内容块（`type: "image"`、`data` 为 base64、`mimeType`）。
- 不交出时只有一行元信息加原因与办法：模型不能看图（提示 file、identify、tesseract、python 图像库）；读不出尺寸；超过单张上限（提示先用命令行工具缩小再读）。二进制文件写类型（认得的格式或"类型未认出"）与字节数，提示 file、xxd、strings；非 UTF-8 的写非法序列占比，提示 iconv 转码。
- 图片与二进制的读取同样记进读取记录（`reads.record`，按整个文件字节），write_file 的"读过且读后未变"对它们照常生效。
- 工具说明：只在 `imageInput` 为真时追加一句（四种图片以图片交回、不必为看图写脚本或装库、单张上限、其他二进制只给类型与大小）；不能看图时说明与原来逐字相同。
- 文本文件的行为（分页、行号、锚点、字节与单行上限、落盘输出的虚拟路径）不变。

## 二、模型元数据（b1f4217）

- `src/state/model-info.ts`：声明的 schema 新增 `input`（pi-ai 模型对象的同名字段，`"text" | "image"` 的数组）；逐项取值新增 `input`，与 `reasoning` 一样只有声明与目录两层，取不到记 unknown；`acceptsImages(info)` 在来源不是 unknown 且含 `image` 时为真。Run 开始条目的 `modelInfo` 新增可选的 `input`（带来源），此前的记录没有它。
- `src/pi-runtime/model-access.ts`：pi-ai 目录查询另取 `input`；"声明给全就不加载目录"的判断加上 `input`。
- `src/pi-runtime/deepseek-model.ts`：`deepseekInput(modelId)` 按型号给输入类型，`deepseek-flash` 为 `["text", "image"]`，其他型号为 `["text"]`。交给 pi-ai 的模型对象与 `deepseekModelInfo()` 的声明取同一份。pi-ai 0.84.4 在组请求前按模型对象的 `input` 把不支持的图片块换成占位文字（`transform-messages.js`），模型对象改了之后图片块原样经 Anthropic 线路以 `image` 块发出。
- `src/application/runtime.ts`：`buildRuntime` 按解析出的模型信息算 `acceptsImages`，传给 read_file。无人值守（`pigeon run`）、交互终端与 worker 都经 `loadStreamFn` 登记模型信息、经 `buildRuntime` 装配，取值一致。
- 智能体循环里的占位模型对象（`input: ["text"]`）未改：pi-agent-core 0.84.4 不读它的 `input`，自带的 DeepSeek 接入发请求时用自己的模型对象。

## 三、上下文裁剪与压缩（fd6ae76、59add2f）

压缩（现状，未改）：pi-agent-core 的摘要请求把待摘要段序列化成纯文字（只取文本块），不带图片；压缩掉的那段里的图片随之移出上下文，保留段（缺省约 2 万 token）里的图片留着。上游按每张图 4800 字符（约 1200 token）估算。

裁剪（`src/pi-runtime/context-prune.ts`）：

- 改前：带图的工具结果在免费时机按"较大的旧结果"可被裁（估算约 1200 token，大于缺省的最小大小 500）；付费时机不裁。DeepSeek 的缓存保留时长按 3600 秒计，持续请求的长会话里空闲时机很少触发、1M 窗口下压缩也很少触发，图片会一直留在上下文里，且每次请求都整段重发。
- 图片与二进制的读取按整个文件算读取范围（`readWindowOf` 给全部行），之后再读同一文件，前一次即成过时读取；占位写明"读取图片 路径（类型，宽×高）"或"读取二进制文件 路径（格式）"。
- 新增图片预算 `contextPrune.maxImageBytes`（缺省 8 MiB，按 base64 字节数）：没裁、这次也没选中的工具结果里的图片合计超过预算时，不论时机、不受保护轮与价格比约束，从最旧的起把带图的工具结果换成占位，直到合计不超过预算的一半；最新一个带图的结果与最近一轮（最后一条助手消息发起的调用，模型还没看过）的结果不清。总开关关掉时不清。
- 会话记录：`pigeon.prune` 的时机新增 `images`（这次只因图片预算而裁），原因新增 `image`；trace 与 replay 的裁剪行写"图片超过预算"。时机为 `images` 时估算代价照付费时机算。
- 裁掉带图的读取时照原规则处理读取记录：上下文里再没有同一文件没裁的读写结果时不再算读过。

## 四、会话记录与回看（efa123f）

- 会话记录里图片块按原样（base64）保存。会话视图原已把图片块投影为类型、字节数与哈希。
- 回看历史（终端界面）与 `pigeon trace`、`pigeon replay` 带正文时，工具结果原本一律折叠成"[result] 工具名 ok（N 字符，已折叠）"，图片不显示；现在带图的结果在括号里加"M 张图片"。不输出 base64。
- 终端界面实时显示的工具结果只取文本块（原有），显示的是那一行元信息。

## 五、上限与预算的依据

服务商文档，2026-10-11 核对：

| 服务商 | 格式 | 单张 | 单边像素 | 请求 |
| --- | --- | --- | --- | --- |
| DeepSeek（deepseek-flash） | JPEG、PNG、GIF、WebP，按内容判格式 | base64 或外链 32 MiB | 8192；一条请求 15 张及以上时 4096 | 请求体 48 MiB，至多 600 张；服务端把大图缩到约 1300×1300 的像素量，每张至多 1024 token；图片只能在 user 消息里（Anthropic 格式的工具结果在 user 消息里） |
| Anthropic | JPEG、PNG、GIF、WebP | base64 10 MB（直连）、5 MB（Bedrock、Google Cloud） | 8000；一条请求超过 20 张时每张两边都不超过 2000 | 标准端点请求 32 MB，至多 100 或 600 张 |
| OpenAI | PNG、JPEG、WebP、非动图 GIF | — | 服务端缩到 2048 见方以内 | 请求至多 512 MB、1500 张 |
| Gemini | PNG、JPEG、WebP、HEIC、HEIF（不含 GIF） | — | 按 768 见方分块计 token | 内联数据时整条请求至多 20 MB |

- 长边 2000 像素：一条请求里图片多时有服务方把单张两边限到 2000，按这个取，图片在历史里累积也不触限；也接近各家服务端缩放的目标尺寸，更大只增加请求体、不增加清晰度。
- base64 5,000,000 字节：单张上限里最严的一档是 5 MB（Bedrock、Google Cloud 上的 Anthropic 模型），按十进制取，两种理解都不超。
- 图片预算 8 MiB：小于各家请求上限里较小的 20 MB（Gemini 内联）与 32 MB（Anthropic），留出文字的余量；超过后清到一半，避免预算附近每读一张图就改写一次前缀。

## 六、缩放的选型（未实现，待定）

本次未引入依赖。超过单张上限的图片现在只给元信息。可选做法（体积为 npm 登记的解包大小，2026-10-11 查；当前 `dist/pigeon-cli.mjs` 约 4.0 MB）：

| 做法 | 例子 | 打包（单文件 dist） | 跨平台 | 体积与代价 |
| --- | --- | --- | --- | --- |
| A. 只按上限拒绝、不缩放（现状） | — | 不变 | 一致 | 零依赖；长边超过 2000 像素的常见截图（2560×1440、2880×1800）与照片交不出，模型要靠命令行工具缩小，环境里没有图像工具时又回到装库绕路 |
| B. 纯 JS 编解码 + 自写缩放 | pngjs 7.0.0（MIT，无依赖，约 650 KB）、jpeg-js 0.4.4（BSD-3-Clause，无依赖，约 76 KB）；缩放按面积平均自写 | 可打进单文件，只放 dist 的部署照常可用 | 一致 | 只覆盖 PNG 与 JPEG（没有纯 JS 的 WebP 解码器，GIF 需另加 omggif），GIF、WebP 超限仍拒；大图解码在主线程、千万像素级要秒级（估计，未实测）；内存按 RGBA 计（4000×3000 约 48 MB） |
| C. WASM 编解码 | @jsquash/jpeg 1.6.0、png 3.1.1、webp 1.5.0、resize 2.1.1（Apache-2.0，合计约 1.9 MB）；或 photon-node 0.3.4（约 2.3 MB）、wasm-vips 0.0.19（约 13 MB） | wasm 文件须随包分发或以 base64 内嵌进单文件（约多三分之一），打包脚本要改 | 一致 | 四种格式都能缩；体积大于 B，加载 wasm 有启动开销 |
| D. 本地编译模块 | sharp 0.35.5（Apache-2.0，按平台的预编译 libvips，linux-x64 一份约 18.7 MB，libvips 为 LGPL-3.0-or-later）、@napi-rs/image 1.15.0 | 不能打进单文件，须作为外部依赖安装；只放 dist 的部署没有它即不可用 | 按平台的可选依赖，musl 与 glibc 要分开 | 最快、格式最全；安装体积最大 |
| E. 调用系统命令 | ImageMagick、vips、ffmpeg、macOS 的 sips、python 图像库 | 不变 | 随环境：多数任务容器与 Windows 缺省没有 | 零依赖；要逐个探测与回退；对不可信图片调外部解码器另有安全面；容器工作区的文件在宿主上读，命令在哪边跑要另定 |

推荐 B：单文件打包与只放 dist 的部署不变，跨平台一致，新增的两个依赖小且没有传递依赖，覆盖最常见的大图（PNG 截图、JPEG 照片）；GIF、WebP 超限照现状只给元信息。缩放目标建议长边不超过 2000 像素，缩后编码仍超 5,000,000 字节时转 JPEG 并降质量。

## 七、测试

产品代码 +452 −28 行，测试（含夹具）+312 −14 行。

- `tools/read-file-images.test.ts`（新）：四种图片（PNG 用 node:zlib 现场生成的合法最小图，其余三种为只含尺寸所需结构的文件头，PNG 用错的扩展名）在能看图时交出图片块，内容为原字节的 base64，元信息行带尺寸与字节数，记进读取记录；不能看图时图片只给元信息，说明不提图片；开头有 NUL、PDF、GBK 编码三种二进制只回一个文本块，不含 U+FFFD、原文与行锚点，记进读取记录；长边恰为 2000 照交、2001 与编码后超 5,000,000 字节不交；只有个别非法字节的文本照常分行读。
- `pi-runtime/context-prune.test.ts`：图片超过预算时时机记 images，从最旧的起清到一半以下，占位带路径与尺寸，最新一张单独超过也留着，最近一轮同时读的几张合计超过也留着；不超过不清；同一张图片再读一次，前一次成过时读取。
- `state/model-info.test.ts`：输入类型逐项取（目录、声明、未知），`acceptsImages` 的真假；声明给全（含 `input`）时不查目录。
- `application/runtime-model-info.test.ts`：目录查询取出 `input`；Run 开始条目记下 `input` 与来源，声明能看图时模型看到的 read_file 说明写明交回图片；DeepSeek 的声明与模型对象都含 image，`deepseek-v4-pro` 只有 text。
- `pi-runtime/deepseek-stream.test.ts`：发出的模型对象 `input` 为 `["text", "image"]`。
- `cli/content-view.test.ts`：带图的工具结果在 trace 与 replay 带正文时折叠行注明 1 张图片，不出 base64。夹具 `session-store-fixtures.ts` 的工具结果可带图片块。
- 既有测试的改动：`read-file.test.ts`、`edit-file.test.ts` 按 details 的联合类型改了类型标注；`runtime-model-info.test.ts` 里"声明给全"的夹具加了 `input`。

变异验证（去掉判定、确认相应用例变红、还原后核对产品文件与提交一致）：能否看图的判定、整文件读取记进读取记录、NUL 规则、非法 UTF-8 占比规则、长边上限、字节上限、图片预算的触发、清到一半即停、最新一张不清（初次未变红，补了用例后变红）、最近一轮不清、装配层把能否看图传给 read_file、DeepSeek 型号的输入类型，共 12 处，均变红。

## 八、本机验证

- `npm run check`（tsc）、`npm run deps` 通过；改动文件 `biome check` 通过。
- 改动涉及的 45 个测试文件（`--maxWorkers=2`）：238 通过、2 跳过。
- `scripts/build-bundle.mjs --out` 到临时目录生成成功，产物已删除。
- 未跑 `verify:full`；没有调用模型接口。

## 九、待补与未定

- 需在验证服务器上补跑 `verify:full`；真实的 DeepSeek 请求（工具结果里带图片块、思考模式、多轮）本机未发。
- 文件头完整而数据损坏的图片会照常交出；服务方若因此拒收整条请求，这张图留在上下文里，之后的请求会一直失败，目前没有按请求出错清掉图片的处理。
- MCP 工具返回的图片原样转成图片块，模型对象改为能看图后不再被换成占位；它们不经单张上限检查，只受图片预算约束。
- 非法 UTF-8 一成的阈值按开头 8000 字节算：几十字节的短 Latin-1 文件里有一两个重音字母即超过一成，按非 UTF-8 文本只给元信息。
- read_file 不按服务方区分格式：对不收 GIF 的服务方（如上表的 Gemini），GIF 会交出去。
- 图片的 token 估算沿用上游每张约 1200 token。
- 最近一轮不清：一轮里同时读很多张接近单张上限的图片时，这一轮的图片合计可能超过预算，直到下一轮才清。

## 十、回报

分支 worktree-agent-ad1bd543ccbf96884，头为本审计提交（基线 6976dc9，未推送）。完成：read_file 按文件头认四种图，模型能看图且未超限（长边2000、5MB）交图，否则及其他二进制只给元信息；能否看图取自模型 input；裁剪加图片预算，回看注明图片数。缩放待裁决，推荐纯 JS 解 PNG/JPEG 自写缩放。变异 12 处均红；本机测试、tsc、biome 过。待服务器补 verify:full 与真实看图。存疑：坏图致拒收会卡住后续请求。
