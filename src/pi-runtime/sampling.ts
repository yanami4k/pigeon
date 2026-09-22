// 采样温度固定（M9）：包装 streamFn，把温度写进每次调用的选项。评测要可比，同一道题在不同条件下的差异不应来自
// 采样随机性；缺省不设（由 provider 决定），设了就冻结进注入快照并随 run.started 落盘，事后可证每次运行用的温度。
// 上游只在未请求推理时把温度交给 provider（推理与温度在该线路上互斥）；请求了推理的运行里这个值不生效。
import type { StreamFn } from "@earendil-works/pi-agent-core";

export function fixTemperature(streamFn: StreamFn, temperature: number): StreamFn {
  return (model, context, options) => streamFn(model, context, { ...options, temperature });
}
