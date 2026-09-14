// 剧本 A 佐证（屏幕模型口径）：VirtualScreen 快照行宽 ≤ 100 且无 U+FFFD
import { readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";

for (const label of ["start", "mid", "final", "exit"]) {
  const s = readFileSync(`tmp/tui-acc/a-stream.screen.${label}.txt`, "utf8");
  const lines = s.split("\n").filter((l) => l.trimEnd() !== "");
  const over = lines.filter((l) => visibleWidth(l) > 100);
  console.log(JSON.stringify({
    label,
    rows: lines.length,
    overWidth: over.length,
    fffd: s.includes(String.fromCharCode(0xfffd)),
    cjkRows: lines.filter((l) => /[一-鿿]{6,}/.test(l)).length,
  }));
}
