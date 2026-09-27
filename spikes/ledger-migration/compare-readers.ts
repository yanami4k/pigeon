// 读者输出的新旧对照（决策 180 / 206，账本重构第三段）：在当前代码上用假模型跑几次真实的双写运行，同一批会话分别用
// 旧读法（迁移前的只读旧版代码，读旧账本）与新读法（当前代码，读新会话存储）产出搜索与显示读者的输出，逐项比较。
// 旧读法由参数给出的旧版工作树导入，只读，不写任何文件。
// 预期差异先写成清单（见 README.md 的"读者对照"一节）：归一化只处理清单里的项，其余任何不一致都算清单外差异，以非零退出码报出。
//
// 用法：node spikes/ledger-migration/compare-readers.ts --old <迁移前旧版代码的工作树>
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runHeadless } from "../../src/application/headless.ts";
import { loadSessionHistory } from "../../src/application/history.ts";
import type { McpSession } from "../../src/application/mcp.ts";
import { runSearchCommand } from "../../src/application/search.ts";
import { runSessionListCommand } from "../../src/application/session-list.ts";
import { runReplayCommand } from "../../src/cli/replay.ts";
import { runTraceCommand } from "../../src/cli/trace.ts";
import {
  createReadSessionEntryTool,
  createSearchSessionsTool,
} from "../../src/memory/search-tools.ts";
import { compareDualWrite } from "../../src/persistence/dual-write-compare.ts";
import { materializeSession } from "../../src/persistence/event-log.ts";
import { listSessionRefs, loadSessionView } from "../../src/persistence/session-catalog.ts";
import { createFakeStreamFn } from "../../src/pi-runtime/fixtures.ts";

const oldIndex = process.argv.indexOf("--old");
const oldRoot = oldIndex > 0 ? process.argv[oldIndex + 1] : undefined;
if (oldRoot === undefined) {
  process.stderr.write("用法：node spikes/ledger-migration/compare-readers.ts --old <旧版工作树>\n");
  process.exit(2);
}
const importOld = async <T>(path: string): Promise<T> =>
  (await import(pathToFileURL(resolve(oldRoot, path)).href)) as T;

type TextResult = { content: Array<{ text?: string }> };
const old = {
  trace: await importOld<{ runTraceCommand: typeof runTraceCommand }>("src/cli/trace.ts"),
  replay: await importOld<{ runReplayCommand: typeof runReplayCommand }>("src/cli/replay.ts"),
  history: await importOld<{ loadSessionHistory: typeof loadSessionHistory }>(
    "src/application/history.ts"
  ),
  list: await importOld<{ runSessionListCommand: typeof runSessionListCommand }>(
    "src/application/session-list.ts"
  ),
  search: await importOld<{ runSearchCommand: typeof runSearchCommand }>(
    "src/application/search.ts"
  ),
  tools: await importOld<{
    createSearchSessionsTool: (options: { sessionsDir: string }) => {
      execute(id: string, params: unknown): Promise<TextResult>;
    };
    createReadSessionEntryTool: (options: { sessionsDir: string }) => {
      execute(id: string, params: unknown): Promise<TextResult>;
    };
  }>("src/memory/search-tools.ts"),
};

// ---------- 样例：当前代码上的真实双写运行 ----------

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

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-compare-readers-")));
const home = mkdtempSync(join(tmpdir(), "pigeon-compare-home-"));
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
const sessionsDir = join(dir, ".pigeon", "sessions");
const base = { governanceRoot: dir, workspaceRoot: dir, yolo: true, homeDir: home, startMcp: noMcp };
const edit = (content: string) => ({
  text: "改",
  thinking: "先读再改",
  toolCalls: [
    { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: content } },
  ],
});

