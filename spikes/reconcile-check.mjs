// 冷启动对账验收脚本（tmp/ 不入库）：对每个工作区账本新开 JsonlLedger 进程级冷读，打印 reconcile 分类。
import { JsonlLedger } from "../src/persistence/ledger.ts";

for (const ws of ["ws-approve", "ws-reject", "ws-yolo"]) {
	const ledger = new JsonlLedger(`tmp/${ws}/.pigeon/ledger.jsonl`);
	const report = ledger.reconcile();
	console.log(`== ${ws} ==`);
	console.log(`settled: ${report.settled.length}`);
	for (const e of report.settled) {
		console.log(`  ${e.intent.toolName} ${e.intent.executionId} approvedBy=${e.intent.decision.approvedBy} executed=${e.receipt?.executed}`);
	}
	console.log(`rejected: ${report.rejected.length}`);
	for (const e of report.rejected) {
		console.log(`  ${e.decision.toolName} ${e.decision.executionId} reason=${JSON.stringify(e.decision.decision.reason)} executed=${e.receipt?.executed}`);
	}
	console.log(`unknown(OutcomeUnknown): ${report.unknown.length}`);
	for (const e of report.unknown) {
		console.log(`  ${e.intent.toolName} ${e.intent.executionId}`);
	}
	console.log(`orphanReceipts: ${report.orphanReceipts.length}`);
}
