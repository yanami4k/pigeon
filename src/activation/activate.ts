// 激活分派、漂移检查与撤销（M8 S7，决策 090 / 093）。
//
// 激活 = 按种类复制到治理根的正常目录，下一个会话照常装载（Skill 与 Memory），Policy 只落建议文件。
// 写盘后重算落点内容的 sha256 作为激活摘要：它与批准内容的哈希相等，是"批准内容与最终激活内容摘要一致"
// 这条完成证据的机检点——分派、写入与回读都在本层，调用方不自报哈希。
//
// 漂移（093）：人仍可直接编辑落点文件。启动时拿激活记录里的摘要与落点现状比对，不一致只标注
// "已脱离批准版本"，不阻止使用——与项目一贯做法（悬账、崩溃残留、截断标注）一致：可见，不拦截。
//
// 撤销（093）：移走落点文件并留记录，不追溯既往会话——已经跑过的会话装过它是事实，改不了也不该改。
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { type CandidateKind, isProducibleCandidateKind } from "../state/candidate.ts";
import { sha256Hex } from "../state/message-content.ts";
import { writeLoadableExperience } from "./experience.ts";

export { ACTIVATION_DIRS, activationPathFor, activationTargets } from "./paths.ts";

import { ACTIVATION_DIRS } from "./paths.ts";

export interface ActivateExperienceInput {
  governanceRoot: string;
  kind: CandidateKind;
  name: string;
  // 批准的候选正文（逐字写入落点，不加任何抬头）
  content: string;
}

export interface ActivationResult {
  // 治理根相对路径（正斜杠）
  path: string;
  // 批准内容的 sha256
  contentHash: string;
  // 写盘后从落点读回重算的 sha256；与 contentHash 相等才算激活成功
  activatedHash: string;
}

export class ActivationMismatchError extends Error {}

// 撤销的路径围栏：落点不在装载目录内时抛它
export class ActivationFenceError extends Error {}

export function activateExperience(input: ActivateExperienceInput): ActivationResult {
  // 决策 094：Policy 停止产出，也不再有落点——旧的 Policy 候选可读、可列，但不可激活
  if (!isProducibleCandidateKind(input.kind)) {
    throw new ActivationMismatchError(
      `候选种类 ${input.kind} 已停止产出，没有激活落点（决策 094）：这条旧候选只能读与拒绝`
    );
  }
  const contentHash = sha256Hex(Buffer.from(input.content, "utf8"));
  const path = writeLoadableExperience({
    governanceRoot: input.governanceRoot,
    kind: input.kind,
    name: input.name,
    content: input.content,
  });
  const activatedHash = sha256Hex(readFileSync(join(input.governanceRoot, path)));
  if (activatedHash !== contentHash) {
    throw new ActivationMismatchError(
      `激活内容与批准内容不一致：${path}（批准 ${contentHash.slice(0, 12)}，落点 ${activatedHash.slice(0, 12)}）`
    );
  }
  return { path, contentHash, activatedHash };
}

export type DriftState = "same" | "drifted" | "missing";

export interface Drift {
  state: DriftState;
  // 落点现状的哈希（文件还在时）
  currentHash?: string;
}

export function driftOf(input: {
  governanceRoot: string;
  path: string;
  activatedHash: string;
}): Drift {
  const absolute = join(input.governanceRoot, input.path);
  if (!existsSync(absolute)) {
    return { state: "missing" };
  }
  const currentHash = sha256Hex(readFileSync(absolute));
  return currentHash === input.activatedHash
    ? { state: "same" }
    : { state: "drifted", currentHash };
}

// 撤销：移走落点文件。Skill 的落点在自己的目录里，连目录一并移走；其余只移走文件。
// 围栏（M8 收口补遗）：撤销是不可逆的递归删除，落点必须落在治理根下的两个装载目录之内。
// 调用方传进来的路径来自账本记录——账本是纯 JSONL、无哈希链，不该把"记录没被动过"当前提。
export function revokeExperience(input: { governanceRoot: string; path: string }): void {
  const root = resolve(input.governanceRoot);
  const absolute = resolve(root, input.path);
  const allowed = Object.values(ACTIVATION_DIRS).map((dir) => resolve(root, dir));
  if (!allowed.some((dir) => absolute === dir || absolute.startsWith(`${dir}${sep}`))) {
    throw new ActivationFenceError(
      `撤销的落点不在装载目录内，拒绝删除：${input.path}（只许 ${Object.values(ACTIVATION_DIRS).join("、")}）`
    );
  }
  const skillDir = absolute.endsWith(`${sep}SKILL.md`)
    ? absolute.slice(0, -`${sep}SKILL.md`.length)
    : undefined;
  rmSync(absolute, { force: true });
  if (skillDir !== undefined && allowed.some((dir) => skillDir.startsWith(`${dir}${sep}`))) {
    rmSync(skillDir, { recursive: true, force: true });
  }
}
