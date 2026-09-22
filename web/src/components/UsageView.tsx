import { useEffect, useState } from 'react'
import { ApiError, getUsage, UnauthorizedError } from '../api/client.js'
import type { UsageSnapshot, WireUsageEvent } from '../api/types.js'
import { formatDuration, formatTime } from '../format.js'

/**
 * 审计用量页（T10 建页 → T7 接真实数据源）。
 *
 * ## 数据来源：`GET /usage`（`usage_events` 账本）
 *
 * T10 初版是"从 job 列表派生的近似视图"（模型/token 列标"待 T7"）。
 * T7 落地后换成真正的审计账本 —— 每一行是执行期**实测**的一条用量事实，
 * 不是从 job 时间戳推出来的近似值。
 *
 * ## 两条口径必须说清
 *
 * 1. **顶部统计卡来自 `summary`（服务端全量聚合），不是本页明细的累加**。
 *    明细受 `limit` 截断，若前端自行累加，则"总调查数"会随分页变化 ——
 *    审计数字就有了两个口径。服务端 `summarize()` 与 `list()` 是分开的两次查询，
 *    正是为了让汇总永远是全量。见 `src/usage/store.ts` 的模块注释。
 *
 * 2. **token 列是执行链的实测值**（T-obs 尾差修复后）。`jobs/exec.ts` 的
 *    `emitLlmCall` 把每次 `onLlmCall` 的 usage **累加**成整轮总量，收尾时交给
 *    `recordUsage`；只有 provider 真返回数字才累加，缺字段保持 0（不编造）。
 *    所以列里出现 0 的含义是「provider 未返回该字段」或「本次调用确实无消耗」，
 *    **不再是"未采集"** —— 这句话此前是反的，已随采集接通更正。
 *
 * ## 404 的处理
 *
 * 服务端未接线 `usage` 时返回 404（而不是 200 空数组 —— 见 `ServerAppOptions.usage`）。
 * 这里把它渲染成一条明确的提示，而不是静默显示空表。
 */
export function UsageView({
  onOpenJob,
  onUnauthorized,
}: {
  onOpenJob: (jobId: string) => void
  onUnauthorized?: () => void
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const data = await getUsage({ limit: 200 })
        if (cancelled) return
        setSnapshot(data)
        setMissing(false)
        setError(null)
      } catch (err) {
        if (cancelled) return
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.()
          return
        }
        // 404 = 服务端没挂用量账本。与"加载失败"区分开：这不是故障，
        // 是部署形态问题，提示应指向"要怎么开"而不是"重试"。
        if (err instanceof ApiError && err.status === 404) {
          setMissing(true)
          setError(null)
          return
        }
        setError(err instanceof Error ? err.message : '加载失败')
      }
    }
    void load()
    const timer = setInterval(() => void load(), 8000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [onUnauthorized])

  const summary = snapshot?.summary ?? null
  const events = snapshot?.events ?? []

  return (
    <div className="page">
      <div className="page-head">
        <h2>审计与用量</h2>
        <span className="spacer" />
        <span className="faint">仅显示当前账户（服务端按身份过滤）</span>
      </div>

      {error !== null ? <div className="callout error">{error}</div> : null}

      {missing ? (
        <div className="callout info">
          服务端<strong>未接线用量账本</strong>（<code>GET /usage</code> 返回 404）。
          装配层需传入 <code style={{ fontFamily: 'var(--mono)' }}>usage</code>
          （有 Postgres 时自动用 <code>usage_events</code> 表）。
        </div>
      ) : null}

      <div className="callout info">
        token 列为执行链<strong>实测值</strong>（累加每次模型调用的 usage）。
        显示 <strong>0</strong> 表示 provider 未返回该字段，或本次调用确实无消耗。
      </div>

      <div className="filters" style={{ marginTop: 14 }}>
        <StatCard label="总记录数" value={summary === null ? '—' : String(summary.total)} />
        <StatCard
          label="已完成"
          value={summary === null ? '—' : String(summary.completed)}
        />
        <StatCard label="失败" value={summary === null ? '—' : String(summary.failed)} />
        <StatCard
          label="输入 token"
          value={summary === null ? '—' : formatTokens(summary.inputTokens)}
        />
        <StatCard
          label="输出 token"
          value={summary === null ? '—' : formatTokens(summary.outputTokens)}
        />
        <StatCard
          label="平均耗时"
          value={
            summary === null || summary.avgDurationMs === null
              ? '—'
              : formatDuration(summary.avgDurationMs)
          }
        />
      </div>
      <div className="faint" style={{ marginTop: 6, fontSize: 11 }}>
        统计为<strong>全量口径</strong>（服务端聚合，不受下方条数上限影响）。
      </div>

      {events.length === 0 ? (
        <div className="empty">暂无记录</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>时间</th>
              <th>任务</th>
              <th>追踪</th>
              <th>模型</th>
              <th>耗时</th>
              <th>token（入/出）</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {events.map(row => (
              <tr
                key={row.id}
                className={row.jobId !== null ? 'clickable' : undefined}
                onClick={row.jobId !== null ? () => onOpenJob(row.jobId!) : undefined}
              >
                <td className="num faint">{formatTime(row.createdAt)}</td>
                <td className="mono faint">{shortId(row.jobId)}</td>
                <td className="mono faint">{shortId(row.traceId)}</td>
                <td>{row.model ?? <span className="faint">未记录</span>}</td>
                <td className="num">
                  {row.durationMs === null ? '—' : formatDuration(row.durationMs)}
                </td>
                <td className="num">
                  {formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}
                </td>
                <td>{row.status === null ? <span className="faint">—</span> : row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/**
 * 长 id 截短显示（保留头尾，中间省略）。
 *
 * 为什么不全显示：`job-<uuid>` 有 40 字符，三列 id 会把表撑到横向滚动，
 * 反而看不见关键列。头尾保留足以让人肉眼比对两条记录是否同一任务。
 */
export function shortId(id: string | null): string {
  if (id === null || id.length === 0) return '—'
  if (id.length <= 18) return id
  return `${id.slice(0, 9)}…${id.slice(-5)}`
}

/** token 数用千分位（大数字肉眼可读）。null/undefined 视为 0（账本列 NOT NULL DEFAULT 0）。 */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US')
}

/** 类型别名，便于测试引用事件行形状。 */
export type { WireUsageEvent }

function StatCard({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div
      className="card"
      style={{ padding: '10px 16px', minWidth: 120, display: 'flex', flexDirection: 'column' }}
    >
      <span className="faint" style={{ fontSize: 11, letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ fontSize: 20, fontWeight: 600, fontFamily: 'var(--mono)' }}>
        {value}
      </span>
    </div>
  )
}
