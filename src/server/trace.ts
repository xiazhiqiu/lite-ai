/**
 * 链路追踪（T7）—— **零依赖、零 schema 改动**。
 *
 * ## 设计决策：traceId 从 jobId **确定性派生**，不新增列
 *
 * `usage_events` 表有 `trace_id` 列，但 `jobs` 表**没有**。要"贯穿 HTTP → Worker →
 * `runAgentTurn`"，有两条路：
 *
 * | 方案 | 代价 |
 * |---|---|
 * | A. `jobs` 加 `trace_id` 列 | 改 schema + 内存/PG 双实现 + 所有 job 读写路径 + 迁移 |
 * | B. 从 jobId 确定性派生 | **零改动**，且天然一致 |
 *
 * 选 B。理由不只是省事——更因为**一个 job 就是一次独立调查**，本来就该是
 * 一条独立 trace（trace 的语义是"一次端到端请求"）。让同 session 的多轮 job
 * 共享一条 trace 反而把不同请求混在一起，是错的抽象。
 *
 * ## 为什么是"派生"而不是"随机生成后存起来"
 *
 * 派生（纯函数 `traceIdForJob(jobId)`）的关键优势：**任何拿到 jobId 的地方都能
 * 算出同一个 traceId**，不需要把它从 HTTP 层传到 Worker 层再到 exec 层。
 * 若改成"生成后存起来"，就又要那个 schema 列了。
 *
 * ## 格式
 *
 * `tr-<jobId>` —— 带前缀便于在日志里一眼识别（`grep 'tr-'`）。
 * jobId 本身已含随机 UUID（`jobs/memory-store.ts` 的 `job-<uuid>`），
 * 所以派生值不损失任何唯一性。
 */

/** traceId 前缀（日志里便于 `grep`）。 */
export const TRACE_PREFIX = 'tr-'

/**
 * 从 jobId 派生 traceId。
 *
 * **纯函数**：同输入必同输出，可在 HTTP/Worker/exec/审计查询任一处独立调用，
 * 无需传参。这也是选"派生"而非"存列"的根本原因。
 */
export function traceIdForJob(jobId: string): string {
  return `${TRACE_PREFIX}${jobId}`
}

/** 从 traceId 反解 jobId（审计回查用）。非本模块生成的输入返回 null。 */
export function jobIdFromTrace(traceId: string): string | null {
  if (!traceId.startsWith(TRACE_PREFIX)) return null
  const jobId = traceId.slice(TRACE_PREFIX.length)
  return jobId.length > 0 ? jobId : null
}

/**
 * 结构化日志行（job 生命周期）。
 *
 * **为什么用 JSON 行（JSONL）而不是人类可读字符串**：银行的审计要求是
 * "机器可查" —— 谁在什么时候查了什么。JSONL 可以直接被日志采集器（Filebeat /
 * Fluent Bit）解析成结构化字段，而 `console.log('job done')` 只能靠正则硬抠。
 *
 * 字段刻意对齐 `usage_events` 表，便于"日志与库对账"。
 */
export type JobLifecycleEvent =
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'reassigned'
  | 'enqueued'

export type JobLifecycleLog = {
  ts: number
  level: 'info' | 'warn' | 'error'
  event: JobLifecycleEvent
  traceId: string
  jobId: string
  userId?: string
  kind?: string
  assignee?: string | null
  durationMs?: number
  error?: string
}

/**
 * 把生命周期日志序列化成**单行 JSON**。
 *
 * 为什么自己不实现、要暴露成可测函数：`JSON.stringify` 遇到 `Error` 对象或
 * 循环引用会抛错，而**日志绝不能因为序列化失败而中断主流程**。这里显式降级。
 */
export function formatLifecycleLog(entry: JobLifecycleLog): string {
  try {
    return JSON.stringify({ logger: 'lite-ai', ...entry })
  } catch {
    // 兜底：宁可退化成非结构化行，也不能让日志把 job 搞崩
    return JSON.stringify({
      logger: 'lite-ai',
      ts: entry.ts,
      level: 'error',
      event: entry.event,
      traceId: entry.traceId,
      jobId: entry.jobId,
      error: '(log serialization failed)',
    })
  }
}

/**
 * 结构化日志发射器。
 *
 * 默认**开启**（审计要求可追溯），但可通过 `LITE_AI_STRUCTURED_LOG=0` 关掉
 * —— 单测里不希望 stdout 被日志淹没。
 *
 * 输出走 `console.log` 而非自建文件写入：进程的 stdout 归部署方管（容器日志、
 * systemd journal、重定向到文件），我们**不越界替运维决定日志去哪**。
 */
export function structuredLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LITE_AI_STRUCTURED_LOG !== '0'
}

export type LifecycleLogger = (entry: Omit<JobLifecycleLog, 'ts'>) => void

/** 创建生命周期日志器（缺省写 stdout；测试可注入 sink 捕获）。 */
export function createLifecycleLogger(opts: {
  enabled?: boolean
  sink?: (line: string) => void
} = {}): LifecycleLogger {
  const enabled = opts.enabled ?? structuredLogEnabled()
  const sink = opts.sink ?? ((line: string): void => console.log(line))
  return entry => {
    if (!enabled) return
    sink(formatLifecycleLog({ ts: Date.now(), ...entry }))
  }
}
