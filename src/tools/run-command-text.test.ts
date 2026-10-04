// run_command 的说明按实际执行端与审批状态生成（170 ④）：执行端决定需要 shell 的命令经哪个 shell 运行，
// 审批状态决定命令要不要人工批准；四处文字（登记描述、系统提示里的一句、开工状态块审批一节里命令的说法、工具说明）同出一源。
// 决策 363：系统提示里的一句与审批无关，审批的说法在开工状态块
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { createRunCommandTool, runCommandTexts } from "./run-command.ts";

test("容器执行端（linux）且自动批准：需要 shell 的命令经 /bin/sh -c 运行、命令自动批准，不提人工批准", () => {
  const texts = runCommandTexts({ platform: "linux", approval: "yolo" });
  assert.equal(
    texts.registry,
    "在工作区根运行一条命令（普通命令直接执行，需要 shell 语义的经 /bin/sh -c 执行）"
  );
  assert.equal(
    texts.prompt,
    "用 run_command 运行命令：普通命令直接执行，含管道、重定向或 && 串联的命令经 /bin/sh -c 执行。"
  );
  assert.equal(
    texts.approval,
    "run_command：命令自动批准；含管道、重定向或 && 串联的命令经 /bin/sh -c 执行。"
  );
  assert.equal(
    texts.tool,
    "在工作区根运行一条命令。普通命令不经 shell 直接执行；管道、重定向、&& 串联等需要 shell 的命令经 /bin/sh -c 运行。" +
      "本会话的命令自动批准。" +
      "可用设置 commands 一节登记的短名。结果带退出码、输出（超长截断）与执行前后的文件变化（不含 Pigeon 自己的治理目录 .pigeon）。"
  );
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
  assert.equal(
    texts.prompt,
    "用 run_command 运行命令：普通命令直接执行，含管道、重定向或 && 串联的命令经 cmd.exe 执行。"
  );
  assert.equal(
    texts.approval,
    "run_command：每条命令都要人工批准；含管道、重定向或 && 串联的命令须经人确认后经 cmd.exe 执行，尽量拆成单条命令。"
  );
  assert.equal(
    texts.tool,
    "在工作区根运行一条命令。普通命令不经 shell 直接执行；管道、重定向、&& 串联等需要 shell 的命令只在人确认后经 cmd.exe 运行，" +
      "尽量拆成单条命令。每条命令都需要人工批准，除非本会话已放行这条一模一样的命令。" +
      "可用设置 commands 一节登记的短名。结果带退出码、输出（超长截断）与执行前后的文件变化（不含 Pigeon 自己的治理目录 .pigeon）。"
  );
});

test("没有审批通道（无人值守且未放权）：命令须有放权规则放行，否则被拒绝", () => {
  const texts = runCommandTexts({ platform: "linux", approval: "none" });
  assert.equal(
    texts.prompt,
    "用 run_command 运行命令：普通命令直接执行，含管道、重定向或 && 串联的命令经 /bin/sh -c 执行。"
  );
  assert.equal(
    texts.approval,
    "run_command：本会话没有人工审批通道，未被放权规则放行的命令会被拒绝；含管道、重定向或 && 串联的命令须有放权规则允许才经 /bin/sh -c 执行。"
  );
  assert.equal(
    texts.tool,
    "在工作区根运行一条命令。普通命令不经 shell 直接执行；管道、重定向、&& 串联等需要 shell 的命令须有放权规则允许才经 /bin/sh -c 运行。" +
      "本会话没有人工审批通道：未被放权规则放行的命令会被拒绝。" +
      "可用设置 commands 一节登记的短名。结果带退出码、输出（超长截断）与执行前后的文件变化（不含 Pigeon 自己的治理目录 .pigeon）。"
  );
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
