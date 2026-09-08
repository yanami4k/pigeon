// tsconfig 目标 ES2023 的 lib 尚无 Promise.withResolvers 类型声明；
// 运行时（package.json engines: node >=22.19）已支持，此处补齐类型。
export {};

interface PigeonPromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): PigeonPromiseWithResolvers<T>;
  }
}
