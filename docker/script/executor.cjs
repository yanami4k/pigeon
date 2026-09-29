// 编排脚本的执行器（决策 310）：在专用容器里以 node -e 运行（容器不挂任何目录、不联网、限内存与进程数），只经标准输入输出
// 与宿主上的编排器通信——每行一个 JSON。宿主 → 执行器：start（脚本正文与 args）、result（某次积木调用的结果）；
// 执行器 → 宿主：call（agent 调用）、phase、log、done（脚本的返回值）、error（脚本抛错）。
// 脚本在 node:vm 的独立上下文里跑：上下文里没有 require、import、process、文件与网络接口，禁止由字符串生成代码；
// Date.now、new Date()、Math.random 调用即报错，Intl 删去（格式化当前时间也是读时间）。宿主函数只经一层闭包交给上下文里的
// 积木，积木只把字符串交给宿主、从宿主收回字符串，宿主的对象不进上下文。
"use strict";

const vm = require("node:vm");

// 同步部分（开跑到第一个 await）的时限
const SYNC_TIMEOUT_MS = 10_000;

function out(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// 读上下文里的错误：只取文字，读不出即给一句
function describe(error) {
  try {
    if (error !== null && typeof error === "object" && typeof error.message === "string") {
      return `${typeof error.name === "string" ? `${error.name}: ` : ""}${error.message}`;
    }
    return String(error);
  } catch {
    return "脚本抛出了无法读取的错误";
  }
}

// 在上下文里先跑：收掉读时间与取随机数的入口，冻结 Math 与 Date
const HARDEN = `(() => {
  "use strict";
  const deny = (what) => function () { throw new Error("编排脚本里不能" + what); };
  const RealDate = Date;
  RealDate.now = deny("读时间（Date.now）");
  const SafeDate = function Date(...values) {
    if (new.target === undefined || values.length === 0) {
      throw new Error("编排脚本里不能读时间（new Date() 与 Date()）");
    }
    return Reflect.construct(RealDate, values, new.target);
  };
  SafeDate.now = RealDate.now;
  SafeDate.parse = RealDate.parse;
  SafeDate.UTC = RealDate.UTC;
  SafeDate.prototype = RealDate.prototype;
  Object.defineProperty(RealDate.prototype, "constructor", { value: SafeDate });
  Object.defineProperty(globalThis, "Date", { value: SafeDate, writable: false, configurable: false });
  Math.random = deny("取随机数（Math.random）");
  delete globalThis.Intl;
  if (typeof globalThis.Temporal !== "undefined") delete globalThis.Temporal;
  Object.freeze(Math);
  Object.freeze(SafeDate);
  Object.freeze(RealDate);
})();`;

// 积木：宿主只拿到 bridge(op, 文字, 回调)。agent 经 bridge 发出、在上下文里建 Promise 等宿主回话
const BLOCKS = `(function (bridge, argsText) {
  "use strict";
  let currentPhase;
  const call = (op, payload) =>
    new Promise((resolve) => {
      bridge(op, JSON.stringify(payload === undefined ? null : payload), (text) => resolve(JSON.parse(text)));
    });
  const failure = (error) => ({
    ok: false,
    status: "failed",
    errorKind: "script-error",
    error: error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : String(error),
  });
  const isFailure = (value) => value !== null && typeof value === "object" && value.ok === false;
  const settle = (task) => {
    try {
      return Promise.resolve(typeof task === "function" ? task() : task).catch(failure);
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  };
  const agent = (task, options) => {
    if (typeof task !== "string" || task.trim() === "") {
      return Promise.resolve(failure(new Error("agent 的第一个参数须为非空的任务文字")));
    }
    const opts = options !== null && typeof options === "object" ? options : {};
    const relay = opts.relay;
    const payload = {
      task,
      label: typeof opts.label === "string" ? opts.label : undefined,
      phase: typeof opts.phase === "string" ? opts.phase : currentPhase,
      role: typeof opts.role === "string" ? opts.role : undefined,
      schema: opts.schema,
      relay:
        relay === undefined || relay === null
          ? undefined
          : typeof relay === "object"
            ? String(relay.ref)
            : String(relay),
    };
    return call("agent", payload);
  };
  const parallel = (tasks) => Promise.all(Array.from(tasks, (task) => settle(task)));
  const pipeline = (items, ...stages) => {
    const steps = stages.flat();
    return Promise.all(
      Array.from(items, async (item, index) => {
        let value = item;
        for (const step of steps) {
          value = await settle(() => step(value, item, index));
          if (isFailure(value)) break;
        }
        return value;
      })
    );
  };
  const phase = (title) => {
    currentPhase = String(title);
    bridge("phase", JSON.stringify(currentPhase));
  };
  const log = (...parts) => {
    bridge("log", JSON.stringify(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ")));
  };
  const args = JSON.parse(argsText);
  return { agent, parallel, pipeline, phase, log, args };
})`;

// 回话：call 编号 → 上下文里的回调
const waiting = new Map();
let nextId = 1;
let started = false;

function start(message) {
  if (started) return;
  started = true;
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(HARDEN, context);
  const bridge = (op, text, callback) => {
    try {
      if (op === "agent") {
        const id = nextId;
        nextId += 1;
        waiting.set(id, callback);
        out({ t: "call", id, op, payload: JSON.parse(String(text)) });
      } else if (op === "phase" || op === "log") {
        out({ t: op, text: String(JSON.parse(String(text))) });
      }
    } catch (error) {
      out({ t: "error", message: `积木调用失败：${describe(error)}` });
    }
  };
  const blocks = vm.runInContext(BLOCKS, context)(bridge, JSON.stringify(message.args ?? null));
  for (const name of ["agent", "parallel", "pipeline", "phase", "log", "args"]) {
    Object.defineProperty(context, name, {
      value: blocks[name],
      writable: false,
      configurable: false,
    });
  }
  let running;
  try {
    const script = new vm.Script(`(async () => {\n${String(message.source)}\n})()`, {
      filename: "script.js",
      lineOffset: -1,
    });
    running = script.runInContext(context, { timeout: SYNC_TIMEOUT_MS });
  } catch (error) {
    out({ t: "error", message: describe(error) });
    return;
  }
  Promise.resolve(running).then(
    (value) => {
      let copy = null;
      try {
        copy = value === undefined ? null : JSON.parse(JSON.stringify(value));
      } catch (error) {
        out({ t: "error", message: `脚本的返回值不能转成 JSON：${describe(error)}` });
        return;
      }
      out({ t: "done", value: copy });
    },
    (error) => out({ t: "error", message: describe(error) })
  );
}

function onMessage(message) {
  if (message.t === "start") {
    start(message);
    return;
  }
  if (message.t === "result") {
    const callback = waiting.get(message.id);
    waiting.delete(message.id);
    if (callback !== undefined) callback(JSON.stringify(message.value ?? null));
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === "") continue;
    try {
      onMessage(JSON.parse(line));
    } catch (error) {
      out({ t: "error", message: `读不懂宿主的消息：${describe(error)}` });
    }
  }
});
// 宿主断开即退出
process.stdin.on("end", () => process.exit(0));
