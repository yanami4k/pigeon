// B5 单题诊断：mode con 改 ConPTY 尺寸的可靠性
import { execFileSync } from "node:child_process";
const out = process.stdout;
if (!out.isTTY) {
	console.log("NOT_TTY");
	process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out.on("resize", () => console.log(`[event] resize -> ${out.columns}x${out.rows}`));
console.log(`初始 ${out.columns}x${out.rows}`);
for (const [label, cmd, args, stdio] of [
	["pipe+cols145", "mode.com", ["con", "cols=145", "lines=40"], "pipe"],
	["inherit+cols150", "mode.com", ["con", "cols=150", "lines=40"], "inherit"],
]) {
	try {
		const r = execFileSync(cmd, args, { stdio, encoding: "utf8" });
		console.log(`${label} 执行输出: ${JSON.stringify(r ?? "")}`);
	} catch (e) {
		console.log(`${label} 执行失败: ${e.message.split("\n")[0]}`);
	}
	for (let i = 0; i < 15; i++) {
		await sleep(200);
		process.stdout.write(""); // 触发流刷新
		if (out.columns === Number(args[1].split("=")[1])) break;
	}
	console.log(`${label} 后列数: ${out.columns}x${out.rows}`);
}
console.log("恢复 120x40");
try {
	execFileSync("mode.com", ["con", "cols=120", "lines=40"], { stdio: "inherit" });
} catch {}
await sleep(500);
console.log(`最终 ${out.columns}x${out.rows}`);
process.exit(0);
