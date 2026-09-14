import fs from "node:fs";
process.on("SIGINT", () => { fs.writeFileSync("tmp/tui-acc/sigint.txt", "SIGINT received"); process.exit(0); });
console.log("ready isTTY=" + process.stdout.isTTY);
setInterval(() => {}, 1000);
