// 假打包产物（测试夹具）的模型接入模块占位：真产物是自带 DeepSeek 接入的打包件；夹具的 pigeon.mjs 自己发请求，
// 不加载本模块，存在只为让产物目录的形状逼真（pigeon.mjs、pigeon-cli.mjs、deepseek-stream-fn.mjs 三件）
export default function fakeStreamFn() {
  throw new Error("夹具不使用本模块");
}
