// 校准抽题（决策 202、219）：与 Python 的 random.Random(seed).sample(population, k) 逐位一致的实现——梅森旋转
// MT19937 按 Python 的整数播种（init_by_array，种子按 32 位小端切块），_randbelow 取 getrandbits 拒绝采样，sample 按
// CPython 的两种分支（候选池小于集合开销时用池子交换，否则用已选集合重抽）。跑批器与事后的分析脚本据同一种子得同一份题单
import { chainedTasks, type StreamManifest, type StreamStep } from "./stream-manifest.ts";

const N = 624;
const M = 397;

class MersenneTwister {
  private readonly mt = new Uint32Array(N);
  private index = N + 1;

  constructor(seed: bigint) {
    this.initByArray(keyOf(seed));
  }

  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = this.mt[i - 1] as number;
      this.mt[i] = (Math.imul(1812433253, (prev ^ (prev >>> 30)) >>> 0) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(key: readonly number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1] as number;
      mt[i] =
        (((mt[i] as number) ^ Math.imul((prev ^ (prev >>> 30)) >>> 0, 1664525)) +
          (key[j] as number) +
          j) >>>
        0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1] as number;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] as number;
      mt[i] = (((mt[i] as number) ^ Math.imul((prev ^ (prev >>> 30)) >>> 0, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1] as number;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private twist(): void {
    const mt = this.mt;
    for (let kk = 0; kk < N; kk++) {
      const y = ((mt[kk] as number) & 0x80000000) | ((mt[(kk + 1) % N] as number) & 0x7fffffff);
      mt[kk] = ((mt[(kk + M) % N] as number) ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
    }
    this.index = 0;
  }

  uint32(): number {
    if (this.index >= N) this.twist();
    let y = this.mt[this.index++] as number;
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

// Python 以整数播种：取绝对值，按 32 位从低到高切成若干块（0 也有一块）
function keyOf(seed: bigint): number[] {
  let a = seed < 0n ? -seed : seed;
  const key: number[] = [];
  do {
    key.push(Number(a & 0xffffffffn));
    a >>= 32n;
  } while (a > 0n);
  return key;
}

export class PythonRandom {
  private readonly mt: MersenneTwister;

  constructor(seed: number | bigint) {
    this.mt = new MersenneTwister(BigInt(seed));
  }

  // getrandbits(k)，只支持 1 到 32 位（抽题够用）
  getrandbits(k: number): number {
    if (!Number.isInteger(k) || k < 1 || k > 32)
      throw new Error(`getrandbits 只支持 1 到 32 位：${k}`);
    return this.mt.uint32() >>> (32 - k);
  }

  // _randbelow_with_getrandbits：取 n 的位数个随机位，大于等于 n 即重抽
  randbelow(n: number): number {
    const k = n.toString(2).length;
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  // random.sample(population, k)：不放回抽 k 个，保持 CPython 的抽取次序
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (!Number.isInteger(k) || k < 0 || k > n) throw new Error(`样本数 ${k} 超出总体 ${n}`);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    const result: T[] = [];
    if (n <= setsize) {
      const pool = [...population];
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result.push(pool[j] as T);
        pool[j] = pool[n - i - 1] as T;
      }
      return result;
    }
    const selected = new Set<number>();
    for (let i = 0; i < k; i++) {
      let j = this.randbelow(n);
      while (selected.has(j)) j = this.randbelow(n);
      selected.add(j);
      result.push(population[j] as T);
    }
    return result;
  }
}

// 校准题单的缺省种子（202、219；分析计划写定）
export const CALIBRATION_SEED = 20260927;

export const SAMPLE_POPULATION = "tasks with non-empty fail-to-pass, numbered in time order from 1";

// 校准选题（202、219）：清单里的题按时间接成的流中，只在要做到的用例不为零的题里，按 Python 的
// random.Random(seed).sample 抽 k 道（总体为这些题的题号、按时间顺序），再按时间排序
export function sampleTasks(
  manifest: StreamManifest,
  failToPassCount: (step: StreamStep) => number,
  k: number,
  seed = CALIBRATION_SEED
): { method: "sample"; seed: number; k: number; population: string; tasks: number[] } {
  const population = chainedTasks(manifest)
    .map((step, i) => ({ n: i + 1, step }))
    .filter((x) => failToPassCount(x.step) > 0)
    .map((x) => x.n);
  const tasks = new PythonRandom(seed).sample(population, k).sort((a, b) => a - b);
  return { method: "sample", seed, k, population: SAMPLE_POPULATION, tasks };
}
