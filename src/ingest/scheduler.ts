/**
 * 拉取调度器：按各源自己的节奏轮询 provider，并把结果送进**同一条**摄入管道。
 *
 * 与 `webhook/index.ts` 里拓扑刷新同构（后台周期任务 + `unref` + 失败降级），
 * 但有一处**必须做对**的差异：拉取会**产生新的告警**，因此：
 *
 * 1. **单源失败绝不影响其它源与 webhook 主链路** —— 一个源 API 挂了只记一条 warn，
 *    其它源照常拉、webhook 照常收（容错红线，对齐 topology.ts 的退化哲学）。
 * 2. **同一 provider 不重叠执行** —— 上一轮还没结束就跳过本轮。否则源变慢时请求会
 *    堆积（每 intervalMs 叠一个未完成请求），最终把自己的 API 打爆 / 内存涨。
 * 3. **平台级限流仍由管道统一把守** —— 拉取出的告警与推送来的走同一个有界并发池，
 *    否则两路各自并发会让全局 LLM 限流失效。
 */
import type { Alert } from '../webhook/types.js'
import { DEFAULT_PULL_INTERVAL_MS, type SourceProvider } from './provider.js'

export type PullSchedulerOptions = {
  /** 全局默认拉取周期（毫秒）；provider 自带 `intervalMs` 时优先用它的 */
  intervalMs?: number
  /** 摄入回调（通常直接接 `IngestPipeline.ingest`，与 push 共用同一管道） */
  ingest: (alerts: Alert[]) => void
  log?: (level: 'log' | 'warn' | 'error', message: string) => void
}

/**
 * 启动拉取调度。返回 `stop()`：清除全部定时器并取消在途请求（优雅关停用）。
 *
 * 启动即**立即首拉一轮**（不等第一个周期）：否则进程重启后最长要等一个周期才
 * 发现"其实已经处于告警中"。
 */
export function startPullScheduler(
  providers: SourceProvider[],
  opts: PullSchedulerOptions,
): () => void {
  const log =
    opts.log ?? ((level: 'log' | 'warn' | 'error', message: string) => console[level](message))
  if (providers.length === 0) return () => {}

  const controller = new AbortController()
  /** 正在拉取的 provider 名（防同源重叠执行）。 */
  const inFlight = new Set<string>()
  const timers: Array<ReturnType<typeof setInterval>> = []

  const pollOnce = async (provider: SourceProvider): Promise<void> => {
    if (controller.signal.aborted) return
    if (inFlight.has(provider.name)) {
      log(
        'warn',
        `[ingest] 拉取源 ${provider.name} 上一轮尚未结束，跳过本轮（避免请求堆积）`,
      )
      return
    }
    inFlight.add(provider.name)
    try {
      const alerts = await provider.poll(controller.signal)
      // 空批次是常态（绝大多数轮询没有新告警）：不调用 ingest、不打日志，避免噪音。
      if (alerts.length > 0) {
        log('log', `[ingest] 拉取源 ${provider.name} 取得 ${alerts.length} 条告警`)
        opts.ingest(alerts)
      }
    } catch (error) {
      if (controller.signal.aborted) return
      const reason = error instanceof Error ? error.message : String(error)
      log('warn', `[ingest] 拉取源 ${provider.name} 失败，跳过本轮: ${reason}`)
    } finally {
      inFlight.delete(provider.name)
    }
  }

  for (const provider of providers) {
    const intervalMs = provider.intervalMs ?? opts.intervalMs ?? DEFAULT_PULL_INTERVAL_MS
    void pollOnce(provider)
    const timer = setInterval(() => {
      void pollOnce(provider)
    }, intervalMs)
    // 不阻止进程退出：拉取是增强能力，不能因为一个后台定时器让进程退不掉。
    timer.unref()
    timers.push(timer)
  }

  return () => {
    controller.abort()
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
  }
}
