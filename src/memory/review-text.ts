// 复盘指令（决策 186、221、230、232、233；模板 v1）与验证结论的填法（242）。文字是 C 第 3 节冻结原文，一字不改；
// 改一字即换条件，须升模板版本号。压缩前复盘（207）与收尾复盘只有三处不同：第一句、验证结论一行、第 2 点末尾加一句。
// {当前记忆全文} 由调用方在复盘时现读 MEMORY.md 填入（干活的 agent 中途可能已改过）。

// 模板版本：复盘会话的 Run 开始条目记下它
export const REVIEW_TEMPLATE_VERSION = "v1";

// 复盘种类：收尾 / 压缩前
export type ReviewKind = "closing" | "pre-compaction";

// 复盘中拦下其余工具时的返回文字（决策 240）
export const REVIEW_TOOL_REFUSAL = "复盘中只能使用 read_file 与 update_memory，这次调用没有执行。";

// 复盘中放行的两件工具（施工默认 Q9、决策 240、241）
export const REVIEW_ALLOWED_TOOLS: readonly string[] = ["read_file", "update_memory"];

const CLOSING_OPENING =
  "【复盘 v1】这次会话的工作已经结束。现在只做一件事：回顾上面的整个会话，决定要不要更新本项目的学到的记忆。不要修改代码；需要核对时只用 read_file 读代码。";
const PRE_COMPACTION_OPENING =
  "【复盘 v1·压缩前】会话还没结束，但上下文马上要被压缩成摘要，前面的细节会丢。现在先只做一件事：回顾到目前为止的会话，决定要不要更新本项目的学到的记忆。不要修改代码；需要核对时只用 read_file 读代码。";
const PRE_COMPACTION_VERDICT_LINE =
  "验证门的最终结论：会话尚未结束，暂无最终结论；以前面出现过的验证或测试结果为准。";
const POINT_TWO =
  "2. 没有解决的问题，不要把尝试过的办法写成做法。只有证据清楚说明了原因时（例如报错直接指出缺什么），才可以把这个原因作为事实记下。";
const PRE_COMPACTION_POINT_TWO_TAIL = "还在处理中的问题留给会话结束时的复盘，现在不写。";

// 复盘指令全文。收尾复盘要给验证结论；压缩前复盘不用
export function reviewInstruction(
  input:
    | { kind: "closing"; verdict: string; memory: string }
    | { kind: "pre-compaction"; memory: string }
): string {
  const closing = input.kind === "closing";
  return [
    closing ? CLOSING_OPENING : PRE_COMPACTION_OPENING,
    "",
    "多数会话没有值得记的东西，一条不写是常态。动笔前先问：以后在本项目干活的 agent，会不会因为这一条而做得更好？不会就不写。",
    "",
    closing ? `验证门的最终结论：${input.verdict}` : PRE_COMPACTION_VERDICT_LINE,
    "验证门通过，只说明它检查的那些项没有发现问题，不等于任务做对了。",
    "",
    "当前记忆全文（可能与会话开始时不同）：",
    input.memory,
    "",
    '以证据为准：命令与工具的实际输出、读到的代码、验证门的结论才是证据。会话里说"已经修好""测试都过了"而没有对应输出支持的，不算数。',
    "",
    "按顺序想：",
    "1. 找出会话里出过错、后来又解决了的地方：验证或测试失败后改好、命令报错后换了做法、被用户纠正后改正。对照失败时的报错和最终修好它的改动，问：事先知道哪一条关于本项目的事实，就能少走这段弯路？这条事实在现在的代码里还成立吗？",
    closing ? POINT_TWO : `${POINT_TWO}${PRE_COMPACTION_POINT_TWO_TAIL}`,
    '3. 凡是改动或删除了测试、跳过或放宽了检查、针对测试输入写了特殊处理的地方，单独看一眼：有没有依据说明测试或检查本身确实错了（例如与需求或文档矛盾）？没有依据的，这不是经验；值得记的话，记下"这样改不对"以及原因。',
    "4. 看当前记忆：本次会话里发现过时或错误的条目，改写或删除；与新内容相近的，合并成一条，不要重复记。引用为用户要求的条目，除非用户在本次会话里改口，不要改写、合并或删除。记忆写满需要删减时，优先保留本次会话里标了编号、核对过并用上的条目。",
    "",
    "写入标准：",
    "- 只记以后在本项目仍然成立、会影响做法、又不容易从代码一眼看出的事实。",
    '- 不记：任务经过；只在这次改动里才成立的事（本次改动未必会被采纳）；环境一时的故障，或"某工具不能用"一类的否定说法（若是配置问题，记怎么配）；通用的编程常识；从代码一读就知道的；密钥、令牌、密码等敏感信息（需要时只记去哪里找，不记值本身）。会话本身都有存档，经过不必记。',
    "- 每条写成陈述句，不写成对自己的命令；附引用：代码写成 文件 或 文件::函数，来自用户明确要求而指不到代码的写 user；理由里写依据，即看到了什么输出、读了哪段代码、用户说了什么。写之前先用 read_file 确认代码引用存在。",
    "- 记忆有总量上限，写满会被拒绝，需要先合并或删除。",
    "",
    "用 update_memory 完成全部改动，最后用一两句话说明改了什么，或为什么不改。",
  ].join("\n");
}

// 补做（决策 295）：此前的复盘已覆盖到第 N 条时，在指令第一段之后加这一句（仍给完整上下文）；没有此前的复盘时不加，
// 指令与模板 v1 逐字相同。日常使用专用，实验不经过这里
export function reviewedUpToLine(n: number): string {
  return `第 ${n} 条及之前已复盘，重点看之后的部分。`;
}

export function withReviewedUpTo(instruction: string, n: number): string {
  const [opening, ...rest] = instruction.split("\n");
  return [opening, "", reviewedUpToLine(n), ...rest].join("\n");
}

// {验证结论} 的填法（施工说明第 4 点、决策 242）。
// verdict 为最后一次验证的结论；faultedSteps 为其中标了工具故障的步名；failureSummary 为回炉反馈的同一份失败摘要
export type ReviewVerdictInput =
  | { ran: false }
  | {
      ran: true;
      verdict: "pass" | "fail" | "undetermined";
      // 标了工具故障的步名（检查工具自身崩溃，重跑一次仍崩溃，不计入结论）
      faultedSteps: readonly string[];
      // 各步全是工具故障（整体无法判定）
      allFaulted: boolean;
      failureSummary: string;
    };

export function reviewVerdictText(input: ReviewVerdictInput): string {
  if (!input.ran) {
    return "本次没有运行验证门";
  }
  const faulted = input.faultedSteps.join("、");
  if (input.verdict === "pass") {
    return faulted === "" ? "通过" : `通过（${faulted} 的检查工具自身崩溃，未计入结论）`;
  }
  if (input.verdict === "fail") {
    return `未通过：${input.failureSummary}`;
  }
  if (input.allFaulted) {
    return `无法判定：${faulted} 的检查工具自身都崩溃了，没有得出结论`;
  }
  // 其余无法判定（超时、被信号终止、拉不起来）：冻结文字没有这一种，沿用失败摘要，前缀取 242 的"无法判定："
  return `无法判定：${input.failureSummary}`;
}
