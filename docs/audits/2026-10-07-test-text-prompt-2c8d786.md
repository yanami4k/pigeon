# 对比评测题面附判题测试全文（test-text 格式，决策 403）

基线：origin/main 头 2c8d786。分支 test-text-prompt，只提交不推送。范围：新题面格式 test-text（提交信息 + 应通过的测试名单 + 人在该步判题测试文件的全文）；现有格式 test-files、test-cases 与接口说明（374）行为不变。

## 一、提交

| 提交 | 内容 |
|---|---|
| e859d76 | 题面格式 test-text 与全文节的拼法（stream-manifest） |
| 5615533 | 跑批器题面接 test-text：全文取人在该步提交时的版本（stream-runner） |
| 4e33d61 | test-text 与接口数据同给即拒绝；身份头记新版式；CLI 用法与 README |
| d639a0d | 容器查杀测试的进程探测改用可移植的 ps 形态（见五） |

## 二、改法

- `stream-manifest.ts`：`TaskPromptFormat` 加 `test-text`；`taskTextPromptOf` 拼题面——名单两段（说明句与 test-files 逐字相同），其后按名单顺序以 `--- 路径 ---` 为标题附各判题测试文件全文（末尾空白去掉、不与分段空行叠加），全文节与旧格式 `buildTaskPrompt`（M9 做法）共用同一个 `testTextSection`；新版式常量 `TASK_PROMPT_LAYOUT_TEST_TEXT` 与版式选择 `promptLayoutOf`（test-text 恒为附全文版式，其余格式给了接口说明为带接口说明的版式）。
- `stream-runner.ts` `promptFor`：test-text 时名单同 test-files（含第二段），全文为 `step.judgeTests` 各文件在 `step.commit` 上的人写版本（`human.show` 的 utf8 文本）；两组条件收到的是同一个字符串（每步只拼一次题面，交各条件的步 agent），工作方式指令照旧前接。
- `stream-experiment.ts`：`--prompt-format test-text` 与 `--task-interfaces` 同给即拒绝（在读清单、写身份头、起容器之前）；身份头 `core.promptFormat` 记 `test-text`、`core.promptLayout` 记新版式，与旧身份头不同即不同条件、旧目录不能续跑（既有身份比对逻辑）。
- 测试文件只附在题面里，不放进工作区；判题照旧在判题时放入人的测试（未动判题路径）。
- `cli/index.ts` 用法注释与用法串加 test-text 并注明不与 --task-interfaces 同给；`eval/analysis/README.md` 补该格式的说明段。

## 三、79 道题的题面体积（test-text，产品代码现拼）

对正式跑的 79 个题号（操作手册第 5 节），用交付代码 `taskTextPromptOf` 在原料（清单、人的仓库、两类用例预计算）上现拼题面量字符数：

- 中位 88,813；90 分位 248,131；最大 705,679。
- 超过 100,000 字符的题共 35 道。最大的五道：题 22（步 73，12 个判题文件）705,679；题 82（步 186）577,718；题 12（步 49）525,140；题 88（步 193）367,167；题 40（步 117）317,387。
- 量法：一次性脚本调交付代码现拼（读清单、按提交取测试文件全文、第二段名单取两类用例预计算里的 failToPass），脚本未入库。

## 四、测试与变异

- 本机：`src/eval/stream-manifest.test.ts`、`stream-experiment.test.ts`、`stream-runner.test.ts` 三文件 88 过 1 跳（跳过为既有）；biome 与 tsc 通过。
- 新用例：题面全文节拼法与空名单/空全文边界（manifest）；跑批器端到端——题面附人在该步提交时的版本（改过的测试文件不是起点的版本）且两个条件逐字相同（runner）；test-text 与接口数据同给即拒绝、拒绝前不写身份头（experiment）；版式选择（test-text 恒为附全文版式）（manifest）。
- 变异反向验证（每次只改一处，跑对应用例后还原）：
  - 全文取起点（step.parent）版本：runner 新用例精确变红。
  - 两个条件的题面拼接入条件名：runner 新用例精确变红。
  - test-files 说明句改一词：题面说明句逐字冻结等 2 条变红（旧格式逐字不变仍受既有用例把守）。
  - 去掉 test-text 与接口数据的冲突拒绝：experiment 新用例精确变红。
  - 版式选择去掉 test-text 分支：manifest 版式用例精确变红。

## 五、验证服务器上的发现与修复

- verify:full 首次跑出一处失败：`src/execution/container-host.test.ts` 的真容器查杀用例。该用例的进程探测用 `ps | grep`，依赖 busybox 的 plain ps 带命令行参数；现场镜像为 Debian 系（procps 的 plain ps 不带参数），探测恒为 0。与本段的题面改动无关：在基线提交 2c8d786 上同环境复跑同一文件同样失败。
- 修复（d639a0d）：探测改为 `ps -o args=`（procps 与 busybox 都带命令行全文）。只动该测试的探测写法，不动被测行为。
- verify:full 复跑（d639a0d，带真容器镜像与容器用 Node 运行时的环境变量）：329 个测试文件、1890 过、7 跳、0 败（含 pigeon-docker 真容器 4 条与修复后的查杀用例）。

## 六、需要裁决的问题

1. 题面体积：35/79 题超过 100,000 字符（最大 705,679），按说明未截断、停下报告。选项：A 照跑不截断（接受成本上升，预算按新题面重新推算）；B 剔除超限题（改题集，需预注册修订）；C 截断或只附部分文件（需另定规则并修订预注册）。

## 回报

分支 test-text-prompt，基线 2c8d786，只提交未推送。test-text 题面=提交信息+应通过名单（两段同 test-files）+人在该步判题测试全文（该步提交时的版本，全文节复用 M9 旧格式做法）；两组条件逐字相同；与 --task-interfaces 同给即拒绝；身份头记新格式与新版式，旧目录不能续跑。体积：中位 88,813、90 分位 248,131、最大 705,679，35/79 题超 100,000，按说明停下未截断。本机三个测试文件 88 过 1 跳，变异 5 处精确变红并还原；验证服务器 verify:full 329 文件、1890 过、7 跳、0 败。另修一处既有真容器测试的 ps 可移植性（基线同样挂，见五）。待裁决：超限题 A 照跑不截断／B 剔除／C 截断。

## 追加：变基

2026-10-07 晚：origin/main 并入分析判据段后推进到 8dbd3ac；本分支 5 个提交原样变基到 8dbd3ac（无冲突，变基后头 44adf8e）。变基后 tsc 与题面单测复跑通过。