// 一：先改错、验证失败、失败自动分叉重试后改对（来源会话与分支会话；思考、快照、验证、分叉）
await runHeadless({
  ...base,
  task: "把 a.txt 改成 new",
  streamFn: createFakeStreamFn({
    replies: [edit("wrong\n"), { text: "改好了" }, edit("new\n"), { text: "这次对了" }],
  }),
  verify: { command: `"${process.execPath}" check.mjs`, timeoutMs: 30_000 },
  retryOnFail: 1,
});
// 二：工具出错（读不存在的文件）与多次读取，撞轮数上限中止
await runHeadless({
  ...base,
  task: "读 missing.txt 找线索",
  maxTurns: 2,
  streamFn: createFakeStreamFn({
    replies: [
      { text: "读", toolCalls: [{ name: "read_file", args: { path: "missing.txt" } }] },
      { text: "再读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { text: "还读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { text: "完" },
    ],
  }),
});
// 三：只聊天、正常完成
await runHeadless({
  ...base,
  task: "线索是什么",
  streamFn: createFakeStreamFn({ replies: [{ text: "线索在 a.txt 里" }] }),
});

// ---------- 对照 ----------

interface ReaderReport {
  compared: number;
  equal: number;
  expected: Record<string, number>;
  unexpected: string[];
}
const reports: Record<string, ReaderReport> = {};
function reporter(name: string): ReaderReport {
  reports[name] ??= { compared: 0, equal: 0, expected: {}, unexpected: [] };
  return reports[name];
}
function expect(report: ReaderReport, category: string, count = 1): void {
  if (count > 0) report.expected[category] = (report.expected[category] ?? 0) + count;
}
function check(report: ReaderReport, where: string, before: string[], after: string[]): void {
  report.compared += 1;
  if (before.length === after.length && before.every((line, index) => line === after[index])) {
    report.equal += 1;
    return;
  }
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index++) {
    if (before[index] !== after[index]) {
      report.unexpected.push(`${where} 第 ${index + 1} 行：旧 ${before[index]} ｜ 新 ${after[index]}`);
      return;
    }
  }
}

const sessionIds = listSessionRefs(sessionsDir).map((ref) => ref.sessionId);
// 旧条目号 → 新条目号（按会话、Run 与 Run 内序号对应）
const entryMap = new Map<string, string>();
for (const sessionId of sessionIds) {
  const view = loadSessionView(sessionsDir, sessionId);
  const byKey = new Map(
    (view?.messages ?? []).map((message) => [`${message.runId}#${message.runSeq}`, message.entryId])
  );
  for (const entry of materializeSession(sessionsDir, sessionId as never).entries) {
    const mapped = byKey.get(`${entry.runId}#${entry.runSeq}`);
    if (mapped !== undefined) entryMap.set(entry.id, mapped);
  }
}
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const MINUTE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g;
const CLOCK = /\d{2}:\d{2}:\d{2}(\.\d{3})?/g;
const withIds = (text: string) =>
  text.replace(/entry_[0-9A-HJKMNP-TV-Z]{26}/g, (id) => entryMap.get(id) ?? id);
const times = (text: string) => text.replace(ISO, "<时刻>").replace(MINUTE, "<时刻>").replace(CLOCK, "<时刻>");

// 双写对照：同一次运行的新旧记录说的是同一件事（第一段的工具）
const dual = reporter("双写对照（第一段工具）");
for (const sessionId of sessionIds) {
  const comparison = compareDualWrite({ sessionsDir, sessionId });
  dual.compared += 1;
  if (comparison.diffs.length === 0) dual.equal += 1;
  for (const diff of comparison.diffs) {
    dual.unexpected.push(`${sessionId} ${diff.area} ${diff.where}：${diff.detail}`);
  }
}

// 1 search_sessions：条目号换新编号、时刻不比；末行去掉"与当时的治理记录"
{
  const report = reporter("search_sessions");
  for (const keywords of [["a.txt"], ["改"], ["线索"], ["new"], ["不存在的词"]]) {
    const before = (
      await old.tools.createSearchSessionsTool({ sessionsDir }).execute("t", { keywords })
    ).content
      .map((block) => block.text ?? "")
      .join("");
    const after = (await createSearchSessionsTool({ sessionsDir }).execute("t", { keywords })).content
      .map((block) => block.text ?? "")
      .join("");
    const tail = "用 read_session_entry 按 entryId 读原文与当时的治理记录，结论须回查原文。";
    if (before.includes(tail)) expect(report, "末行去掉「与当时的治理记录」");
    const normalized = times(withIds(before)).replace(tail, "用 read_session_entry 按 entryId 读原文，结论须回查原文。");
    expect(report, "条目号换成新存储的编号", (before.match(/entry_[0-9A-HJKMNP-TV-Z]{26}/g) ?? []).length);
    check(report, `关键词 ${keywords.join("、")}`, normalized.split("\n"), times(after).split("\n"));
  }
}

// 2 read_session_entry：去掉正文哈希一行与同 Run 治理邻居一段
{
  const report = reporter("read_session_entry");
  for (const [oldId, newId] of entryMap) {
    const before = (
      await old.tools.createReadSessionEntryTool({ sessionsDir }).execute("t", { entryId: oldId })
    ).content
      .map((block) => block.text ?? "")
      .join("")
      .split("\n");
    const after = (
      await createReadSessionEntryTool({ sessionsDir }).execute("t", { entryId: newId })
    ).content
      .map((block) => block.text ?? "")
      .join("")
      .split("\n");
    const hashLine = before.findIndex((line) => line.startsWith("正文哈希："));
    if (hashLine >= 0) {
      before.splice(hashLine, 1);
      expect(report, "去掉正文哈希一行");
    }
    const neighbors = before.findIndex((line) => line.startsWith("--- 同 Run 治理邻居"));
    if (neighbors >= 0) {
      before.splice(neighbors);
      expect(report, "去掉同 Run 治理邻居一段");
    }
    expect(report, "条目号换成新存储的编号");
    check(report, `条目 ${newId}`, before.map((line) => times(withIds(line))), after.map(times));
  }
}

