import { useEffect, useState } from 'react'
import { listJobs, UnauthorizedError } from '../api/client.js'
import type { WireJob } from '../api/types.js'
import { formatDuration, formatTime, KIND_LABELS, summarizeJob } from '../format.js'
import { StatusBadge } from './StatusBadge.js'

/**
 * 审计用量页（T10）。
 *
 * ## ⚠️ 诚实边界：这是**job 派生的近似视图**，不是真正的用量账本
 *
 * plan 里的 `usage_events` 表（T2 已建，见 `schema.sql`）由 **T7** 落库，
 * 目前**还没有** `/usage` 读接口。所以当前页面从 job 列表**推导**：
 * - 谁（`userId`）、何时（`createdAt`）、什么类型（`kind`）、多久（`finishedAt - createdAt`）、
 *   什么结果（`status`）—— 这些 job 上都真实存在；
 * - **模型 / token 数** —— job 上**没有**，必须等 T7 的 `usage_events`。
 *
 * 所以这里**不编造** token 数字：相关列直接标注"待 T7"，而不是显示 0
 * （显示 0 会让值班员以为"这次没消耗 token"，是错误信息）。等 T7 落地后
 * 把数据源换成 `/usage` 即可，列结构不用改。
 *
 * 这是"宁可留空也不造假"的具体应用：审计页的价值全在数字可信，
 * 一个假数字比没有数字更糟。
 */
export function UsageView({
  onOpenJob,
  onUnauthorized,
}: {
  onOpenJob: (jobId: string) => void
  onUnauthorized?: () => void
}): React.ReactElement {
  const [jobs, setJobs] = useState<WireJob[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const list = await listJobs({ limit: 200 })
        if (cancelled) return
        setJobs(list)
        setError(null)
      } catch (err) {
        if (cancelled) return
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.()
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

  const stats = computeStats(jobs)

  return (
    <div className="page">
      <div className="page-head">
        <h2>审计与用量</h2>
        <span className="spacer" />
        <span className="faint">仅显示当前账户（服务端按身份过滤）</span>
      </div>

      {error !== null ? <div className="callout error">{error}</div> : null}

      <div className="callout info">
        当前为 <strong>job 派生视图</strong>：模型与 token 用量需等 T7 的
        <code style={{ fontFamily: 'var(--mono)' }}> usage_events </code>
        落库后才可读，此处不编造数字。
      </div>

      <div className="filters" style={{ marginTop: 14 }}>
        <StatCard label="总调查数" value={String(stats.total)} />
        <StatCard label="进行中" value={String(stats.active)} />
        <StatCard label="已完成" value={String(stats.completed)} />
        <StatCard label="失败" value={String(stats.failed)} />
        <StatCard label="平均耗时" value={formatDuration(stats.avgDuration)} />
      </div>

      {jobs.length === 0 ? (
        <div className="empty">暂无记录</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>时间</th>
              <th>账户</th>
              <th>类型</th>
              <th>摘要</th>
              <th>耗时</th>
              <th>模型 / token</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => (
              <tr key={job.id} className="clickable" onClick={() => onOpenJob(job.id)}>
                <td className="num faint">{formatTime(job.createdAt)}</td>
                <td className="num muted">{job.userId}</td>
                <td>{KIND_LABELS[job.kind] ?? job.kind}</td>
                <td>{summarizeJob(job)}</td>
                <td className="num">
                  {job.finishedAt !== null
                    ? formatDuration(job.finishedAt - job.createdAt)
                    : '—'}
                </td>
                <td className="faint">待 T7</td>
                <td>
                  <StatusBadge status={job.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

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

/** 统计口径：只统计**本次返回的这批 job**（分页边界内），不做全量聚合。 */
export function computeStats(jobs: WireJob[]): {
  total: number
  active: number
  completed: number
  failed: number
  avgDuration: number | null
} {
  let active = 0
  let completed = 0
  let failed = 0
  const durations: number[] = []

  for (const job of jobs) {
    if (job.status === 'pending' || job.status === 'running') active += 1
    else if (job.status === 'completed') completed += 1
    else if (job.status === 'failed') failed += 1

    if (job.finishedAt !== null) durations.push(job.finishedAt - job.createdAt)
  }

  const avgDuration =
    durations.length === 0
      ? null
      : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)

  return { total: jobs.length, active, completed, failed, avgDuration }
}
