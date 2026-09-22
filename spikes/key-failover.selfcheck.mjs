// key-failover.mjs 的脱网自检：用假的上游流验证切换、保持、退避、不切换与告警不含 key。
// 运行：node spikes/key-failover.selfcheck.mjs（spikes/ 不进门禁，改动后手工跑一遍）
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createKeyFailover, isQuotaError } from "./key-failover.mjs";

const KEY_A = "fake-key-AAAA-one";
const KEY_B = "fake-key-BBBB-two";

function fakeUpstream(behaviorByKey, log) {
	return (key, _context, _options) => {
		log.push(key);
		const stream = createAssistantMessageEventStream();
		const behavior = behaviorByKey[key]();
		queueMicrotask(() => {
			if (behavior.ok) {
				stream.push({ type: "start", partial: {} });
				stream.push({ type: "done", reason: "stop", message: { stopReason: "stop", content: [] } });
			} else {
				stream.push({
					type: "error",
					reason: "error",
					error: { stopReason: "error", errorMessage: behavior.message, content: [] },
				});
			}
			stream.end();
		});
		return stream;
	};
}

async function drain(stream) {
	const events = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function harness(behaviorByKey, keys = [KEY_A, KEY_B]) {
	const calls = [];
	const warnings = [];
	const sleeps = [];
	const failover = createKeyFailover({
		keys,
		call: fakeUpstream(behaviorByKey, calls),
		createStream: createAssistantMessageEventStream,
		warn: (line) => warnings.push(line),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		now: () => "T",
	});
	return { failover, calls, warnings, sleeps };
}

const quota = { ok: false, message: '429 {"error":{"type":"rate_limit_error","message":"quota exhausted"}}' };
const ok = { ok: true };

// 判别
assert.equal(isQuotaError(quota.message), true);
assert.equal(isQuotaError("当前账户额度已用完"), true);
assert.equal(isQuotaError('401 {"error":{"type":"authentication_error","message":"invalid api key"}}'), false);
assert.equal(isQuotaError('403 rate limit for this key is forbidden'), false);
assert.equal(isQuotaError('404 {"error":{"message":"model not found"}}'), false);
assert.equal(isQuotaError("400 context length exceeded"), false);
// 403 但响应体明说是用量上限（Kimi For Coding 的 5 小时窗口）：是限额，要切 key
assert.equal(
	isQuotaError(
		`403 {"error":{"type":"permission_error","message":"You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends."}}`
	),
	true
);
// 403 权限错误但与用量无关：仍是配置问题，不切
assert.equal(isQuotaError('403 {"error":{"type":"permission_error","message":"model not allowed"}}'), false);

// ① 主 key 撞限额：切到备用 key 重试同一次请求；之后的请求保持用备用 key，不来回试
{
	const h = harness({ [KEY_A]: () => quota, [KEY_B]: () => ok });
	const first = await drain(h.failover({}, {}));
	assert.deepEqual(first.map((event) => event.type), ["start", "done"]);
	const second = await drain(h.failover({}, {}));
	assert.deepEqual(second.map((event) => event.type), ["start", "done"]);
	assert.deepEqual(h.calls, [KEY_A, KEY_B, KEY_B]);
	assert.equal(h.warnings.length, 1);
	assert.match(h.warnings[0], /第 1 个 key撞限额，切换到第 2 个 key/);
	assert.deepEqual(h.sleeps, []);
}

// ② 认证失败不切换：错误原样交回，备用 key 没被碰，没有告警
{
	const auth = { ok: false, message: `401 authentication_error: invalid api key ${KEY_A}` };
	const h = harness({ [KEY_A]: () => auth, [KEY_B]: () => ok });
	const events = await drain(h.failover({}, {}));
	assert.deepEqual(events.map((event) => event.type), ["error"]);
	assert.deepEqual(h.calls, [KEY_A]);
	assert.deepEqual(h.warnings, []);
	// 交回的错误文本里 key 已被抹掉
	assert.equal(events[0].error.errorMessage.includes(KEY_A), false);
}

// ③ 两个都撞限额：退避 5、15、45 秒各一次，仍失败才交回错误；每轮两个 key 各试一次
{
	const h = harness({ [KEY_A]: () => quota, [KEY_B]: () => quota });
	const events = await drain(h.failover({}, {}));
	assert.deepEqual(events.map((event) => event.type), ["error"]);
	assert.deepEqual(h.sleeps, [5000, 15000, 45000]);
	assert.equal(h.calls.length, 8);
	assert.equal(h.warnings.filter((line) => /退避/.test(line) && /秒/.test(line)).length, 3);
	assert.match(h.warnings.at(-1), /放弃本次请求/);
}

// ④ 退避后恢复：第二轮成功
{
	let round = 0;
	const h = harness({ [KEY_A]: () => (round++ < 1 ? quota : ok), [KEY_B]: () => quota });
	const events = await drain(h.failover({}, {}));
	assert.deepEqual(events.map((event) => event.type), ["start", "done"]);
	assert.deepEqual(h.sleeps, [5000]);
}

// ⑤ 只有一个 key：启动与成功路径没有任何告警；撞限额时同样退避
{
	const h = harness({ [KEY_A]: () => ok }, [KEY_A]);
	await drain(h.failover({}, {}));
	assert.deepEqual(h.warnings, []);
	const limited = harness({ [KEY_A]: () => quota }, [KEY_A]);
	const events = await drain(limited.failover({}, {}));
	assert.deepEqual(events.map((event) => event.type), ["error"]);
	assert.deepEqual(limited.sleeps, [5000, 15000, 45000]);
}

// ⑥ 并行：五个请求同时撞限额，只告警一次切换
{
	const h = harness({ [KEY_A]: () => quota, [KEY_B]: () => ok });
	const all = await Promise.all(Array.from({ length: 5 }, () => drain(h.failover({}, {}))));
	assert.ok(all.every((events) => events.at(-1).type === "done"));
	assert.equal(h.warnings.length, 1);
}

// ⑦ 任何告警里都没有 key 或其片段
{
	const h = harness({ [KEY_A]: () => quota, [KEY_B]: () => quota });
	await drain(h.failover({}, {}));
	for (const line of h.warnings) {
		for (const fragment of [KEY_A, KEY_B, "AAAA", "BBBB", "fake-key"]) {
			assert.equal(line.includes(fragment), false, `告警含 key 片段：${line}`);
		}
	}
}

// ⑧ 并行请求共用同一段退避，但各按自己的中止信号退出：发起退避的请求中止，不连累一起等待的请求
{
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const counts = { [KEY_A]: 0, [KEY_B]: 0 };
	const calls = [];
	const sleeps = [];
	const failover = createKeyFailover({
		keys: [KEY_A, KEY_B],
		call: fakeUpstream(
			{
				[KEY_A]: () => (counts[KEY_A]++ < 2 ? quota : ok),
				[KEY_B]: () => (counts[KEY_B]++ < 2 ? quota : ok),
			},
			calls
		),
		createStream: createAssistantMessageEventStream,
		warn: () => {},
		// 与真实实现一样尊重传入的信号
		sleep: (ms, signal) =>
			new Promise((resolve, reject) => {
				sleeps.push(ms);
				gate.then(resolve);
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
		now: () => "T",
	});
	const first = new AbortController();
	const aborted = drain(failover({}, { signal: first.signal }));
	const waiting = drain(failover({}, {}));
	while (sleeps.length === 0) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	first.abort();
	const abortedEvents = await aborted;
	assert.equal(abortedEvents.at(-1).type, "error");
	assert.equal(abortedEvents.at(-1).reason, "aborted");
	release();
	const waitingEvents = await waiting;
	assert.deepEqual(
		waitingEvents.map((event) => event.type),
		["start", "done"],
		"一起等待的请求不应被别人的中止连累"
	);
	assert.equal(sleeps.length, 1, "并行请求共用一段退避");
}

// ⑨ 包装层自身出错：交回一个错误事件（带原因、不含 key），不能只结束流让调用方拿到空响应
{
	const warnings = [];
	const failover = createKeyFailover({
		keys: [KEY_A, KEY_B],
		call: () => {
			throw new Error(`上游构造失败 ${KEY_A}`);
		},
		createStream: createAssistantMessageEventStream,
		warn: (line) => warnings.push(line),
		sleep: async () => {},
		now: () => "T",
	});
	const events = await drain(failover({}, {}));
	assert.deepEqual(events.map((event) => event.type), ["error"]);
	assert.equal(events[0].error.stopReason, "error");
	assert.match(events[0].error.errorMessage, /包装层内部错误：上游构造失败/);
	assert.equal(events[0].error.errorMessage.includes(KEY_A), false);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].includes(KEY_A), false);
}

console.log("key-failover 自检通过");