// 3 /search 命令
{
  const report = reporter("/search 命令");
  for (const args of [["a.txt"], ["改", "--role", "assistant"], ["线索", "--limit", "1"]]) {
    const before = await old.search.runSearchCommand({ root: dir, args });
    const after = await runSearchCommand({ root: dir, args });
    expect(report, "条目号换成新存储的编号", (before.match(/entry_[0-9A-HJKMNP-TV-Z]{26}/g) ?? []).length);
    check(report, args.join(" "), times(withIds(before)).split("\n"), times(after).split("\n"));
  }
}

// 4 会话列表：去掉待对账突出行
{
  const report = reporter("会话列表");
  const before = old.list.runSessionListCommand({ root: dir }).split("\n");
  const kept = before.filter((line) => !line.includes("条待对账"));
  expect(report, "去掉待对账突出行", before.length - kept.length);
  check(report, "全部会话", kept, runSessionListCommand({ root: dir }).split("\n"));
}

// 5 历史（TUI 续跑视图与 --with-content 共用）：去掉审批拒绝行与工具错误归类后缀
{
  const report = reporter("历史");
  for (const sessionId of sessionIds) {
    const before = old.history.loadSessionHistory(dir, sessionId);
    const kept: string[] = [];
    for (const line of before) {
      if (line.text.startsWith("[已拒绝]")) {
        expect(report, "去掉审批拒绝行（决定记录停写）");
        continue;
      }
      const stripped = line.text.replace(/ -> error \[(domain|environment)\]$/, " -> error");
      if (stripped !== line.text) expect(report, "工具行去掉错误归类（工具级分类待第二段）");
      kept.push(`${line.kind} ${stripped}`);
    }
    const after = loadSessionHistory(dir, sessionId).map((line) => `${line.kind} ${line.text}`);
    check(report, sessionId, kept, after);
  }
}

// 6 trace：逐行归类——治理、回执、缺口等旧行与新增的结果、结束方式等行按清单计数，其余逐行比较
const TRACE_REMOVED: Array<[RegExp, string]> = [
  [/^ {6}审批：/, "工具调用的审批行"],
  [/^ {6}拒绝理由：/, "工具调用的拒绝理由行"],
  [/^ {6}哈希证据：/, "工具调用的哈希证据行"],
  [/^ {6}Receipt /, "工具调用的回执行"],
  [/^ {6}(命令|文件变化)：/, "命令档回执的命令与文件变化行"],
  [/^ {6}确证：/, "确证行"],
  [/^ {6}熔断：/, "工具调用的熔断行"],
  [/^ {6}分类：/, "工具调用级分类行（工具级分类待第二段）"],
  [/^ {6}待对账：/, "待对账行"],
  [/^ {2}缺口：/, "Run 头下的缺口行"],
  [/^ {2}熔断落闸：/, "Run 头下的熔断落闸行"],
  [/^ {2}验证判决：/, "Eval 验证判决行（eval.verified 停写）"],
];
const TRACE_ADDED: Array<[RegExp, string]> = [
  [/^ {6}结果：/, "工具调用的结果行"],
  [/^ {6}代码快照：/, "工具调用的代码快照行"],
  [/^ {2}结束方式：/, "Run 收尾的结束方式行"],
  [/^ {2}验证：/, "验证记录行"],
  [/^分支会话：/, "分支会话来历行"],
];
function traceLines(text: string, table: Array<[RegExp, string]>, report: ReaderReport): string[] {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const hit = table.find(([pattern]) => pattern.test(line));
    if (hit !== undefined) {
      expect(report, hit[1]);
      continue;
    }
    kept.push(
      times(line)
        .replace(/ ｜ 待对账 \d+ 次 ｜ 落盘缺口 \d+ 处/, "")
        .replace(" ｜ run.ended 缺失（崩溃残留可能）", " ｜ 未收尾")
        .replace(" ｜ Run 收尾缺失（崩溃残留可能）", " ｜ 未收尾")
        .replace("stopReason=无（turn.completed 缺失）", "stopReason=无")
        .replace("stopReason=无（无助手消息）", "stopReason=无")
    );
  }
  return kept;
}
{
  const report = reporter("trace");
  for (const sessionId of sessionIds) {
    const before = old.trace.runTraceCommand({ root: dir, sessionId, withContent: true });
    const after = runTraceCommand({ root: dir, sessionId, withContent: true });
    if (/待对账 \d+ 次/.test(before)) expect(report, "会话头去掉待对账与落盘缺口计数");
    check(
      report,
      sessionId,
      traceLines(before, TRACE_REMOVED, report),
      traceLines(after, TRACE_ADDED, report)
    );
  }
}

