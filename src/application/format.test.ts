// 决策 036：终端边界净化 sanitizeTerminalText 的行为合同——半信任内容（模型流式文本、
// 工具参数、diff 预览里的工作区文件内容）携带的终端控制序列一律可见化（ESC → ␛，
// C0 → 控制图形），绝不静默丢弃、绝不原样直通（M2 审计 P2-1：OSC 52 剪贴板劫持 /
// OSC 8 伪装链接 / CSI 光标与擦除可伪造审批屏）。保留 \n \t；不做 SGR 白名单。
import assert from "node:assert/strict";
import { test } from "vitest";
import { sanitizeTerminalText } from "./format.ts";

// ESC 引导字节惰性化后，序列其余可打印字节保留在屏上作审计痕迹
test("CSI 序列（光标定位 / SGR 颜色 / 清屏）失去 ESC，内容可见化为 ␛ + 原文", () => {
  for (const raw of ["\x1b[77G", "\x1b[1;31m", "\x1b[2J", "\x1b[9K", "\x1b[H"]) {
    const cleaned = sanitizeTerminalText(raw);
    assert.equal(cleaned, `␛${raw.slice(1)}`, JSON.stringify(raw));
    assert.ok(!cleaned.includes("\x1b"), "原始 ESC 字节必须消失");
  }
});

test("OSC 52 剪贴板与 OSC 8 超链接：BEL/ST 终止符一并可见化，序列惰性", () => {
  const osc52 = sanitizeTerminalText("前缀\x1b]52;c;aGk=\x07后缀");
  assert.equal(osc52, "前缀␛]52;c;aGk=␇后缀");
  assert.ok(!osc52.includes("\x1b") && !osc52.includes("\x07"));

  const osc8 = sanitizeTerminalText("\x1b]8;;https://evil.example\x1b\\点击我\x1b]8;;\x07");
  assert.ok(osc8.startsWith("␛]8;;https://evil.example␛\\"), osc8);
  assert.ok(!osc8.includes("\x1b") && !osc8.includes("\x07"));
});

test("DCS/APC/PM/SOS 与双字符 ESC 序列同样惰性化", () => {
  const apc = sanitizeTerminalText("\x1b_payload\x1b\\");
  assert.equal(apc, "␛_payload␛\\");
  const dcs = sanitizeTerminalText("\x1bPq#0\x1b\\");
  assert.equal(dcs, "␛Pq#0␛\\");
  const twoChar = sanitizeTerminalText("\x1bc\x1bM");
  assert.equal(twoChar, "␛c␛M");
});

test("裸 ESC、DEL 与其余 C0 控制符替换为控制图形；\\r 如实呈现为 ␍", () => {
  assert.equal(sanitizeTerminalText("a\x1bb"), "a␛b");
  assert.equal(sanitizeTerminalText("a\x7fb"), "a␡b");
  assert.equal(sanitizeTerminalText("\x00\x0b\x1f"), "␀␋␟");
  // \r → ␍（U+240D）：CRLF 差异在 diff 预览中如实可见，不回车吞字
  assert.equal(sanitizeTerminalText("一\r\n二"), "一␍\n二");
});

test("\\n 与 \\t 保留；纯文本逐字不动", () => {
  const plain = "第一行\n第二行\t缩进 ␛ 已是标记";
  assert.equal(sanitizeTerminalText(plain), plain);
});

test("幂等：净化两次结果相同（流式累积 setText 每帧重净化为前提）", () => {
  const nasty = "a\x1b[2Jb\x1b]52;c;aGk=\x07c\x00d\re\nf\tg␛h";
  const once = sanitizeTerminalText(nasty);
  assert.equal(sanitizeTerminalText(once), once);
  assert.ok(!once.includes("\x1b"), "净化后不得残留任何 ESC");
});
