// Spike part C: 真实链路 —— pi-tui ProcessTerminal + TuiMainScreen 在真实 Windows ConPTY 下
// 跑最小控件（Text + CURSOR_MARKER 探针）+ 中文长文本流式输出 + resize 尝试。
// 验证手段：同控制台 PowerShell 读 [Console]::CursorLeft/Top（ConPTY 不应答 CPR，part B 已实测）。
// 必须在 PTY 下运行；无 TTY 退出码 2。
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { eastAsianWidth } from "get-east-asian-width";
import { CURSOR_MARKER, ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";

const out = process.stdout;
const results = [];
if (!out.isTTY) {
	console.log("NOT_TTY");
	process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROBE_FILE = "tmp/spike-pi-tui/cursor-probe.txt";
function cursorPos() {
	rmSync(PROBE_FILE, { force: true });
	execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`[Console]::CursorLeft.ToString() + ',' + [Console]::CursorTop.ToString() | Out-File -FilePath '${PROBE_FILE}' -Encoding ascii`,
		],
		{ stdio: ["inherit", "inherit", "inherit"] },
	);
	const [col, row] = readFileSync(PROBE_FILE, "ascii").trim().split(",").map(Number);
	return { col, row };
}
function refWidth(s) {
	let w = 0;
	for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s))
		w += eastAsianWidth(segment.codePointAt(0));
	return w;
}

results.push(`ENV columns=${out.columns} rows=${out.rows}`);
out.write("\nspike part C 启动前基线行\n");
const baseline = cursorPos();

const term = new ProcessTerminal();
const tui = new TuiMainScreen(term, false, "tmp/spike-pi-tui/logs");
let renders = 0;
const origDoRender = tui.doRender.bind(tui);
tui.doRender = () => {
	renders++;
	origDoRender();
};

// 布局：一个流式 Text + 一个光标探针（CURSOR_MARKER 跟在 CJK 前缀后）
const streamText = new Text("", 0, 0);
const CURSOR_PREFIX = "「审批」中文前缀abc"; // 2+2+2+2+2+2+2+1+1+1 = 17
const probe = {
	focused: true,
	render: () => [CURSOR_PREFIX + CURSOR_MARKER],
	invalidate: () => {},
};
tui.addChild(streamText);
tui.addChild(probe);

const LONG =
	"第一段：中文长文本在真实ConPTY下流经pi-tui的差分渲染器。每个字占两格，标点「」，。！同样占两格。" +
	"第二段：混合ASCII词汇agent、session、receipt，以及数字0123456789，看看词边界折行是否与终端一致。" +
	"第三段：连续宽标点压测。，！？；：「」『』（）《》——端到端不劈字、不漂移。";

let streamError = null;
try {
	tui.start();
	// 真实流式：60 个 chunk × 40ms，走 requestRender 节流通路
	const CHUNKS = 60;
	for (let k = 0; k < CHUNKS; k++) {
		const n = Math.ceil(LONG.length / CHUNKS);
		streamText.setText(LONG.slice(0, (k + 1) * n));
		tui.requestRender();
		await sleep(40);
	}
	while (tui.renderRequested) await sleep(20);
} catch (e) {
	streamError = e;
}
results.push(`C1 ${streamError ? `FAIL 流式渲染抛错: ${streamError.message}` : `PASS 60 chunk 流式完成, renders=${renders}, fullRedraw=${tui.fullRedrawCount}`}`);

// C2：渲染落定后，真实终端光标应停在探针标记处（行=内容末行，列=前缀宽）
await sleep(100);
const after = cursorPos();
const expectCol = refWidth(CURSOR_PREFIX); // 17
// pi-tui 硬件光标行是相对其渲染起点的；基线在启动前测得。TUI start 时光标所在行即其 buffer 行 0。
// 内容行数 = 流式文本折行数 + 1（探针行）。用 row 差校验：探针行 = 起始行 + newLines-1。
const lineCount = tui.previousLines.length;
const expectRow = baseline.row + lineCount - 1;
const c2ok = after.col === expectCol && after.row === expectRow && tui.hardwareCursorRow === lineCount - 1;
results.push(
	`C2 ${c2ok ? "PASS" : "FAIL"} 真实终端光标定位: CursorLeft=${after.col}(期望${expectCol}) CursorTop=${after.row}(期望${expectRow}) pi-tui hardwareCursorRow=${tui.hardwareCursorRow} 内容行数=${lineCount}`,
);

// C3：resize 尝试（mode con，实测不可靠；成功则校验全量重绘计数递增）
{
	const c0 = out.columns;
	const r0 = out.rows;
	const redraws0 = tui.fullRedrawCount;
	let resizeEvent = false;
	out.on("resize", () => {
		resizeEvent = true;
	});
	try {
		execFileSync("mode.com", ["con", `cols=${c0 - 30}`, `lines=${r0}`], { stdio: "inherit" });
	} catch (e) {
		results.push(`C3 INFO mode con 执行失败: ${e.message.split("\n")[0]}`);
	}
	for (let waited = 0; waited < 3000 && out.columns === c0; waited += 200) await sleep(200);
	const c1 = out.columns;
	if (c1 !== c0) {
		await sleep(200); // 让 requestRender 出帧
		results.push(
			`C3 ${tui.fullRedrawCount > redraws0 && resizeEvent ? "PASS" : "FAIL"} 真实 resize: ${c0}->${c1}, resize事件=${resizeEvent}, fullRedraw ${redraws0}->${tui.fullRedrawCount}`,
		);
		execFileSync("mode.com", ["con", `cols=${c0}`, `lines=${r0}`], { stdio: "inherit" });
		await sleep(300);
	} else {
		results.push(
			"C3 INFO 子进程 mode con 未能改变 ConPTY 尺寸（宿主 node-pty 持有尺寸权；重绘路径由 Part A A4 直测覆盖）",
		);
	}
}

// C4：干净停止
try {
	tui.stop({});
	results.push("C4 PASS tui.stop 干净返回");
} catch (e) {
	results.push(`C4 FAIL tui.stop 抛错: ${e.message}`);
}

out.write("\n===== PART C RESULTS =====\n");
console.log(results.join("\n"));
const fails = results.filter((r) => r.includes(" FAIL "));
console.log(`== PART C 汇总: ${fails.length} FAIL ==`);
process.exit(fails.length > 0 ? 1 : 0);
