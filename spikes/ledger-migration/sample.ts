// 旧转新转换器的样例（决策 180）：在当前代码上用假模型跑一次带思考、工具调用、快照、验证与失败分叉重试的运行，得到双写的新文件；
// 再用转换器把同一次运行的旧账本转成新格式，按新 schema 校验转换结果，并与双写的新文件逐条比对，差异按预期差异清单归类。
// 清单外的差异视为转换器缺陷，以非零退出码报出。
//
// 用法：node spikes/ledger-migration/sample.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import { runHeadless } from "../../src/application/headless.ts";
import type { McpSession } from "../../src/application/mcp.ts";
import {
  branchEntries,
  locateSessionFile,
  readSessionFile,
  type StoredEntry,
} from "../../src/persistence/session-reader.ts";
import { createFakeStreamFn } from "../../src/pi-runtime/fixtures.ts";
import { SESSION_ENTRY_SCHEMAS } from "../../src/state/session-entries.ts";
import { convertLegacySession } from "./convert-legacy.ts";

// 预期差异的归类：字段路径 → 类别（与 README.md 的清单一一对应）；归不进任何一类的即清单外差异
function categoryOf(path: string): string | undefined {
  if (/\.(timestamp|startedAt|endedAt)$/.test(path)) return "时间（条目盖章时刻与记录时刻）";
  if (/thinkingSignature$/.test(path)) return "思考签名";
  if (/\.message\.api$/.test(path)) return "api 记为 unknown";
  if (/\.message\.(usage|stopReason|errorMessage)/.test(path)) return "用量与停止原因（取自 turn.completed）";
  if (/\.message\.details/.test(path)) return "工具结果 details";
  if (/\.data\.forkEntryId$/.test(path)) return "条目号（转换沿用旧 EntryId，双写为新生成）";
  if (/\.message\.content\[\d+\]\.(type|text|data|mimeType)$/.test(path)) return "图片占位";
  return undefined;
}

function diffPaths(before: unknown, after: unknown, at: string, out: string[]): void {
  if (isDeepStrictEqual(before, after)) return;
  if (
    typeof before === "object" &&
    before !== null &&
    typeof after === "object" &&
    after !== null &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const segment = Array.isArray(before) ? `[${key}]` : `.${key}`;
      diffPaths(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        `${at}${segment}`,
        out
      );
    }
    return;
  }
  out.push(at);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-convert-sample-")));
const home = mkdtempSync(join(tmpdir(), "pigeon-convert-home-"));
const outRoot = mkdtempSync(join(tmpdir(), "pigeon-convert-out-"));
try {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "pigeon@example.invalid"]);
  git(dir, ["config", "user.name", "pigeon-sample"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(dir, "a.txt"), "old\n");
  writeFileSync(
    join(dir, "check.mjs"),
    'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("a.txt", "utf8") === "new\\n" ? 0 : 1);\n'
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  const edit = (content: string) => ({
    text: "改",
    thinking: "先读再改",
    toolCalls: [
      { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: content } },
    ],
  });
  const result = await runHeadless({
    task: "把 a.txt 改成 new",
    governanceRoot: dir,
    workspaceRoot: dir,
    streamFn: createFakeStreamFn({
      replies: [edit("wrong\n"), { text: "改好了" }, edit("new\n"), { text: "这次对了" }],
    }),
    yolo: true,
    homeDir: home,
    startMcp: noMcp,
    verify: { command: `"${process.execPath}" check.mjs`, timeoutMs: 30_000 },
    retryOnFail: 1,
  });
  const sessionsDir = join(dir, ".pigeon", "sessions");
  const converted = await convertLegacySession({
    sessionsDir,
    sessionId: result.sessionId,
    outRoot,
    cwd: dir,
  });
  const dualView = readSessionFile(locateSessionFile(sessionsDir, result.sessionId)?.path ?? "");
  const convertedView = readSessionFile(converted.path);
  if (dualView === undefined || convertedView === undefined) {
    throw new Error("样例的会话文件读不出");
  }
  const dual = branchEntries(dualView, dualView.lanes.get("main") ?? null);
  const legacy = branchEntries(convertedView, convertedView.lanes.get("main") ?? null);

  const invalid: string[] = [];
  for (const entry of legacy) {
    const schema =
      entry.type === "custom"
        ? SESSION_ENTRY_SCHEMAS[entry.customType as keyof typeof SESSION_ENTRY_SCHEMAS]
        : undefined;
    if (schema !== undefined && !Value.Check(schema, entry.data)) {
      invalid.push(`${String(entry.customType)}：${[...Value.Errors(schema, entry.data)][0]?.message}`);
    }
  }
  const shape = (entries: StoredEntry[]) =>
    entries.map((entry) => (entry.type === "custom" ? String(entry.customType) : entry.type));
  const categories = new Map<string, number>();
  const unexpected: string[] = [];
  if (!isDeepStrictEqual(shape(dual), shape(legacy))) {
    unexpected.push(`条目序列不同：双写 ${shape(dual).join(",")}；转换 ${shape(legacy).join(",")}`);
  } else {
    dual.forEach((entry, index) => {
      const paths: string[] = [];
      const pick = (item: StoredEntry) =>
        item.type === "message" ? { message: item.message } : { data: item.data };
      diffPaths(pick(entry), pick(legacy[index] as StoredEntry), `#${index}`, paths);
      for (const path of paths) {
        const category = categoryOf(path);
        if (category === undefined) {
          unexpected.push(path);
        } else {
          categories.set(category, (categories.get(category) ?? 0) + 1);
        }
      }
    });
  }
  const report = {
    sessionId: result.sessionId,
    entries: { dual: dual.length, converted: legacy.length },
    converted: { messages: converted.messages, customs: converted.customs },
    schemaErrors: invalid,
    expectedDifferences: Object.fromEntries(categories),
    unexpected,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = invalid.length > 0 || unexpected.length > 0 ? 1 : 0;
} finally {
  try {
    git(dir, ["worktree", "prune"]);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(outRoot, { recursive: true, force: true });
}
