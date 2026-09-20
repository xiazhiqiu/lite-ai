import { useEffect, useState } from 'react'
import { listJobs, UnauthorizedError } from '../api/client.js'
import type { WireJob } from '../api/types.js'
import { formatTime, summarizeJob } from '../format.js'
import { StatusBadge } from './StatusBadge.js'

/**
 * 告警视图（T10）—— 列出 `kind === 'alert'` 的告警诊断 job。
 *
 * ## 为什么用 job 列表而不是单独的 incidents API
 *
 * 服务端目前**没有** `/incidents` 端点（聚合状态在 PG 里，但尚未开读接口），
 * 而告警诊断 job 已经携带了 `incidentId`。所以这里从 job 侧反查：
 * **每个告警诊断 = 一条 job**，`incidentId` 相同即同一次事件级调查。
 *
 * 这是个**诚实的边界**：真正的"事件聚合视图"（一个 incident 下多条成员告警、
 * 维度升级历史）需要 T12 的 `incident_members` 暴露成 API，属后续增强。
 * 当前视图保证的是"值班员能看到每个告警的诊断入口并可跳转"。
 *
 * ## 点击跳转调查
 *
 * 点击行 → `onOpenJob(jobId)` → 上层切到调查详情并挂 SSE。这是"从告警到
 * 调查过程"的最短路径，也是这个页面存在的全部意义。
 */
export function AlertView({
  onOpenJob,
  onUnauthorized,
}: {
  onOpenJob: (jobId: string) => void
  onUnauthorized?: () => void
}): React.ReactElement {
  const [jobs, setJobs] = useState<WireJob[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const list = await listJobs({ limit: 100 })
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
    const timer = setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [onUnauthorized])

  const alerts = jobs.filter(j => j.kind === 'alert' || j.kind === 'resolve')
  const needle = filter.trim().toLowerCase()
  const shown =
    needle.length === 0
      ? alerts
      : alerts.filter(j =>
          [summarizeJob(j), j.incidentId ?? '', j.id].some(s =>
            s.toLowerCase().includes(needle),
          ),
        )

  return (
    <div className="page">
      <div className="page-head">
        <h2>告警诊断</h2>
        <span className="faint num">{shown.length}</span>
        <span className="spacer" />
      </div>

      {error !== null ? <div className="callout error">{error}</div> : null}

      <div className="filters">
        <input
          className="input"
          placeholder="按摘要 / incidentId / jobId 筛选…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          暂无告警诊断
          <span className="empty-hint">
            告警 webhook 触发后会自动入队诊断，这里即可看到
          </span>
        </div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>摘要</th>
              <th>事件</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(job => (
              <tr
                key={job.id}
                className="clickable"
                onClick={() => onOpenJob(job.id)}
              >
                <td>{summarizeJob(job)}</td>
                <td className="num muted">{job.incidentId ?? '—'}</td>
                <td>
                  <StatusBadge status={job.status} />
                </td>
                <td className="num faint">{formatTime(job.createdAt)}</td>
                <td>
                  <button
                    className="btn small"
                    onClick={e => {
                      e.stopPropagation()
                      onOpenJob(job.id)
                    }}
                  >
                    查看调查
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