// 7 replay：时间线条目类型不同（旧为账本记录，新为会话条目），按事实比较——消息、工具调用、工具结果、Run 开始与收尾按顺序，
// 快照、验证、分叉、授权、worker 按集合；轮次事件、请求观察、治理与回执等停写记录按类计数
function oldReplayFacts(text: string, report: ReaderReport): { sequence: string[]; customs: string[] } {
  const sequence: string[] = [];
  const customs: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\S+ (\S+) ｜ (.*)$/.exec(line);
    if (match === null) continue;
    const [, kind = "", detail = ""] = match;
    if (kind === "entry") {
      const entry = /run 内第 (\d+) 条（(\w+)）/.exec(detail);
      sequence.push(`消息 ${entry?.[1]} ${entry?.[2]}`);
    } else if (kind === "tool.proposed") {
      sequence.push(detail.replace(/^工具提议 (\S+)（(\S+)）参数 /, "调用 $1 $2 "));
    } else if (kind === "tool.settled") {
      sequence.push(detail.replace(/^工具落定 (\S+)（(\S+)）(成功|失败).*$/, "结果 $1 $2 $3"));
    } else if (kind === "run.started") {
      sequence.push(detail);
    } else if (kind === "run.ended") {
      sequence.push("Run 收尾");
    } else if (kind === "workspace.checkpoint") {
      customs.push(detail.replace(/ ｜ 对应条目 \d+/, ""));
    } else if (["attempt.verified", "session.forked", "grant.created", "grant.revoked", "child.spawned", "child.settled"].includes(kind)) {
      customs.push(detail.replace(/，Receipt \d+ 条/, ""));
    } else {
      expect(report, `停写记录 ${kind}`);
    }
  }
  return { sequence, customs };
}
function newReplayFacts(text: string): { sequence: string[]; customs: string[] } {
  const sequence: string[] = [];
  const customs: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\S+ (\S+) ｜ (.*)$/.exec(line);
    if (match === null) continue;
    const [, kind = "", detail = ""] = match;
    if (kind === "message") {
      const entry = /run 内第 (\d+) 条（(\w+)）/.exec(detail);
      const result = /工具结果 (\S+)（(\S+)）(成功|失败)/.exec(detail);
      if (result !== null) sequence.push(`结果 ${result[1]} ${result[2]} ${result[3]}`);
      sequence.push(`消息 ${entry?.[1]} ${entry?.[2]}`);
      for (const call of detail.matchAll(/工具调用 (\S+)（(\S+)）参数 (.*?)(?= ｜ 工具调用 |$)/g)) {
        sequence.push(`调用 ${call[1]} ${call[2]} ${call[3]}`);
      }
    } else if (kind === "pigeon.run-start") {
      sequence.push(detail);
    } else if (kind === "pigeon.run-end") {
      sequence.push("Run 收尾");
    } else {
      customs.push(detail);
    }
  }
  return { sequence, customs };
}
{
  const report = reporter("replay");
  for (const sessionId of sessionIds) {
    for (const run of loadSessionView(sessionsDir, sessionId)?.runs ?? []) {
      const before = old.replay.runReplayCommand({ root: dir, sessionId, runId: run.runId });
      const after = runReplayCommand({ root: dir, sessionId, runId: run.runId });
      const oldFacts = oldReplayFacts(before, report);
      const newFacts = newReplayFacts(after);
      const badge = (text: string) => /分类：(\S+)/.exec(text.split("\n")[0] ?? "")?.[1];
      check(report, `${run.runId} 分类`, [badge(before) ?? ""], [badge(after) ?? ""]);
      check(report, `${run.runId} 时间线`, oldFacts.sequence, newFacts.sequence);
      check(report, `${run.runId} 自定义条目`, [...oldFacts.customs].sort(), [...newFacts.customs].sort());
    }
  }
}

const unexpected = Object.values(reports).reduce((sum, report) => sum + report.unexpected.length, 0);
process.stdout.write(`${JSON.stringify({ sessions: sessionIds.length, readers: reports }, null, 2)}\n`);
process.exitCode = unexpected > 0 ? 1 : 0;
try {
  git(dir, ["worktree", "prune"]);
} catch {}
rmSync(dir, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
