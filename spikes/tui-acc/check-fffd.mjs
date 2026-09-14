import { readFileSync } from "node:fs";
const s = readFileSync("tmp/tui-acc/a-stream.log", "utf8");
const needle = String.fromCharCode(0xfffd);
if (needle.length !== 1) {
  console.log("NEEDLE_BROKEN len=" + needle.length);
  process.exit(2);
}
let idx = -1;
let count = 0;
while ((idx = s.indexOf(needle, idx + 1)) !== -1) {
  count++;
  if (count <= 3) console.log(`hit @${idx}:`, JSON.stringify(s.slice(Math.max(0, idx - 50), idx + 50)));
}
console.log("total", count);
