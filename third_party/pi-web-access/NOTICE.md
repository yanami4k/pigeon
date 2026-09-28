# 第三方代码来源与许可：@amaster.ai/pi-web-access 与 @amaster.ai/pi-shared

- 来源：npm 包 `@amaster.ai/pi-web-access` 0.1.19 及其依赖 `@amaster.ai/pi-shared` 0.1.19
- 仓库：https://github.com/TGYD-helige/pi（目录 packages/pi-web-access 与 packages/shared）
- 许可：Apache License 2.0（全文见同目录 `LICENSE`）
- 版权：Copyright (c) the pi-web-access authors（包内未署具体名字，以仓库为准）
- 使用方式：按 Apache-2.0 第 4 条拷入所需部分自行维护，不把这两个包列为依赖。拷入的每个文件开头都注明来源文件、
  原许可与"已修改"；改动内容见下表与 `docs/audits/` 的对应审计。

## 拷入清单

| 本仓库文件 | 来源文件 | 主要改动 |
|---|---|---|
| `src/web/network.ts` | pi-shared `dist/network.js` | 去掉 trustedHosts 绕过；跨主机跳转不再跟随而是交回跳转目标；响应正文改为按上限截断而非报错；传输层可注入（测试用本地假服务）；错误改为带归类标记的自有错误类；注释改中文 |
| `src/web/fetch.ts` | pi-web-access `dist/fetch.js` | 去掉经 Jina Reader 的中转与按服务商抓取的分支，只保留本机直接抓取；加超时、字节数与正文字符数上限；非文本内容拒绝；结果交给提炼而不是直接返回 |
| `src/web/html.ts` | pi-web-access `dist/fetch.js` 里的 turndown 转换与标题提取 | 单独成文件；去掉脚本、样式等标签；图片只留说明文字 |
| `src/web/search.ts` | pi-web-access `dist/types.js`、`dist/search.js`、`dist/index.js` 的结果整理 | 只保留查询词与条数两个参数；结果整理改为中文文本；后端接口做成可再加 |
| `src/web/backends/anthropic-search.ts` | pi-web-access `dist/providers/anthropic.js`（search 部分）与 `dist/providers/base.js` | 只保留搜索；请求路径改为 `<baseUrl>/v1/messages` 以适配 DeepSeek 的 Anthropic 兼容端点；同时收集 `web_search_tool_result` 里的结果与正文引用；记下用量 |
| `src/web/backends/zai.ts` | pi-web-access `dist/providers/zai.js`（search 部分） | 只保留搜索；去掉时间范围与域名过滤 |
| `src/web/backends/tavily.ts` | pi-web-access `dist/providers/tavily.js`（search 部分） | 只保留搜索；去掉主题、时间范围与域名过滤 |

未拷入：`config.js`（配置读取改用 Pigeon 自己的 `.pigeon/web.json`）、`summary.js`（提炼改用本会话的模型接入，
提示词重写）、其余十余家服务的适配器、`settings.js`、`threat-patterns.js`。
