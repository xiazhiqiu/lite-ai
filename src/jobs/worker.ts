/**
 * Worker：把 pending job 拉起来执行（T4）。
 *
 * 结构对照 HolmesGPT 的 `ConversationWorker`，但并发护栏**复用本项目已有的
 * `BoundedPool`**（现为全局单例，见 `pool.ts`），不重写一套。
 *
 * 三条职责，各自独立定时器：
 * 1. **claim loop**（高频）：`claim()` 原子认领 → 交给池执行
 * 2. **stale sweep**（低频）：把死亡实例遗留的 running job 打回 pending
 * 3. **优雅关停**：停 claim → 等在途跑完（`drained()`）
 *
 * 本文件**不关心 job 里跑什么** —— 那是 `execute` 注入的事（T5 接 `runAgentTurn`）。
 * 这样 worker 的并发/故障转移语义可以在不碰 LLM 的前提下被完整测试。
 */
import { getGlobalPool, type BoundedPool } from './pool.js'
import type { JobStore } from './store.js'
import type { Job } from './types.js'

export type WorkerOptions = {
  store: JobStore
  /**
   * 本 worker 的标识，写入 `job.assignee`。
   * 多实例部署时每个实例应有不同值（如 `${hostname}-${pid}`），便于排查"谁在跑"。
   */
  assignee: string
  /**
   * 执行器：真正消费一个 job。抛错 → job 落 `failed` 并记录 error。
   * T5 会注入"调 runAgentTurn 并把事件写回 job_events"的实现。
   */
  execute: (job: Job) => Promise<void>
  /**
   * 并发池。缺省用**进程级全局单例**（plan G1）——
   * 与 `IngestPipeline` 共用，保证 provider 看到的并发不翻倍。
   */
  pool?: BoundedPool
  /** claim 轮询间隔，默认 500ms。 */
  pollMs?: number
  /**
   * 每次 claim 最多认领几条。默认取池的上限档位（这里给保守值 1）——
   * 一次认领过多会让"某个 worker 独吞整批"。真正的并发由池控制。
   */
  claimBatch?: number
  /**
   * 租期：`claimedAt < now - staleLeaseMs` 的 running job 视为所属实例已死。
   * 默认 5 分钟 —— 应**明显大于**一次正常调查的耗时（含 LLM 多轮）。
   * 设太短会把正在跑的 job 误判为死亡并重复执行（等于烧两次 token）。
   */
  staleLeaseMs?: number
  /** stale sweep 间隔，默认 60s。低频即可，回收不需要实时。 */
  staleSweepMs?: number
  /** 注入时钟（测试需要确定性时间）。 */
  now?: () => number
  /** 注入日志。 */
  log?: (level: 'log' | 'warn' | 'error', message: string) => void
}

export type Worker = {
  /** 启动 claim loop 与 stale sweep（幂等：重复调用不会起两个循环）。 */
  start(): void
  /**
   * 停止认领新 job（在途 job 继续跑）。
   * 之后用 `drained()` 等在途跑完。
   */
  stop(): void
  /** 等在途执行的 job 全部结束。 */
  drained(): Promise<void>
  /** 当前在跑 / 排队的数量（观测用）。 */
  stats(): { inflight: number; queued: number }
}

const DEFAULT_POLL_MS = 500
const DEFAULT_STALE_LEASE_MS = 300_000
const DEFAULT_STALE_SWEEP_MS = 60_000
const DEFAULT_CLAIM_BATCH = 1

