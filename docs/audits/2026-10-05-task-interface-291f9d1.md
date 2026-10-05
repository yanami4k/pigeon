# 题面加接口说明（决策 374）

基线 291f9d1（main，含决策 374 的记录）。分支 task-interface。依据决策 374 及其修改的 198、239，参照 316。

## 现状（改前）

- 题面由跑批器现拼：`src/eval/stream-runner.ts` 的 `promptFor` 调 `src/eval/stream-manifest.ts` 的 `taskPromptOf`，依次为提交信息、应通过的测试名单（239 的第一段）、要做到的用例落在本题测试文件之外时的第二段名单。版式常量 `TASK_PROMPT_LAYOUT` 记进身份头 `core.promptLayout`。
- 316 的静态规则在 `eval/analysis/pigeon_analysis/unguessable.py`：对要做到的用例所在的测试文件，收集对 strands 包的导入，对照开工代码判断模块与名字是否存在，再整词查题面。入库清单 `eval/analysis/data/unguessable-interfaces.json`：89 题中 22 题有被判文件，剔除 1485/3314 个要做到的用例，7 题无剩余用例。
- `docs/` 下没有讲跑批参数与题面格式的文档：`--prompt-format` 只见于 `src/cli/index.ts` 的用法注释与历史审计。

## 改法

1. 抽取（`eval/analysis/pigeon_analysis/task_interface.py`，命令 `python -m pigeon_analysis task-interfaces`）：按下节规则逐题算出接口说明，写成数据文件 `eval/analysis/data/task-interfaces.json`：`manifestDigest`（与跑批器身份头 `manifestDigest` 同一算法：清单文件内容的 sha256 取前 16 位）、汇总、逐题（步序 `seq`）的 `interfaces`（模块、是否新模块、名字及签名的结构化字段）、取不到签名的名字、换算不出的补丁对象个数、解析不了的文件。只读人的仓库、流清单与两类用例预计算结果，不读任何运行结果。复用 `unguessable.py` 的导入收集（`project_imports`）、开工代码判存在（`StartCode`）、题面拼法（`task_prompt`）与 316 的判定（`file_triggers`）。
2. 渲染（`src/eval/stream-manifest.ts`）：新增 `TaskInterfaceModule`、`TaskInterfaceName` 类型与 `interfacesSection`；`taskPromptOf` 加第五个参数 `interfaces`（缺省为空），非空时在名单之后空一行接上接口说明一节。带接口说明时的版式常量为 `TASK_PROMPT_LAYOUT_WITH_INTERFACES`。分析包里有同一版式的 Python 镜像（`render_section`），只供覆盖检查用。
3. 跑批器：`pigeon eval stream --task-interfaces <数据文件>`。`src/eval/stream-interfaces.ts` 读数据文件：其 `manifestDigest` 须等于本次清单的摘要，不符即拒绝开跑（在取镜像身份、写身份头、起容器之前）；数据文件内容的摘要记进身份头 `core.taskInterfaces`，`core.promptLayout` 换为带接口说明的版式；`RunStreamsOptions.taskInterfaces` 按步序交给 `promptFor`。不给该选项时 `core` 里没有 `taskInterfaces`、`promptLayout` 不变，身份摘要与改前相同，题面与改前逐字相同。
4. 文档：`src/cli/index.ts` 的用法注释与用法串、`eval/analysis/README.md`（命令、数据文件的内容与用法、结构一节）。

## 抽取规则

- 测试文件：名单两段里的文件，即本题新写或改过的测试文件（清单的 `judgeTests`），加上要做到的用例落在其外时它们所在的测试文件；取人在该步提交里的版本。
- 引用：
  - 对 strands 包的导入，文件里任何位置都算（含函数体内），收集法同 316；
  - 字符串形式的补丁目标：`patch`、`mock.patch`、`mocker.patch`（含 `target=`）、`patch.dict`、`patch.multiple` 的字符串路径，`monkeypatch.setattr`、`monkeypatch.delattr` 的字符串路径形式；`patch.object` 与 `monkeypatch.setattr` / `delattr` 的对象形式（对象加属性名字符串），对象须能按该文件的项目内导入换算成"模块.名字"，换算不出的只计数。
  - 字符串路径按人在该步的代码取最长的存在的模块前缀，其余为模块里的名字，至多再带一级属性（类的方法等）。
- 判存在（对照开工代码，规则同 316 的 `StartCode`）：模块路径存在；名字为模块作用域绑定或子模块；无法静态判定的模块（项目外星号导入、模块级 `__getattr__`）一律当作存在。名字后带一级属性的，再看开工代码里该类的类体及能换算出的项目内基类；名字不是类，或有换算不出的项目外基类（`object`、`ABC`、`Protocol`、`Generic` 除外），一律当作存在。`from 包 import 子模块` 且子模块开工时没有的，记为新模块。
- 签名（从人在该步的代码取，沿项目内的 from-import 与星号导入追到定义处）：
  - 类给构造参数：类体有 `__init__` 取其参数（去掉 self）；dataclass、NamedTuple 以字段为位置参数，pydantic `BaseModel` 与 `TypedDict` 以字段为仅限关键字参数，项目内基类的字段排在前面，`ClassVar`、`field(init=False)`、pydantic 的下划线私有属性不算；没有 `__init__` 时沿项目内基类找；基类只有 `object`、`ABC`、`Protocol`、`Generic` 时为空参数；其余（项目外基类、Enum 等）只给名字，记为取不到签名；
  - 函数与方法给参数与返回注解；
  - 其余（常量、别名、项目外导入来的名字）只给名字。
  - 注解按源码原样；缺省值是常量、名字、属性、负数或空容器的原样给出，否则写 `...`。不给实现、文档字符串与断言。
