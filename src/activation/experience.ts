// Skill 与 Memory 的激活写入（M8 S7，决策 093）：复制到治理根的正常目录，人之后仍可直接编辑
// （042 / 043 不变）。整文件原子替换：任何时刻落点上要么是旧内容、要么是新内容。
// 本模块只写 .pigeon/skills 与 .pigeon/memory 两个目录，绝不触碰放权文件与命令规则——
// 分层规则 activation-only-state 把放权写入模块挡在依赖之外。
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../persistence/atomic-write.ts";
import type { CandidateKind } from "../state/candidate.ts";
import { activationPathFor } from "./paths.ts";

export class ExperienceActivationError extends Error {}

// 只接受 Skill 与 Memory：这是仅有的两种可产出种类（094），其余种类混进来即响亮失败
export type LoadableKind = Extract<CandidateKind, "skill" | "memory">;

export function writeLoadableExperience(input: {
  governanceRoot: string;
  kind: LoadableKind;
  name: string;
  content: string;
}): string {
  if (input.kind !== "skill" && input.kind !== "memory") {
    throw new ExperienceActivationError(
      `本模块只写 Skill 与 Memory 的装载目录：${String(input.kind)} 不在其中`
    );
  }
  const relative = activationPathFor(input.kind, input.name);
  const absolute = join(input.governanceRoot, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileAtomic(absolute, input.content);
  return relative;
}
