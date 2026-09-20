// 激活落点（M8 S7，决策 093；094 收敛为两类）：每种经验在治理根下的正常目录与文件名。
// 落点即"真激活"的位置：回放的临时治理根按同一份路径放置经验，装载路径因此与真激活完全相同（085）。
// 纯函数，不碰文件系统；写入在 experience.ts。
// 决策 094：Policy 停止产出，其只读建议目录与独立写入模块一并删除；候选种类枚举里的 policy
// 取值只为读旧记录保留，落点表不再收它——旧的 Policy 候选可读、可列，但不可批准、不可激活。
import type { ProducibleCandidateKind } from "../state/candidate.ts";

// 治理根下的相对目录（正斜杠，用于展示与记录）
export const ACTIVATION_DIRS: Readonly<Record<ProducibleCandidateKind, string>> = {
  skill: ".pigeon/skills",
  memory: ".pigeon/memory",
};

// 落点相对路径：Skill 是目录加 SKILL.md（与 Skill Catalog 的标准目录一致），
// Memory 是目录下的同名 markdown（常驻 Memory 按文件名字典序装载）
export function activationPathFor(kind: ProducibleCandidateKind, name: string): string {
  return kind === "skill"
    ? `${ACTIVATION_DIRS.skill}/${name}/SKILL.md`
    : `${ACTIVATION_DIRS.memory}/${name}.md`;
}

export function activationTargets(
  entries: readonly { kind: ProducibleCandidateKind; name: string }[]
): string[] {
  return entries.map((entry) => activationPathFor(entry.kind, entry.name));
}