export function createWorker(opts: WorkerOptions): Worker {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const staleLeaseMs = opts.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS
  const staleSweepMs = opts.staleSweepMs ?? DEFAULT_STALE_SWEEP_MS
  const claimBatch = opts.claimBatch ?? DEFAULT_CLAIM_BATCH
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((level, message) => console[level](message))

  // 延迟到首次访问才建池：这样 worker 只做"读 store"的测试不会因建池而留下句柄。
  let poolRef: BoundedPool | null = opts.pool ?? null
  const pool = (): BoundedPool => {
    if (poolRef === null) {
      // 与 IngestPipeline 共用全局池。上限取 config 的 maxConcurrentDiagnoses
      // 由调用方（装配层）保证一致；此处缺省给保守值。
      poolRef = getGlobalPool(5, message => log('error', `[worker] 任务失败: ${message}`))
    }
    return poolRef
  }

  let claimTimer: ReturnType<typeof setInterval> | null = null
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  let running = false
  /** 是否正在 claim（防上一轮未跑完就叠加下一轮）。 */
  let claiming = false

  /** 认领并派发一批 job。 */
  async function claimOnce(): Promise<void> {
    if (claiming) return
    claiming = true
    try {
      const jobs = await opts.store.claim(
        { assignee: opts.assignee, limit: claimBatch },
        now(),
      )
      for (const job of jobs) {
        log('log', `[worker] 认领 ${job.id} (kind=${job.kind})`)
        // 交给池：并发上限由池统一裁决，worker 不做自己的限流。
        pool().enqueue(async () => {
          try {
            await opts.execute(job)
            // 终态写入：仅当仍处 running 才生效（防"job 已被 stale sweep 回收
          // 给别的实例"时错误地覆盖别人的执行结果）
            const ok = await opts.store.finish(job.id, 'completed', { now: now() })
            if (!ok) {
              log(
                'warn',
                `[worker] ${job.id} 完成写入被拒（可能已被回收重派），忽略本次结果`,
              )
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            log('error', `[worker] ${job.id} 执行失败: ${reason}`)
            await opts.store.finish(job.id, 'failed', { error: reason, now: now() })
          }
        })
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log('error', `[worker] claim 失败: ${reason}`)
    } finally {
      claiming = false
    }
  }

  /** 回收死亡实例遗留的 running job。 */
  async function sweepOnce(): Promise<void> {
    try {
      const reclaimed = await opts.store.reassignStale(staleLeaseMs, now())
      if (reclaimed.length > 0) {
        log(
          'warn',
          `[worker] 回收 ${reclaimed.length} 个超租期 job（原实例可能已崩）: ${reclaimed
            .map(j => j.id)
            .join(', ')}`,
        )
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log('error', `[worker] stale sweep 失败: ${reason}`)
    }
  }

  return {
    start(): void {
      if (running) return
      running = true

      // 先立刻跑一轮，不等第一个间隔（否则启动后有 pollMs 的空窗）
      void claimOnce()

      claimTimer = setInterval(() => {
        void claimOnce()
      }, pollMs)
      // 不阻止进程退出：worker 是后台服务，但进程该退时不该被它拖住
      claimTimer.unref?.()

      sweepTimer = setInterval(() => {
        void sweepOnce()
      }, staleSweepMs)
      sweepTimer.unref?.()

      log('log', `[worker] 已启动 assignee=${opts.assignee} poll=${pollMs}ms`)
    },

    stop(): void {
      running = false
      if (claimTimer !== null) {
        clearInterval(claimTimer)
        claimTimer = null
      }
      if (sweepTimer !== null) {
        clearInterval(sweepTimer)
        sweepTimer = null
      }
      log('log', `[worker] 已停止认领 assignee=${opts.assignee}`)
    },

    drained(): Promise<void> {
      // 未建池说明从未认领过任何 job，直接完成
      if (poolRef === null) return Promise.resolve()
      return poolRef.drained()
    },

    stats(): { inflight: number; queued: number } {
      if (poolRef === null) return { inflight: 0, queued: 0 }
      return { inflight: poolRef.inflight, queued: poolRef.queued }
    },
  }
}

export { DEFAULT_POLL_MS, DEFAULT_STALE_LEASE_MS, DEFAULT_STALE_SWEEP_MS }
