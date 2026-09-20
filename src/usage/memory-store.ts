/**
 * `UsageStore` 的内存实现（T7）。
 *
 * 用途有两条，**都不是"给生产用的降级"**：
 * 1. **单测**：不需要 PG 就能验证语义；
 * 2. **CLI / 单进程形态**：与 `memory-store.ts`（job）同一套理由 —— 没有 PG 时
 *    服务仍要能跑起来。
 *
 * ⚠️ **诚实边界**：内存实现**重启即丢**。审计账本按定义要求持久化，
 * 所以生产**必须**用 PG 实现。这一点在装配层（`server/index.ts`）需要显式告知
 * 部署方 —— 不能让人以为"跑起来了=审计合规了"。
 */
import type {
  ListUsageFilter,
  UsageEvent,
  UsageRecord,
  UsageStore,
  UsageSummary,
} from './store.js'

/** 单次查询的默认条数与硬上限（与 `GET /jobs` 同口径，防大 limit 拉垮服务端）。 */
export const USAGE_LIMIT_DEFAULT = 100
export const USAGE_LIMIT_MAX = 500

/** 把用户传入的 limit 夹到合法区间（非法值回退默认，不报错）。 */
export function clampUsageLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return USAGE_LIMIT_DEFAULT
  return Math.min(Math.floor(raw), USAGE_LIMIT_MAX)
}

function summarize(rows: UsageEvent[]): UsageSummary {
  let completed = 0
  let failed = 0
  let inputTokens = 0
  let outputTokens = 0
  const durations: number[] = []

  for (const row of rows) {
    if (row.status === 'completed') completed += 1
    else if (row.status === 'failed') failed += 1
    inputTokens += row.inputTokens
    outputTokens += row.outputTokens
    if (row.durationMs !== null) durations.push(row.durationMs)
  }

  return {
    total: rows.length,
    completed,
    failed,
    inputTokens,
    outputTokens,
    avgDurationMs:
      durations.length === 0
        ? null
        : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
  }
}

export function createMemoryUsageStore(): UsageStore {
  const rows: UsageRecord[] = []
  let nextId = 1

  return {
    async record(event: UsageEvent, now: number = Date.now()): Promise<UsageRecord> {
      const row: UsageRecord = { ...event, id: nextId++, createdAt: now }
      rows.push(row)
      return row
    },

    async list(filter: ListUsageFilter): Promise<UsageRecord[]> {
      const limit = clampUsageLimit(filter.limit)
      // 新 → 旧（审计查看习惯：先看最近发生的）
      return rows
        .filter(
          r =>
            r.userId === filter.userId &&
            (filter.jobId === undefined || r.jobId === filter.jobId),
        )
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
    },

    async summarize(userId: string): Promise<UsageSummary> {
      // 全量口径（不受 list 的 limit 影响）—— 见 store.ts 的说明
      return summarize(rows.filter(r => r.userId === userId))
    },
  }
}
