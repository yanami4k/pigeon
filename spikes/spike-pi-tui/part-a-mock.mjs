// Spike part A: pi-tui 0.84.4 内部一致性 —— Mock Terminal + 虚拟屏幕仿真器。
// 仿真器按 get-east-asian-width 独立计算单元格推进（与 Part B 真实 ConPTY 测量互为两面：
// A 证明 pi-tui 宽度函数↔折行↔光标数学↔差分渲染自洽；B 证明该宽度函数与真实终端一致）。
// 运行：node tmp/spike-pi-tui/part-a-mock.mjs
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { eastAsianWidth } from "get-east-asian-width";
import { CURSOR_MARKER, Text, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

// ---------- 独立参考实现（不看 pi-tui 源码逻辑，只用同一个宽度表） ----------
function refGraphemeWidth(g) {
	return eastAsianWidth(g.codePointAt(0));
}
function refWidth(s) {
	let w = 0;
	for (const { segment } of graphemeSegmenter.segment(s)) w += refGraphemeWidth(segment);
	return w;
}
function refWrap(text, width) {
	const out = [];
	for (const inputLine of text.split("\n")) {
		let cur = "";
		let curW = 0;
		for (const { segment: g } of graphemeSegmenter.segment(inputLine)) {
			const w = refGraphemeWidth(g);
			if (curW + w > width && curW > 0) {
				out.push(cur);
				cur = "";
				curW = 0;
			}
			cur += g;
			curW += w;
		}
		out.push(cur);
	}
	return out;
}

// ---------- 虚拟屏幕：模拟一个 CJK 感知正确的终端 ----------
class VirtualScreen {
	constructor(width, height) {
		this.width = width;
		this.height = height;
		this.buf = []; // buf[row] = [cellString,...]；宽字符占两格，第二格为 ""（续格）
		this.row = 0;
		this.col = 0;
		this.top = 0; // 滚动偏移（buffer 行号 = 屏幕顶行）
		this.pending = false; // 行末待换行（DECAWM pending wrap）
	}
	ensureRow(r) {
		while (this.buf.length <= r) this.buf.push([]);
	}
	scrollIfNeeded() {
		while (this.row >= this.top + this.height) this.top++;
	}
	setCell(r, c, s) {
		this.ensureRow(r);
		this.buf[r][c] = s;
	}
	putGrapheme(g) {
		const w = refGraphemeWidth(g);
		if (w === 0) {
			// 组合符：并入前一格
			if (this.col > 0) {
				const prev = this.buf[this.row]?.[this.col - 1];
				if (typeof prev === "string") this.buf[this.row][this.col - 1] = prev + g;
			}
			return;
		}
		if (this.pending) {
			this.row++;
			this.col = 0;
			this.pending = false;
			this.scrollIfNeeded();
		}
		if (this.col + w > this.width) {
			// 宽字符放不下：末格补空，整体换到下一行（真实终端行为，绝不劈开字素）
			this.setCell(this.row, this.col, " ");
			this.row++;
			this.col = 0;
			this.scrollIfNeeded();
		}
		this.setCell(this.row, this.col, g);
		for (let i = 1; i < w; i++) this.setCell(this.row, this.col + i, "");
		this.col += w;
		if (this.col >= this.width) {
			this.col = this.width;
			this.pending = true;
		}
	}
	clearAll() {
		this.buf = [];
		this.row = 0;
		this.col = 0;
		this.top = 0;
		this.pending = false;
	}
	clearLine() {
		this.ensureRow(this.row);
		this.buf[this.row] = [];
	}
	clearToEol() {
		this.ensureRow(this.row);
		this.buf[this.row].length = this.col;
	}
	csi(params, final) {
		const n = params.length === 0 ? 1 : Number.parseInt(params.replace("?", ""), 10) || 1;
		const priv = params.startsWith("?");
		this.pending = false;
		switch (final) {
			case "A":
				// CUU：钳制在视口顶，不滚屏
				this.row = Math.max(this.top, this.row - n);
				break;
			case "B":
				// CUD：钳制在视口底，不滚屏（真实终端行为）
				this.row = Math.min(this.top + this.height - 1, this.row + n);
				break;
			case "C":
				this.col = Math.min(this.width, this.col + n);
				break;
			case "D":
				this.col = Math.max(0, this.col - n);
				break;
			case "G":
				this.col = Math.max(0, n - 1);
				break;
			case "H":
				this.row = 0;
				this.col = 0;
				break;
			case "J":
				if (params === "2") {
					// pi-tui 清屏路径总是 2J + H + 3J 连用：buffer 归零
					this.clearAll();
				}
				break;
			case "K":
				if (params === "2") this.clearLine();
				else this.clearToEol();
				break;
			default:
				// SGR(m)、私有模式(h/l)等忽略
				void priv;
		}
	}
	feed(data) {
		let i = 0;
		while (i < data.length) {
			const ch = data[i];
			if (ch === "\x1b") {
				const next = data[i + 1];
				if (next === "[") {
					let j = i + 2;
					while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j++;
					this.csi(data.slice(i + 2, j), data[j]);
					i = j + 1;
					continue;
				}
				if (next === "]" || next === "_") {
					// OSC / APC：吞到 BEL 或 ST
					let j = i + 2;
					while (j < data.length && data[j] !== "\x07" && !(data[j] === "\x1b" && data[j + 1] === "\\")) j++;
					i = data[j] === "\x07" ? j + 1 : j + 2;
					continue;
				}
				i += 2; // 其他双字符转义
				continue;
			}
			if (ch === "\r") {
				this.col = 0;
				this.pending = false;
				i++;
				continue;
			}
			if (ch === "\n") {
				this.row++;
				this.pending = false;
				this.scrollIfNeeded();
				i++;
				continue;
			}
			// 可见文本：按字素切
			let end = i;
			while (end < data.length && data[end] !== "\x1b" && data[end] !== "\r" && data[end] !== "\n") end++;
			for (const { segment } of graphemeSegmenter.segment(data.slice(i, end))) this.putGrapheme(segment);
			i = end;
		}
	}
	rowText(r) {
		return (this.buf[r] ?? []).join("").trimEnd();
	}
	// 全部非空 buffer 行（trim 后）
	contentLines() {
		let last = -1;
		for (let r = 0; r < this.buf.length; r++) if (this.rowText(r) !== "") last = r;
		const out = [];
		for (let r = 0; r <= last; r++) out.push(this.rowText(r));
		return out;
	}
}

class MockTerminal {
	constructor(width, height) {
		this._c = width;
		this._r = height;
		this.screen = new VirtualScreen(width, height);
		this.writes = 0;
		this.bytes = 0;
		this.onResize = undefined;
	}
	start(_onInput, onResize) {
		this.onResize = onResize;
	}
	stop() {}
	async drainInput() {}
	write(d) {
		this.writes++;
		this.bytes += d.length;
		this.screen.feed(d);
	}
	get columns() {
		return this._c;
	}
	get rows() {
		return this._r;
	}
	get kittyProtocolActive() {
		return false;
	}
	setSize(c, r) {
		this._c = c;
		this._r = r;
		this.screen.width = c;
		this.screen.height = r;
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {
		this.screen.clearAll();
	}
	setTitle() {}
	setProgress() {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, fn) {
	try {
		fn();
		results.push(`PASS ${name}`);
	} catch (err) {
		results.push(`FAIL ${name}: ${err.message}`);
	}
}

// ---------- 语料 ----------
const GATE_CORPUS = [
	"中文测试",
	"Hello, World!",
	"混合mixed文本123",
	"。，！「」『』、；：？",
	"ＡＢＣｱｲ",
	"🎉🎊中文",
	"终端渲染的正确性取决于宽度的共识。",
];
const INFO_CORPUS = ["é", "①②", "——", "·", "±", "─"];

// ---------- S-A1：宽度台账 ----------
for (const s of GATE_CORPUS) {
	check(`A1 宽度一致 ${JSON.stringify(s)}`, () => {
		assert.equal(visibleWidth(s), refWidth(s));
	});
}
for (const s of INFO_CORPUS) {
	const pi = visibleWidth(s);
	const ref = refWidth(s);
	results.push(`INFO 歧义/组合字符 ${JSON.stringify(s)}: pi-tui=${pi} 参考=${ref}${pi === ref ? "" : "（不一致，记录在案）"}`);
}

// ---------- 流式长文本夹具 ----------
// 注意：pi-tui 的折行是「词 token 贪心 + 超长 token 按字素断」（dist/utils.js wrapSingleLine），
// 不是纯字素贪心；因此对含 ASCII 词的语料，判据用不变量（行宽不越界 + 内容零丢失），
// 纯 Han 语料（每个字独立成 token）才与字素贪心参考逐行相等。
const LONG_TEXT =
	"终端渲染的正确性，取决于渲染器与终端对「字符宽度」的共识。中文字符在终端里占两格，" +
	"ASCII字符占一格；当一行剩余空间放不下一个宽字符时，终端会把它整体推到下一行，" +
	"而不是劈成两半。如果渲染库算错了宽度，差分渲染就会把光标挪到错误的位置，" +
	"屏幕上的文字会像被虫蛀过一样错位、重叠、残缺！这正是我们要在WindowsConPTY下验证的事情。" +
	"混合一些ASCII片段，例如agent、run、session、receipt、trace，" +
	"再混一些全角标点：。，！？；：「」『』（）《》——以及数字0123456789。" +
	"第二段：长文本流式输出时，每个chunk可能只有几个字符；渲染器必须在任何时刻都保持" +
	"自洽的中间状态，不能因为半个chunk到达就把上一行画错。";
// 纯 Han 语料（千字文节选）：每字独立 token，折行必须与字素贪心参考逐行一致
const HAN_TEXT = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光";

function assertStreamConsistent(label, idx, term, tui, acc, width) {
	const got = term.screen.contentLines();
	check(`${label} chunk#${idx} 行宽不越界`, () => {
		for (const line of got) assert.ok(refWidth(line) <= width, `行宽 ${refWidth(line)} > ${width}: ${JSON.stringify(line)}`);
	});
	check(`${label} chunk#${idx} 内容零丢失零重复`, () => {
		assert.equal(got.join(""), acc);
	});
	check(`${label} chunk#${idx} 光标行==pi-tui跟踪`, () => {
		assert.equal(term.screen.row, tui.hardwareCursorRow);
	});
	check(`${label} chunk#${idx} 视口顶==pi-tui跟踪`, () => {
		assert.equal(term.screen.top, tui.previousViewportTop);
	});
}

function streamScenario({ label, width, height, chunkSizes }) {
	const term = new MockTerminal(width, height);
	const tui = new TuiMainScreen(term, false, "tmp/spike-pi-tui/logs");
	const comp = new Text("", 0, 0);
	tui.addChild(comp);
	tui.start();
	let acc = "";
	let idx = 0;
	let i = 0;
	while (i < LONG_TEXT.length) {
		const n = chunkSizes[idx % chunkSizes.length];
		idx++;
		acc += LONG_TEXT.slice(i, i + n);
		i += n;
		comp.setText(acc);
		tui.renderNow();
		assertStreamConsistent(label, idx, term, tui, acc, width);
	}
	tui.stop({ preserveScreen: true });
	return { term, tui };
}

// 纯 Han 精确折行场景：渲染行必须与字素贪心参考逐行相等（宽字符绝不骑跨行界）
function hanExactScenario({ label, width, height }) {
	const term = new MockTerminal(width, height);
	const tui = new TuiMainScreen(term, false, "tmp/spike-pi-tui/logs");
	const comp = new Text("", 0, 0);
	tui.addChild(comp);
	tui.start();
	let acc = "";
	let idx = 0;
	for (let i = 0; i < HAN_TEXT.length; i += 3) {
		idx++;
		acc += HAN_TEXT.slice(i, i + 3);
		comp.setText(acc);
		tui.renderNow();
		check(`${label} chunk#${idx} 屏幕==字素贪心折行`, () => {
			assert.deepEqual(term.screen.contentLines(), refWrap(acc, width));
		});
		assertStreamConsistent(label, idx, term, tui, acc, width);
	}
	tui.stop({ preserveScreen: true });
}

// S-A2a：矮屏（滚动路径），奇数宽 81
streamScenario({ label: "A2a(81x12)", width: 81, height: 12, chunkSizes: [1, 2, 3, 5, 7] });
// S-A2b：高屏（无滚动），宽 60
streamScenario({ label: "A2b(60x50)", width: 60, height: 50, chunkSizes: [4, 1, 9] });
// S-A2c：极小宽度 21，压力测试宽字符边界
streamScenario({ label: "A2c(21x10)", width: 21, height: 10, chunkSizes: [3] });
// S-A2d：纯 Han 精确折行（奇数宽 21 与偶数宽 20）
hanExactScenario({ label: "A2d-han(21x10)", width: 21, height: 10 });
hanExactScenario({ label: "A2d-han(20x10)", width: 20, height: 10 });

// ---------- S-A3：光标定位（CURSOR_MARKER 数学） ----------
{
	const width = 60;
	const height = 20;
	const prefixes = ["中文测试abc", "「光标」测试！", "a", "中文🎉混合x"];
	for (const prefix of prefixes) {
		const term = new MockTerminal(width, height);
		const tui = new TuiMainScreen(term, false, "tmp/spike-pi-tui/logs");
		const probe = {
			focused: true,
			render: () => [prefix + CURSOR_MARKER],
			invalidate: () => {},
		};
		tui.addChild(probe);
		tui.start();
		tui.renderNow(); // start() 的 requestRender 是异步节流路径；断言前强制出帧
		const expectCol = refWidth(prefix);
		check(`A3 光标列 ${JSON.stringify(prefix)}`, () => {
			assert.equal(term.screen.col, expectCol);
			assert.equal(term.screen.row, 0);
			assert.equal(tui.hardwareCursorRow, 0);
			assert.equal(term.screen.rowText(0), prefix); // marker 被剥离，行内容无残留
		});
		tui.stop({ preserveScreen: true });
	}
}

// ---------- S-A4：resize 重绘（真实 onResize 回调路径） ----------
{
	const term = new MockTerminal(81, 30);
	const tui = new TuiMainScreen(term, false, "tmp/spike-pi-tui/logs");
	const comp = new Text("", 0, 0);
	tui.addChild(comp);
	tui.start();
	comp.setText(LONG_TEXT);
	tui.renderNow();
	const redraws0 = tui.fullRedrawCount;
	check("A4 初始渲染(81) 内容一致", () => {
		const got = term.screen.contentLines();
		assert.equal(got.join(""), LONG_TEXT);
		for (const line of got) assert.ok(refWidth(line) <= 81);
		assert.equal(term.screen.row, tui.hardwareCursorRow);
		assert.equal(term.screen.top, tui.previousViewportTop);
	});
	// 81 → 41（收窄，重折行）
	term.setSize(41, 30);
	term.onResize(); // 与 ProcessTerminal 的 'resize' 事件同一入口：requestRender()
	await sleep(80); // 等 16ms 节流计时器出帧
	check("A4 收窄后全量重绘计数+1", () => {
		assert.ok(tui.fullRedrawCount > redraws0);
	});
	check("A4 收窄后内容一致(41)", () => {
		const got = term.screen.contentLines();
		assert.equal(got.join(""), LONG_TEXT);
		for (const line of got) assert.ok(refWidth(line) <= 41, `行宽 ${refWidth(line)} > 41`);
		assert.equal(term.screen.row, tui.hardwareCursorRow);
		assert.equal(term.screen.top, tui.previousViewportTop);
	});
	// 41 → 120（放宽）
	const redraws1 = tui.fullRedrawCount;
	term.setSize(120, 30);
	term.onResize();
	await sleep(80);
	check("A4 放宽后全量重绘计数+1", () => {
		assert.ok(tui.fullRedrawCount > redraws1);
	});
	check("A4 放宽后内容一致(120)", () => {
		const got = term.screen.contentLines();
		assert.equal(got.join(""), LONG_TEXT);
		for (const line of got) assert.ok(refWidth(line) <= 120, `行宽 ${refWidth(line)} > 120`);
		assert.equal(term.screen.row, tui.hardwareCursorRow);
		assert.equal(term.screen.top, tui.previousViewportTop);
	});
	tui.stop({ preserveScreen: true });
}

// ---------- S-A5：流式刷新性能 ----------
{
	const width = 120;
	const height = 40;
	// A5a 单 Text 无界增长：量出 O(内容) 每帧成本的缩放曲线（真实 M2 不应这么用）
	const term = new MockTerminal(width, height);
	const tui = new TuiMainScreen(term, false, "tmp/spike-pi-tui/logs");
	const comp = new Text("", 0, 0);
	tui.addChild(comp);
	tui.start();
	const chunk = "流式输出性能压力测试abc。"; // 13 字 ≈ 23 格
	const CHUNKS = 2000;
	const frameMs = [];
	let acc = "";
	const t0 = performance.now();
	for (let k = 0; k < CHUNKS; k++) {
		acc += chunk;
		comp.setText(acc);
		const f0 = performance.now();
		tui.renderNow();
		frameMs.push(performance.now() - f0);
	}
	const wall = performance.now() - t0;
	frameMs.sort((a, b) => a - b);
	const mean = frameMs.reduce((a, b) => a + b, 0) / frameMs.length;
	const p95 = frameMs[Math.floor(frameMs.length * 0.95)];
	const max = frameMs[frameMs.length - 1];
	results.push(
		`PERF-A5a 单Text无界 x${CHUNKS}: wall=${wall.toFixed(0)}ms mean=${mean.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(2)}ms 内容=${refWidth(acc)}格`,
	);
	check("A5a 压测后屏幕内容正确", () => {
		const got = term.screen.contentLines();
		assert.equal(got.join(""), acc);
		for (const line of got) assert.ok(refWidth(line) <= width);
		assert.equal(term.screen.row, tui.hardwareCursorRow);
		assert.equal(term.screen.top, tui.previousViewportTop);
	});
	check("A5a 平均帧耗时 < 16ms（跟得上 60fps 节流）", () => {
		assert.ok(mean < 16, `mean=${mean.toFixed(3)}ms`);
	});
	// A5b 真实 M2 形状：每条消息一个 Text（缓存命中 O(1)），只有流式尾巴重折行
	const term3 = new MockTerminal(width, height);
	const tui3 = new TuiMainScreen(term3, false, "tmp/spike-pi-tui/logs");
	const tail = new Text("", 0, 0);
	tui3.addChild(tail);
	tui3.start();
	const MESSAGES = 200;
	const TAIL_CHUNKS = 100;
	const frameMs3 = [];
	for (let m = 0; m < MESSAGES; m++) {
		const msg = new Text(`第${m}条已完成的消息：渲染缓存应当命中。`, 0, 0);
		tui3.addChild(msg);
		tui3.children.splice(tui3.children.length - 2, 0, tui3.children.pop()); // tail 保持最后
		tui3.renderNow();
	}
	let acc3 = "";
	for (let k = 0; k < TAIL_CHUNKS; k++) {
		acc3 += chunk;
		tail.setText(acc3);
		const f0 = performance.now();
		tui3.renderNow();
		frameMs3.push(performance.now() - f0);
	}
	frameMs3.sort((a, b) => a - b);
	const mean3 = frameMs3.reduce((a, b) => a + b, 0) / frameMs3.length;
	const p953 = frameMs3[Math.floor(frameMs3.length * 0.95)];
	results.push(
		`PERF-A5b 每消息一Text(${MESSAGES}条+流式尾巴): mean=${mean3.toFixed(3)}ms p95=${p953.toFixed(3)}ms`,
	);
	check("A5b 分消息形状平均帧耗时 < 8ms", () => {
		assert.ok(mean3 < 8, `mean=${mean3.toFixed(3)}ms`);
	});
	check("A5b 分消息形状屏幕内容正确", () => {
		const got = term3.screen.contentLines();
		const expectMsgs = [];
		for (let m = 0; m < MESSAGES; m++) expectMsgs.push(`第${m}条已完成的消息：渲染缓存应当命中。`);
		assert.equal(got.join(""), expectMsgs.join("") + acc3);
		assert.equal(term3.screen.row, tui3.hardwareCursorRow);
	});
	// 节流通路：requestRender 合并突发 chunk
	const term2 = new MockTerminal(width, height);
	const tui2 = new TuiMainScreen(term2, false, "tmp/spike-pi-tui/logs");
	const comp2 = new Text("", 0, 0);
	tui2.addChild(comp2);
	tui2.start();
	let renders = 0;
	const orig = tui2.doRender.bind(tui2);
	tui2.doRender = () => {
		renders++;
		orig();
	};
	let acc2 = "";
	const t1 = performance.now();
	for (let k = 0; k < CHUNKS; k++) {
		acc2 += chunk;
		comp2.setText(acc2);
		tui2.requestRender();
	}
	while (tui2.renderRequested) await sleep(20);
	const wall2 = performance.now() - t1;
	results.push(`PERF 节流通路: ${CHUNKS} chunks 合并为 ${renders} 帧, wall=${wall2.toFixed(0)}ms`);
	check("A5 节流通路最终屏幕正确", () => {
		const got = term2.screen.contentLines();
		assert.equal(got.join(""), acc2);
		for (const line of got) assert.ok(refWidth(line) <= width);
		assert.equal(term2.screen.row, tui2.hardwareCursorRow);
	});
	tui.stop({ preserveScreen: true });
	tui2.stop({ preserveScreen: true });
}

console.log(results.join("\n"));
const fails = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n== PART A 汇总: ${results.filter((r) => r.startsWith("PASS")).length} PASS / ${fails.length} FAIL ==`);
if (fails.length > 0) process.exit(1);
