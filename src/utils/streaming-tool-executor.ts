import type { ToolCall } from '../types.js'
import { toolConcurrencyLimit } from './tool-parallel.js'

/**
 * env 开关：流式调度（工具调用边到达边执行，对齐 Claude Code 形态）。
 * 默认开启；置 LITE_AI_STREAMING=0 回到「整轮收集后静态分批」（partitionToolCalls 路径）。
 * LITE_AI_TOOL_CONCURRENCY=0（全串行总闸）优先级更高，同时关闭流式调度。
 */
export function isToolStreamingEnabled(): boolean {
  return process.env.LITE_AI_STREAMING !== '0'
}

export type StreamingToolExecutorOptions = {
  /**
   * 判定该调用是否可与其它 safe 调用并行。
   * 缺省 / 返回非 true / 抛异常 → 一律按 unsafe 处理（fail-closed）。
   */
  isSafe?: (call: ToolCall) => boolean
  /** 同时在飞上限，缺省取 toolConcurrencyLimit()。最小为 1。 */
  limit?: number
}

type ExecutorEntry<T> = {
  call: ToolCall
  index: number
  run: () => Promise<T>
  started: boolean
  resolve: (value: T) => void
  reject: (error: unknown) => void
  promise: Promise<T>
}

/**
 * 流式工具执行器：工具调用边到达边调度（对齐 Claude Code StreamingToolExecutor 的准入模型）。
 *
 * 准入规则（canStart）：
 * - 在跑为空 → 起跑；
 * - 本调用 unsafe → 排队（直到在跑清空后独占起跑）；
 * - 本调用 safe 且在跑的全部 safe → 起跑（可越过队列中排在前面的 unsafe 调用）；
 * - 在跑数已达 limit → 排队。
 *
 * 与静态贪心分批（partitionToolCalls）的差异：分批以 unsafe 调用为屏障切批，
 * 动态准入允许 barrier 之后的 safe 调用与 barrier 之前的 safe 批并行 —— 并发度更高，
 * 安全性等价（unsafe 起跑前提仍是在跑清空，写-写永不并发）。
 *
 * 结果按发射序交付（all() 返回顺序 = register 顺序，与完成时间无关）。
 *
 * 契约：run() 不得 reject（ToolRegistry.execute 保证返回 {ok,output} 不抛）。
 * 防御：run 同步抛出会被转成 rejection，并令所有未起跑调用以同一错误拒绝，
 * 避免孤儿 promise 悬空。
 */
export class StreamingToolExecutor<T> {
  private readonly isSafeFn?: (call: ToolCall) => boolean
  private readonly limit: number
  private readonly entries: ExecutorEntry<T>[] = []
  private readonly executing = new Set<ExecutorEntry<T>>()
  private readonly registeredIds = new Set<string>()
  private settled = false

  constructor(options: StreamingToolExecutorOptions = {}) {
    this.isSafeFn = options.isSafe
    const raw = options.limit ?? toolConcurrencyLimit()
    this.limit = Math.max(1, Math.floor(raw) || 1)
  }

  /** 已注册的调用数（含未起跑）。 */
  get size(): number {
    return this.entries.length
  }

  /**
   * 注册一个调用并尝试立即起跑。
   * 幂等：同 id 重复注册忽略（流式回调已注册、next() 返回后兜底再注册的场景）。
   */
  register(call: ToolCall, run: () => Promise<T>): void {
    if (this.settled) return
    if (typeof call.id === 'string' && call.id.length > 0) {
      if (this.registeredIds.has(call.id)) return
      this.registeredIds.add(call.id)
    }

    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    const entry: ExecutorEntry<T> = {
      call,
      index: this.entries.length,
      run,
      started: false,
      resolve,
      reject,
      promise,
    }
    this.entries.push(entry)
    this.pump()
  }

  /** 按发射序等待全部完成；首个失败立刻 reject（对齐 Promise.all 语义）。 */
  async all(): Promise<T[]> {
    return Promise.all(this.entries.map(entry => entry.promise))
  }

  private pump(): void {
    if (this.settled) return
    for (const entry of this.entries) {
      if (entry.started) continue
      if (this.executing.size >= this.limit) return
      if (!this.canStart(entry)) continue
      this.start(entry)
    }
  }

  private canStart(entry: ExecutorEntry<T>): boolean {
    if (this.executing.size === 0) return true
    if (!this.safeOf(entry.call)) return false
    for (const running of this.executing) {
      if (!this.safeOf(running.call)) return false
    }
    return true
  }

  private safeOf(call: ToolCall): boolean {
    if (!this.isSafeFn) return false
    try {
      return this.isSafeFn(call) === true
    } catch {
      return false
    }
  }

  private start(entry: ExecutorEntry<T>): void {
    entry.started = true
    this.executing.add(entry)
    // Promise.resolve().then 兜住 run 的同步抛出，统一走 rejection 路径
    Promise.resolve()
      .then(() => entry.run())
      .then(
        value => {
          this.executing.delete(entry)
          entry.resolve(value)
          this.pump()
        },
        error => {
          this.executing.delete(entry)
          this.failAll(error)
        },
      )
  }

  /** 失败传播：所有未起跑调用以同一错误拒绝，避免孤儿 promise 悬空。 */
  private failAll(error: unknown): void {
    if (this.settled) return
    this.settled = true
    for (const entry of this.entries) {
      if (!entry.started) entry.reject(error)
    }
  }
}
