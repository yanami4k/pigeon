// Spike part B: 真实 Windows ConPTY 测量。
// 该 ConPTY 不应答 DSR CPR（\x1b[6n 无响应，已实测），改用同控制台 PowerShell 子进程
// 读 [Console]::CursorLeft/CursorTop（底层 GetConsoleScreenBufferInfo，控制台缓冲区的真值），
// 与 get-east-asian-width 预测逐条对拍。
// 必须在 PTY 下运行；无 TTY 直接退出码 2。
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { eastAsianWidth } from "get-east-asian-width";

const out = process.stdout;
const results = [];

if (!out.isTTY) {
	console.log("NOT_TTY: 需要 PTY 运行");
	process.exit(2);
}

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
function refWidth(s) {
	let w = 0;
	for (const { segment } of graphemeSegmenter.segment(s)) w += eastAsianWidth(segment.codePointAt(0));
	return w;
}

const PROBE_FILE = "tmp/spike-pi-tui/cursor-probe.txt";
// 同控制台 powershell 查询光标（stdout 继承 ConPTY，结果写文件避免管道重定向毁掉 [Console]）
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

results.push(`ENV platform=${process.platform} columns=${out.columns} rows=${out.rows} isTTY=${out.isTTY}`);
try {
	const chcp = execFileSync("cmd.exe", ["/c", "chcp"], { encoding: "utf8" }).trim();
	results.push(`ENV 活动代码页: ${chcp.replace(/\D+/g, "")}`);
} catch (e) {
	results.push(`ENV chcp 获取失败: ${e.message}`);
}
// 自校准：powershell 子进程本身不应移动光标
{
	const a = cursorPos();
	const b = cursorPos();
	results.push(`B0 ${a.col === b.col && a.row === b.row ? "PASS" : "FAIL"} 探针自校准（查询不移动光标）: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

function probeWidth(name, s) {
	out.write("\n"); // 新起一行，列归零
	const before = cursorPos();
	out.write(s);
	const after = cursorPos();
	const measured = after.col - before.col;
	const predicted = refWidth(s);
	const ok = measured === predicted && after.row === before.row;
	results.push(
		`B1 ${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(s)}: 实测推进=${measured} 预测=${predicted} 行推进=${after.row - before.row}`,
	);
	return { measured, predicted, ok };
}

probeWidth("ASCII", "Hello, World!");
probeWidth("汉字x4", "中文测试");
probeWidth("宽标点", "。，！「」『』、；：？");
probeWidth("全角ASCII", "ＡＢＣ１２３");
probeWidth("半角片假名", "ｱｲｳ");
probeWidth("混合", "混合mixed文本123。");
probeWidth("emoji", "🎉🎊");
// 歧义宽字符（A 类）：单独记录，不进通过条件
const amb = [];
amb.push(["歧义-破折号U+2014", "——"]);
amb.push(["歧义-间隔号U+00B7", "··"]);
amb.push(["歧义-圈数字U+2460", "①②"]);
amb.push(["歧义-制表U+2500", "──"]);
amb.push(["歧义-加减U+00B1", "±±"]);
for (const [name, s] of amb) {
	out.write("\n");
	const before = cursorPos();
	out.write(s);
	const after = cursorPos();
	const measured = after.col - before.col;
	const predicted = refWidth(s);
	results.push(
		`B4 INFO ${name} ${JSON.stringify(s)}: ConPTY实测=${measured} get-east-asian-width预测=${predicted}${measured === predicted ? "（一致）" : "（分歧！）"}`,
	);
}

// B2：CJK 后光标后退（CSI n D）逐格精确
{
	out.write("\n");
	const base = cursorPos();
	out.write("中文测试abc"); // 宽 11
	const p0 = cursorPos();
	out.write("\x1b[3D");
	const p1 = cursorPos();
	out.write("\x1b[8D");
	const p2 = cursorPos();
	const ok =
		p0.col - base.col === 11 && p1.col === p0.col - 3 && p2.col === p0.col - 11 && p0.row === p1.row && p1.row === p2.row;
	results.push(`B2 ${ok ? "PASS" : "FAIL"} CJK后光标后退: 推进=${p0.col - base.col}(期望11) p1=${p1.col} p2=${p2.col}`);
}

// B3：自动换行边界对拍（宽字符骑跨行尾时必须整体换行）
{
	const cols = out.columns;
	out.write("\n");
	const base = cursorPos();
	const hanCount = Math.floor(cols / 2);
	const fill = "汉".repeat(hanCount) + (cols % 2 === 1 ? "x" : ""); // 恰好 cols 格
	out.write(fill);
	const full = cursorPos();
	out.write("汉"); // 触发换行：这个汉字必须整体落到下一行 1-2 格
	const wrapped = cursorPos();
	const wOk = full.row === base.row && wrapped.row === base.row + 1 && wrapped.col === 2;
	results.push(
		`B3 ${wOk ? "PASS" : "FAIL"} 行尾宽字符整体换行: cols=${cols} 满行后=${JSON.stringify(full)} 再写一汉字后=${JSON.stringify(wrapped)}（期望行+1、列2）`,
	);
	// 非精确倍数：2*cols+1 格 → 行+2、列1
	out.write("\n");
	const base2 = cursorPos();
	out.write("汉".repeat(cols) + "y");
	const over = cursorPos();
	const oOk = over.row === base2.row + 2 && over.col === 1;
	results.push(`B3 ${oOk ? "PASS" : "FAIL"} 超长串换行对拍: 预测行+2列1, 实测=${JSON.stringify(over)} 基线=${JSON.stringify(base2)}`);
}

// B5：mode con 真实改 ConPTY 尺寸 + stdout 'resize' 事件（已实测可用）
{
	const c0 = out.columns;
	const r0 = out.rows;
	let resized = false;
	out.on("resize", () => {
		resized = true;
	});
	let modeErr = "";
	try {
		execFileSync("mode.com", ["con", `cols=${c0 + 20}`, `lines=${r0}`], { stdio: "pipe" });
	} catch (e) {
		modeErr = e.message;
	}
	// resize 事件/列数刷新是异步的：轮询最多 3s
	let c1 = out.columns;
	for (let waited = 0; waited < 3000 && c1 === c0; waited += 200) {
		await sleep(200);
		c1 = out.columns;
	}
	results.push(
		`B5 INFO mode con resize 尝试: ${c0}x${r0} -> ${c1}x${out.rows} resize事件=${resized}${modeErr ? ` mode错误=${modeErr.split("\n")[0]}` : ""}（不进通过条件：ConPTY 尺寸由宿主 node-pty 持有，子进程 mode con 不可靠——4 次实测仅首次生效；重绘路径由 Part A A4 直测覆盖）`,
	);
	if (c1 !== c0) {
		try {
			execFileSync("mode.com", ["con", `cols=${c0}`, `lines=${r0}`], { stdio: "pipe" });
			await sleep(300);
			results.push(`B5 已恢复尺寸: ${out.columns}x${out.rows}`);
		} catch {}
	}
}

out.write("\n");
console.log("===== PART B RESULTS =====");
console.log(results.join("\n"));
const fails = results.filter((r) => r.includes(" FAIL "));
console.log(`== PART B 汇总: ${fails.length} FAIL ==`);
process.exit(fails.length > 0 ? 1 : 0);
