// 复盘指令 v1（决策 221、230、232、233）与压缩前版本的三处差异（207）：与 C 第 3 节冻结原文逐字一致；
// {验证结论} 五种填法（施工说明第 4 点、决策 242）；拒绝文字（240）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVIEW_TEMPLATE_VERSION,
  REVIEW_TOOL_REFUSAL,
  reviewInstruction,
  reviewVerdictText,
} from "./review-text.ts";

// C 第 3 节冻结原文（收尾复盘，模板 v1）
function frozenClosing(verdict: string, memory: string): string {
  return `【复盘 v1】这次会话的工作已经结束。现在只做一件事：回顾上面的整个会话，决定要不要更新本项目的学到的记忆。不要修改代码；需要核对时只用 read_file 读代码。

多数会话没有值得记的东西，一条不写是常态。动笔前先问：以后在本项目干活的 agent，会不会因为这一条而做得更好？不会就不写。

验证门的最终结论：${verdict}
验证门通过，只说明它检查的那些项没有发现问题，不等于任务做对了。

当前记忆全文（可能与会话开始时不同）：
${memory}

以证据为准：命令与工具的实际输出、读到的代码、验证门的结论才是证据。会话里说"已经修好""测试都过了"而没有对应输出支持的，不算数。

按顺序想：
1. 找出会话里出过错、后来又解决了的地方：验证或测试失败后改好、命令报错后换了做法、被用户纠正后改正。对照失败时的报错和最终修好它的改动，问：事先知道哪一条关于本项目的事实，就能少走这段弯路？这条事实在现在的代码里还成立吗？
2. 没有解决的问题，不要把尝试过的办法写成做法。只有证据清楚说明了原因时（例如报错直接指出缺什么），才可以把这个原因作为事实记下。
3. 凡是改动或删除了测试、跳过或放宽了检查、针对测试输入写了特殊处理的地方，单独看一眼：有没有依据说明测试或检查本身确实错了（例如与需求或文档矛盾）？没有依据的，这不是经验；值得记的话，记下"这样改不对"以及原因。
4. 看当前记忆：本次会话里发现过时或错误的条目，改写或删除；与新内容相近的，合并成一条，不要重复记。引用为用户要求的条目，除非用户在本次会话里改口，不要改写、合并或删除。记忆写满需要删减时，优先保留本次会话里标了编号、核对过并用上的条目。

写入标准：
- 只记以后在本项目仍然成立、会影响做法、又不容易从代码一眼看出的事实。
- 不记：任务经过；只在这次改动里才成立的事（本次改动未必会被采纳）；环境一时的故障，或"某工具不能用"一类的否定说法（若是配置问题，记怎么配）；通用的编程常识；从代码一读就知道的；密钥、令牌、密码等敏感信息（需要时只记去哪里找，不记值本身）。会话本身都有存档，经过不必记。
- 每条写成陈述句，不写成对自己的命令；附引用：代码写成 文件 或 文件::函数，来自用户明确要求而指不到代码的写 user；理由里写依据，即看到了什么输出、读了哪段代码、用户说了什么。写之前先用 read_file 确认代码引用存在。
- 记忆有总量上限，写满会被拒绝，需要先合并或删除。

用 update_memory 完成全部改动，最后用一两句话说明改了什么，或为什么不改。`;
}

test("收尾复盘指令与 C 第 3 节冻结原文逐字一致", () => {
  assert.equal(
    reviewInstruction({ kind: "closing", verdict: "通过", memory: "（记忆原文）" }),
    frozenClosing("通过", "（记忆原文）")
  );
  assert.equal(REVIEW_TEMPLATE_VERSION, "v1");
});

test("压缩前复盘与收尾复盘只有三处不同，其余逐字相同", () => {
  const closing = frozenClosing("X", "M");
  const expected = closing
    .replace(
      "【复盘 v1】这次会话的工作已经结束。现在只做一件事：回顾上面的整个会话，决定要不要更新本项目的学到的记忆。不要修改代码；需要核对时只用 read_file 读代码。",
      "【复盘 v1·压缩前】会话还没结束，但上下文马上要被压缩成摘要，前面的细节会丢。现在先只做一件事：回顾到目前为止的会话，决定要不要更新本项目的学到的记忆。不要修改代码；需要核对时只用 read_file 读代码。"
    )
    .replace(
      "验证门的最终结论：X",
      "验证门的最终结论：会话尚未结束，暂无最终结论；以前面出现过的验证或测试结果为准。"
    )
    .replace(
      "才可以把这个原因作为事实记下。",
      "才可以把这个原因作为事实记下。还在处理中的问题留给会话结束时的复盘，现在不写。"
    );
  assert.notEqual(expected, closing);
  assert.equal(reviewInstruction({ kind: "pre-compaction", memory: "M" }), expected);
});

test("{验证结论} 五种填法", () => {
  assert.equal(reviewVerdictText({ ran: false }), "本次没有运行验证门");
  const base = { faultedSteps: [], allFaulted: false, failureSummary: "失败的步骤：pytest\n……" };
  assert.equal(reviewVerdictText({ ran: true, verdict: "pass", ...base }), "通过");
  assert.equal(
    reviewVerdictText({ ran: true, verdict: "fail", ...base }),
    "未通过：失败的步骤：pytest\n……"
  );
  assert.equal(
    reviewVerdictText({ ran: true, verdict: "pass", ...base, faultedSteps: ["mypy"] }),
    "通过（mypy 的检查工具自身崩溃，未计入结论）"
  );
  assert.equal(
    reviewVerdictText({
      ran: true,
      verdict: "undetermined",
      ...base,
      faultedSteps: ["pytest", "mypy"],
      allFaulted: true,
    }),
    "无法判定：pytest、mypy 的检查工具自身都崩溃了，没有得出结论"
  );
});

test("复盘中拦下其余工具的返回文字（决策 240）", () => {
  assert.equal(
    REVIEW_TOOL_REFUSAL,
    "复盘中只能使用 read_file 与 update_memory，这次调用没有执行。"
  );
});
