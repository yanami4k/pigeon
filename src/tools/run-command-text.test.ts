// run_command 的说明按实际执行端与审批状态生成（170 ④）：执行端决定需要 shell 的命令经哪个 shell 运行，
// 审批状态决定命令要不要人工批准；四处文字（登记描述、系统提示里的一句、开工状态块审批一节里命令的说法、工具说明）同出一源。
// 决策 363：系统提示里的一句与审批无关，审批的说法在开工状态块
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { createRunCommandTool, runCommandTexts } from "./run-command.ts";

// 文字含有各区分片段（shell、审批状态等），不逐字比对整段
function assertIncludesAll(text: string, fragments: readonly string[]): void {
  for (const fragment of fragments) {
    assert.ok(text.includes(fragment), `缺少「${fragment}」：${text}`);
  }
}

test("容器执行端（linux）且自动批准：需要 shell 的命令经 /bin/sh -c 运行、命令自动批准，不提人工批准", () => {
  const texts = runCommandTexts({ platform: "linux", approval: "yolo" });
  assert.equal(
    texts.registry,
    "在工作区根运行一条命令（普通命令直接执行，需要 shell 语义的经 /bin/sh -c 执行）"
  );
  // 决策 363：系统提示里的一句只说经哪个 shell，不提审批；审批的说法在状态块一节与工具说明里
  assertIncludesAll(texts.prompt, ["/bin/sh -c"]);
  assert.doesNotMatch(texts.prompt, /批准|放权/);
  for (const text of [texts.approval, texts.tool]) {
    assertIncludesAll(text, ["/bin/sh -c", "命令自动批准"]);
  }
  // 三种情形共用的工具说明尾句（commands 短名、文件变化不含治理目录）只在这里核对一次
  assertIncludesAll(texts.tool, ["commands 一节", ".pigeon"]);
  for (const text of Object.values(texts)) {
    assert.doesNotMatch(text, /人工批准|不经 shell，不支持/);
  }
});

test("本地 Windows 执行端且有人工审批：需要 shell 的命令经人确认后经 cmd.exe 运行、每条命令都要人工批准", () => {
  const texts = runCommandTexts({ platform: "win32", approval: "prompt" });
  assert.equal(
    texts.registry,
    "在工作区根运行一条命令（普通命令直接执行，需要 shell 语义的经 cmd.exe 执行）"
  );
  assertIncludesAll(texts.prompt, ["cmd.exe"]);
  assert.doesNotMatch(texts.prompt, /批准|放权/);
  assertIncludesAll(texts.approval, ["人确认后经 cmd.exe", "每条命令都要人工批准"]);
  assertIncludesAll(texts.tool, ["人确认后经 cmd.exe", "每条命令都需要人工批准"]);
});

test("没有审批通道（无人值守且未放权）：命令须有放权规则放行，否则被拒绝", () => {
  const texts = runCommandTexts({ platform: "linux", approval: "none" });
  // 系统提示里的一句与审批状态无关（续跑与 /reload 后逐字节不变）
  assert.equal(texts.prompt, runCommandTexts({ platform: "linux", approval: "yolo" }).prompt);
  for (const text of [texts.approval, texts.tool]) {
    assertIncludesAll(text, ["/bin/sh -c", "未被放权规则放行的命令会被拒绝"]);
  }
});

test("工具说明取执行端的平台与传入的审批状态；不给审批状态按有人工审批", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-command-text-"));
  try {
    const linux = createLocalWorkspaceHost(root, { platform: "linux" });
    assert.equal(
      createRunCommandTool({ workspaceRoot: root, host: linux, approval: "yolo" }).description,
      runCommandTexts({ platform: "linux", approval: "yolo" }).tool
    );
    const win = createLocalWorkspaceHost(root, { platform: "win32" });
    assert.equal(
      createRunCommandTool({ workspaceRoot: root, host: win }).description,
      runCommandTexts({ platform: "win32", approval: "prompt" }).tool
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
