/**
 * 全局有界并发池（T4，plan G1）。
 *
 * **这个文件存在的唯一理由：全局只能有一个池。**
 *
 * 抽取前，池是 `IngestPipeline` 的私有字段（`pipeline.ts:180`）。服务化后如果
 * Worker 再 new 一个池，就会出现**两个池各自限流**：告警说"我最多并发 K1"、
 * Worker 说"我最多并发 K2"，但 LLM provider 看到的是 K1+K2 —— 全局配额被放大一倍。
 * 而这恰恰是选异步队列要防的事（打爆 provider RPM/TPM）。
 *
 * 所以池必须**单例**：`IngestPipeline` 与 Worker 从 `getGlobalPool()` 拿同一个实例，
 * 上限是**进程级的**，不是"每条链路一个"。
 *
 * 行为与 `pipeline.ts:83-133` 的原实现逐行一致（保持既有测试零改动）：
 * - 不同任务并行、入队顺序近似 FIFO
 * - 超过上限的任务排队等待
 * - 单个任务抛错不影响其他任务（转给 `onError`）
 * - `drained()` 等池排空
 */
export class BoundedPool {
  private active = 0
  private readonly pending: Array<() => Promise<void>> = []
  private resolveDrained: (() => void) | null = null

  constructor(
    private readonly limit: number,
    private readonly onError: (message: string) => void,
  ) {}

  enqueue(task: () => Promise<void>): void {
    this.pending.push(task)
    this.drain()
  }

  /** 等待池排空（优雅关停用）。 */
  drained(): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.active === 0 && this.pending.length === 0) {
        resolve()
        return
      }
      this.resolveDrained = resolve
    })
  }

  /** 当前在跑的任务数（测试 / 观测用）。 */
  get inflight(): number {
    return this.active
  }

  /** 当前排队等待的任务数（测试 / 观测用）。 */
  get queued(): number {
    return this.pending.length
  }

  private drain(): void {
    while (this.active < this.limit && this.pending.length > 0) {
      const task = this.pending.shift()!
      this.active += 1
      void task()
        .catch(error => {
          this.onError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => {
          this.active -= 1
          this.drain()
          this.notifyIfIdle()
        })
    }
    this.notifyIfIdle()
  }

  private notifyIfIdle(): void {
    if (this.active === 0 && this.pending.length === 0 && this.resolveDrained) {
      const resolve = this.resolveDrained
      this.resolveDrained = null
      resolve()
    }
  }
}

let globalPool: BoundedPool | null = null
let globalPoolLimit: number | null = null

/**
 * 取进程级唯一池。
 *
 * @param limit 并发上限。**首次调用时确定**（进程级上限，plan G1）。
 *   后续调用若传入**不同**的值：**复用已建池并 warn**，不抛错也不重建。
 *   理由是模块级单例的常见现实——同一进程里先后构造两个管道（测试、或
 *   配置热变更）时，第一个调用者的上限代表"这个进程的配额"，不该被后来的覆盖，
 *   更不该让进程崩掉。若真需要换上限，用 `resetGlobalPool()`（测试/重启）。
 * @param onError 任务抛错回调（仅首次调用生效）
 */
export function getGlobalPool(
  limit: number,
  onError: (message: string) => void = message => console.error(message),
): BoundedPool {
  if (globalPool === null) {
    globalPool = new BoundedPool(limit, onError)
    globalPoolLimit = limit
    return globalPool
  }
  if (globalPoolLimit !== limit) {
    // 不是错误，但值得可见：说明有第二个调用方带着不同的上限进来了。
    // 生产里这通常是配置不一致；测试里是两个 pipeline 各自设值。
    console.warn(
      `[pool] 全局池已以 limit=${globalPoolLimit} 建立，忽略传入的 limit=${limit}。` +
        '进程级只有一个池（plan G1）——这是为了让 provider 看到的并发不翻倍。',
    )
  }
  return globalPool
}

/** 是否已初始化（测试 / 装配判断用）。 */
export function hasGlobalPool(): boolean {
  return globalPool !== null
}

/** 重置全局池（**仅测试**用；生产进程不该调用）。 */
export function resetGlobalPool(): void {
  globalPool = null
  globalPoolLimit = null
}