- 排序：模块按点号路径、名字按名字的字母序。

## 局限

- `getattr`、`importlib` 等动态引用不收；测试辅助文件（conftest、夹具）不查。
- 已存在的名字只判存在，不判签名是否改变；已存在的类用到的新属性只在补丁目标里查，普通属性访问不查。
- `patch.object` 的对象多为测试里现建的实例，换算不出，只计数。
- 断言里的精确文案（报错文字、输出文字）不处理，只记数量，见覆盖检查一节。

## 措辞与版式（定稿）

- 说明行（项目负责人定稿，属于被测条件，定稿后不再改）：`Modules and names used by these tests that are not in the repository yet (listed by signature):`。
- 版式：说明行之后每个模块一行（点号路径；开工代码里没有的模块后加 ` (new module)`），模块下每个名字缩进两格一行：类为 `class 名(构造参数)`，函数为 `def 名(参数) -> 返回注解`，异步函数为 `async def`，常量等只给名字，构造参数定不下来的类为 `class 名`，补丁目标指向已有类的新属性时，方法写 `def 类.方法(…)`，其余写 `类.属性`。签名里保留缺省值（常量、名字、属性、负数、空容器原样，其余写 `...`）。
- 位置：名单两段之后空一行，只在该题有内容时出现。
- 定稿所据的三个真实例子：第 8 步（新模块 `strands.experimental.bidi.audio` 下的两个类）、第 112 步（只缺一个函数 `_parse_event_stream`）、第 122 步（`compat_call_tool` 只出现在 `mock.patch` 的字符串路径里）。
- 措辞的逐字检查全仓只有一处，在 `src/eval/stream-manifest.test.ts` 的题面说明句冻结用例里（与 239 的两段名单说明句同在）。

## 数据文件

`eval/analysis/data/task-interfaces.json`，在验证服务器上以 task-interface 的提交 95f155e 生成，入库前以仓库的 biome 排版（只改空白），入库提交 ace4713，文件内容摘要 `a94e2f313a6cbd4d`。输入为正式跑用的流清单、人的仓库与两类用例预计算结果的只读副本，清单摘要 `d80b3a59b88cfefe`。

| 项 | 数 |
|---|---|
| 题 | 89 |
| 有接口说明的题 | 33 |
| 新模块 | 34 |
| 名字（含新模块下的） | 122 |
| 取不到签名的名字 | 9 |
| 换算不出对象的 `patch.object` 等（分布在 49 题） | 214 |
| 解析不了的测试文件 | 0 |

有接口说明的题（步序）：8、64、68、69、73、79、82、93、94、97、103、109、111、112、120、121、122、126、129、136、137、141、145、149、154、159、167、179、184、187、188、189、195。316 清单里有被判文件的 22 题全在其中；其余 11 题的条目，按两条规则的差别只能来自 316 不计的部分：字符串补丁目标、名单第一段里没有要做到用例的测试文件，或已以整词出现在题面里的名字（316 按题面放过，本段只看开工代码）。

取不到签名的名字（照规则只给名字）：

| 步序 | 模块 | 名字 | 原因 |
|---|---|---|---|
| 79 | `strands.telemetry.metrics` | `metrics_sdk` | 人的代码里该模块也没有绑定这个名字（测试里的补丁目标 `strands.telemetry.metrics.metrics_sdk.MeterProvider`） |
| 137 | `strands.vended_tools.web_fetch` | `WebFetchError` | 基类为项目外的异常类，构造参数定不下来 |
| 149 | `strands.tools.mcp` | `MCPCancelTaskResult`、`MCPCreateTaskResult`、`MCPGetTaskResult`、`MCPUpdateTaskResult` | 基类为项目外的类，构造参数定不下来 |
| 167 | `strands._context_manager.stash` | `_BytesEncoder` | 同上 |
| 189 | `strands.experimental.bidi.models.bedrock` | `_BedrockAWSCRTHTTPClient`、`_BedrockAWSCRTHTTPResponse` | 同上 |

## 覆盖检查

