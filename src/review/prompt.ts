// Reviewer 的任务说明（M6，决策 064 / 065）：模型只产出结论，程序落盘——Reviewer 不持有任何写工具，
// 候选由 Controller 从收尾结果里解析并写入暂存目录。输出格式与 candidates.ts 的解析 schema 同源。
import type { ReviewTarget } from "../state/review.ts";
import { REVIEW_ENTRY_TOOL, REVIEW_SNAPSHOT_TOOL } from "../state/review.ts";

export function reviewerTask(target: ReviewTarget): string {
  const scope =
    target.sinceRunSeq !== undefined
      ? `这次只审第 ${target.sinceRunSeq} 条之后的新内容（快照另带少量前情）。`
      : "这次审该运行到目前为止的全部内容。";
  return [
    "你是 Pigeon 的后台审阅者，只读、不参与主会话、不向主会话写任何消息。",
    `被审对象：会话 ${target.sessionId} 的运行 ${target.runId}。${scope}`,
    `先调用 ${REVIEW_SNAPSHOT_TOOL} 读取冻结快照；快照里被截断或省略的内容，用 ${REVIEW_ENTRY_TOOL} 按条目号回查原文，结论要以原文为据。`,
    "判断这段工作里有没有值得沉淀、以后能复用的经验，分三类：",
    "- memory：项目事实或约定（完整的 markdown 文件正文）；",
    "- skill：可复用的做法（完整的 SKILL.md 正文，开头带 name 与 description 的 frontmatter）；",
    "- policy：对审批或工具使用方式的建议（只写自然语言建议，不写规则）。",
    "没有把握的不要提；一次性的、只对本次任务成立的也不要提。",
    "最后只输出一个 JSON 对象，不要任何其他文字，格式如下：",
    '{"candidates":[{"kind":"memory|skill|policy","name":"小写字母数字与短横线","summary":"一句话摘要","strength":0.0到1.0之间的判断强度,"content":"正文","sourceRunSeqs":[支撑它的条目号]}]}',
    '没有值得沉淀的内容时输出 {"candidates":[]}。',
  ].join("\n");
}
