// 提炼器的任务说明（M7 S4，决策 074 / 075）：模型只产出结论，程序落盘——提炼器不持有任何写工具，
// 候选由 Controller 从收尾结果里解析并写入暂存目录。输出格式与 candidates.ts 的解析 schema 同源。
// 不向模型注入任何关于"哪边做对了"的提示之外的东西：标签来自确定性验证，快照侧头如实标注。
import { DISTILL_ENTRY_TOOL, DISTILL_SNAPSHOT_TOOL, type DistillTarget } from "../state/distill.ts";

// snapshot：渲染好的冻结对比快照，直接附在任务说明后面（121：提炼器曾不读材料就交空结果，快照不再只经工具给出）
export function distillerTask(target: DistillTarget, snapshot: string): string {
  const sides =
    target.successful !== undefined && target.failed !== undefined
      ? "这组尝试有一次成功（验证通过）与一次失败，比较两边在做法上的差别。"
      : target.successful !== undefined
        ? "这组尝试只有成功侧，总结可复用的做法。"
        : "这组尝试只有失败侧，只总结教训。";
  return [
    "你是 Pigeon 的经验提炼器，只读、不参与任何会话、不向任何会话写消息。",
    target.kind === "task"
      ? "提炼对象：同一任务的独立尝试（两侧步骤不对应，不要逐步对齐）。"
      : "提炼对象：会话树上从同一分叉点长出的两条分支。",
    sides,
    `冻结对比快照附在本说明的末尾，先通读两侧；被截断或省略的内容用 ${DISTILL_ENTRY_TOOL} 按侧与条目号回查原文（${DISTILL_SNAPSHOT_TOOL} 可重读整份快照），结论要以原文为据。`,
    "产物分三种形态：",
    "- lesson（教训）：失败侧暴露的问题与避免方式；",
    "- workflow（流程）：成功侧整体做法的顺序；",
    "- procedure（步骤集）：成功侧可以照做的具体步骤。",
    "规则：只由失败侧支撑的条目只能是 lesson，且种类不能是 memory；workflow 与 procedure 必须引用成功侧条目。",
    "种类只有两种：skill 写完整的 SKILL.md（开头带 name 与 description 的 frontmatter）；memory 写完整的 markdown 文件。",
    "只对本次任务成立、没有把握或摘要里看不出原文依据的，不要提。",
    "最后只输出一个 JSON 对象，不要任何其他文字，格式如下：",
    '{"candidates":[{"kind":"memory|skill","name":"小写字母数字与短横线","summary":"一句话摘要","strength":0.0到1.0之间的判断强度,"form":"lesson|workflow|procedure","content":"正文","evidence":{"successful":[成功侧条目号],"failed":[失败侧条目号]}}]}',
    '没有值得沉淀的内容时，candidates 为空数组，并且必须附 emptyReason：写明读了哪几侧（read 列出 successful / failed，存在的侧都要读）与为什么判断没有可学的（why），例如 {"candidates":[],"emptyReason":{"read":["successful","failed"],"why":"理由"}}。不附理由的空结果视为没有完成提炼。',
    "",
    "===== 冻结对比快照 =====",
    snapshot,
  ].join("\n");
}