- 做法：`python -m pigeon_analysis task-interfaces … --coverage`，对每题要做到的用例所在的测试文件，用 316 的 `file_triggers`（导入的模块或名字开工时不存在、且未以整词出现在题面里即触发），题面换成带接口说明的新题面（Python 镜像渲染）。
- 结果：仍判为接口不可猜的题 0、文件 0、用例 0（改前按 316 为 22 题、35 个文件、1485 个用例）。
- 渲染一致：一次性脚本对 89 题逐题比对，跑批器 `taskPromptOf` 带接口数据拼出的题面与覆盖检查用的 Python 镜像逐字相同 89/89。
- 抽不出的情形只记数量，不处理：名单两段的测试文件里，`pytest.raises(…, match=<字符串>)` 1310 处、`assert` 的 `==` 或 `in` 比较一侧为不短于 10 个字符的字符串常量 3665 处，分布在 88 题的 224 个文件。这是按写法数的上界，不区分所断言的文案是否为本题新写；换算不出对象的补丁目标 214 个，见上表。

## 正式跑题面的复现

- 冻结标签 formal-run-v1 未动。
- 一次性脚本对 89 题逐题比对：取 formal-run-v1 的 `src/eval/stream-manifest.ts` 与本分支的 `taskPromptOf`，按 `promptFor` 的拼法（test-files 格式、第二段取要做到的用例落在本题测试文件之外的文件）不给接口数据时，题面逐字相同 89/89；给了接口数据时有 33 题题面不同，即有接口说明的 33 题。
- 不给 `--task-interfaces` 时身份头 `core` 不含 `taskInterfaces`、`promptLayout` 不变；身份摘要的序列化丢掉未定义的项，摘要与改前相同。

## 测试

新代码的测试量（对基线 291f9d1 的新增行）：Python 产品代码 580 行（`task_interface.py` 567、`cli.py` 13），测试 152 行；TypeScript 产品代码 126 行，测试 127 行（比产品代码多 1 行）；合计产品代码 706 行、测试 279 行。

- `eval/analysis/tests/test_task_interface.py`（7 条，内存里的合成仓库）：补丁目标的字符串与对象形式及换算不出的计数；函数体内的导入与第二段名单的文件计入；开工时已有的名字（含基类已有的方法）不列；新模块标记与 `import 新模块` 只列模块；各类签名（`__init__`、dataclass 含 `field`、pydantic、TypedDict、沿项目内基类、项目外基类只给名字、异步函数、复杂缺省值写 `...`）与取不到签名的记录；签名里不带实现与文档字符串；数据文件记清单摘要，覆盖检查用新题面、去掉接口说明时同一用例按 316 仍判不可猜。
- `src/eval/stream-manifest.test.ts`：接口说明接在两段名单之后的版式；没有接口说明时题面与不传时逐字相同；说明行逐字冻结（与 239 同一用例）。
- `src/eval/stream-interfaces.test.ts`：按步序取出有内容的题，摘要随文件内容变；清单摘要不符即拒绝。
- `src/eval/stream-experiment.test.ts`：清单摘要不符时在取镜像身份、写身份头之前拒绝开跑（docker 命令指向不存在的路径，检查排在后面就会先报 docker 的错）。
- `src/eval/stream-runner.test.ts`：按步序接上接口说明，数据里没有的步不加（一条冒烟）。

## 变异验证

只做关键判定，去掉判定后确认相应用例变红，再还原并核对文件逐字一致（sha256）：

| 判定 | 变异 | 变红的用例 |
|---|---|---|
| 开工时已有的名字不进接口说明 | 去掉存在判定 | `test_names_present_at_start_are_not_listed` |
| 签名里不带实现 | 缺省值一律原样展开 | `TestSignatures` 两条 |
| 签名里不带实现与文档字符串 | 函数的参数表换成整段函数源码 | `test_no_implementation_or_docstring` |
| 不给接口数据时题面逐字不变 | `taskPromptOf` 无条件接上接口说明一节 | `stream-manifest.test.ts` 的 239 题面用例、374 接口说明用例、说明句冻结用例共 3 条 |
| 清单摘要不符拒绝开跑 | 去掉摘要比对 | `stream-interfaces.test.ts` 与 `stream-experiment.test.ts` 各 1 条 |

均在最终代码上跑（Python 三项在开发机上，TypeScript 两项在验证服务器的提交 ace4713 上）；五项还原后文件逐字一致。

## verify 的实际运行情况

验证服务器 pigeon-verify（8 vCPU、31 GB 内存，Node 24.12.0），专属目录内的克隆，提交 ace4713：

- `TEST_CONCURRENCY=6 npm run verify:full`：lint（biome 637 个文件）、check（tsc）通过；测试 323 个文件全过，1818 条通过、7 条跳过，测试步 56 秒；deps 无违规。开跑前服务器上没有其他测试在跑。
- 分析包 `python -m pytest`（含慢档模拟检验，Python 3.12.3，依赖照 requirements.txt 装在专属目录的虚拟环境里）：289 条通过。
- 此前一次 verify:full（提交 c5a7792，整理提交之前的临时提交；与 db1ca06 只差 `stream-manifest.test.ts` 里一条用例的精简）测试步 1 条失败：`src/application/context-prune-wiring.test.ts` 的"状态栏的用量按实际发出的上下文估算：裁剪之后的那次请求出错、没有新的 usage 时，裁掉的量也已减去"（期望 3807、实得 6008）。本段没有改该文件及其所测代码；同一提交上单独跑该文件 3 次均 4/4 通过；ace4713 上的 verify:full 未复现。
