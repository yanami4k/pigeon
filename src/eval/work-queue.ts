// 跑批的工作队列：固定路数的若干路共用一个队列，哪一路空了就取下一项，不按批等待。取项前等待进行中的暂停，
// 停止后不再取新项（已在做的做完）。外部基准的逐题运行（runner.ts）与延续式的逐流作业（stream-runner.ts）共用这一份（096）。

export interface WorkQueueControl {
  // 进行中的暂停：取项前等它结束（结束后再查一次，可能又起了新的暂停）
  paused(): Promise<void> | undefined;
  // 停止取新项的原因；未停止为 undefined
  stopped(): string | undefined;
}

export async function runWorkQueue<J>(
  jobs: readonly J[],
  concurrency: number,
  body: (job: J) => Promise<void>,
  control?: WorkQueueControl
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      for (let pause = control?.paused(); pause !== undefined; pause = control?.paused()) {
        await pause;
      }
      if (control?.stopped() !== undefined) return;
      const job = jobs[next];
      next += 1;
      if (job === undefined) return;
      await body(job);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
}
