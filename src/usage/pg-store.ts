/**
 * `UsageStore` 的 PG 实现（T7）。
 *
 * 与 `memory-store.ts` **语义等价**：同一套过滤/排序/聚合口径，同一组 limit 夹取规则
 * （共用 `clampUsageLimit`，不是各写一份）。
 *
 * ## 与内存实现的一处**刻意差异**（不是 bug）
 *
 * `summarize` 在内存版是"取全部行再在 JS 里累加"，在 PG 版是**一条聚合 SQL**。
 * 这不是为了性能好看 —— 是因为内存版的"全量"物理上就是全量（都在一个数组里），
 * 而 PG 版若图省事写成"先 SELECT 明细再 reduce"，就**隐含了一个未声明的上限**
 * （忘了加 LIMIT 会拉爆内存；加了 LIMIT 则汇总口径被截断）。
 * 让数据库做 `COUNT/SUM/AVG` 是唯一能让"全量口径"这两个字成立的写法。
 *
 * ⚠️ 两处 **NULL 语义必须对齐**（否则同一份数据在两种存储下汇总不同）：
 * - `avgDurationMs`：**无有效样本时返回 null**（不是 0）。内存版靠 `durations.length === 0`
 *   判断；PG 的 `AVG()` 本身在有全 NULL 输入时返回 NULL，正好对应。
 * - `durationMs` 为 null 的行**不参与平均**（SQL 的 AVG 天然忽略 NULL）。
 *
 * ## 关于 `status` 的计数口径
 *
 * 只精确匹配 `'completed'` / `'failed'`，其余（null、'running'、将来新增的状态）
 * 都**不计入** completed/failed，但仍然计入 `total` 与 token 累加。
 * 内存版是同一套 if/else if，所以两版一致。
 */
import type pg from 'pg'
import {
  clampUsageLimit,
  type ListUsageFilter,
  type UsageEvent,
  type UsageRecord,
  type UsageStore,
  type UsageSummary,
} from './index.js'

/** usage_events 表的行形态（snake_case → camelCase 在这里收口）。 */
type UsageRow = {
  id: number | string
  user_id: string
  job_id: string | null
  session_id: string | null
  trace_id: string | null
  model: string | null
  input_tokens: number | string
  output_tokens: number | string
  duration_ms: number | string | null
  status: string | null
  created_at: number | string
}

/** BIGINT / INTEGER 经 pg 驱动可能返回字符串，统一转 number。 */
function toNumber(value: string | number | null): number | null {
  if (value === null) return null
  return typeof value === 'number' ? value : Number(value)
}

function toRecord(row: UsageRow): UsageRecord {
  return {
    id: toNumber(row.id) ?? 0,
    userId: row.user_id,
    jobId: row.job_id,
    sessionId: row.session_id,
    traceId: row.trace_id,
    model: row.model,
    inputTokens: toNumber(row.input_tokens) ?? 0,
    outputTokens: toNumber(row.output_tokens) ?? 0,
    durationMs: toNumber(row.duration_ms),
    status: row.status,
    createdAt: toNumber(row.created_at) ?? 0,
  }
}

export function createPgUsageStore(pool: pg.Pool): UsageStore {
  return {
    async record(event: UsageEvent, at?: number): Promise<UsageRecord> {
      // created_at 用调用方给的时间（否则取库时钟 NOW() 的毫秒）。
      // 与 jobs 表不同：usage_events 没有 claim/stale 判定，不需要与库时钟强一致，
      // 所以允许调用方注入时间戳（测试友好）。
      const ts = at ?? Date.now()
      const { rows } = await pool.query<UsageRow>(
        `INSERT INTO usage_events
           (user_id, job_id, session_id, trace_id, model,
            input_tokens, output_tokens, duration_ms, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          event.userId,
          event.jobId,
          event.sessionId,
          event.traceId,
          event.model,
          event.inputTokens,
          event.outputTokens,
          event.durationMs,
          event.status,
          ts,
        ],
      )
      return toRecord(rows[0]!)
    },

    async list(filter: ListUsageFilter): Promise<UsageRecord[]> {
      const params: unknown[] = [filter.userId]
      const where: string[] = ['user_id = $1']
      if (filter.jobId !== undefined) {
        params.push(filter.jobId)
        where.push(`job_id = $${params.length}`)
      }
      params.push(clampUsageLimit(filter.limit))
      const { rows } = await pool.query<UsageRow>(
        `SELECT * FROM usage_events
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC, id DESC
          LIMIT $${params.length}`,
        params,
      )
      return rows.map(toRecord)
    },

    async summarize(userId: string): Promise<UsageSummary> {
      // 一条聚合语句完成全量口径。注意 COUNT(*) 与 SUM 的**空集行为不同**：
      // COUNT(*) 空集返回 0，SUM 空集返回 NULL —— 所以 SUM 必须 COALESCE 成 0。
      // 而 AVG(duration_ms) 空集（或全 NULL）返回 NULL，这正是我们要的语义
      // （无有效样本 → null，而非 0），**不要**也套 COALESCE。
      const { rows } = await pool.query<{
        total: string | number
        completed: string | number
        failed: string | number
        input_tokens: string | number | null
        output_tokens: string | number | null
        avg_duration_ms: string | number | null
      }>(
        `SELECT
           COUNT(*)                                                        AS total,
           COUNT(*) FILTER (WHERE status = 'completed')                     AS completed,
           COUNT(*) FILTER (WHERE status = 'failed')                        AS failed,
           COALESCE(SUM(input_tokens), 0)                                   AS input_tokens,
           COALESCE(SUM(output_tokens), 0)                                  AS output_tokens,
           AVG(duration_ms)                                                 AS avg_duration_ms
         FROM usage_events
         WHERE user_id = $1`,
        [userId],
      )
      const row = rows[0]!
      const avg = toNumber(row.avg_duration_ms)
      return {
        total: toNumber(row.total) ?? 0,
        completed: toNumber(row.completed) ?? 0,
        failed: toNumber(row.failed) ?? 0,
        inputTokens: toNumber(row.input_tokens) ?? 0,
        outputTokens: toNumber(row.output_tokens) ?? 0,
        // 与内存实现同口径：AVG 是小数，四舍五入取整（内存版也是 Math.round）
        avgDurationMs: avg === null ? null : Math.round(avg),
      }
    },
  }
}
