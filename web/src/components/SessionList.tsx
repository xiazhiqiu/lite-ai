import { useEffect, useRef, useState } from 'react'
import { listJobs, UnauthorizedError } from '../api/client.js'
import { isActive, type WireJob } from '../api/types.js'
import { KIND_LABELS, relativeTime, summarizeJob, truncate } from '../format.js'
import { StatusBadge } from './StatusBadge.js'

/**
 * 会话/任务列表（T10）。
 *
 * ## "只看我的"无需前端传参
 *
 * T6 起服务端从**鉴权头**解析 userId 并强制过滤（`if (job.userId !== userId) → 404`），
 * 所以这里天然只看到自己的 job。前端**不该也不能**通过传 userId 来筛选——
 * 那会被服务端忽略（且是套伪造型攻击面）。
 *
 * ## 轮询而非 SSE
 *
 * 列表里有多个 job 在跑，逐个开 SSE 会给服务端 N 条长连接。列表只需"大致新鲜"，
 * 用 3 秒轮询即可；真正的实时性由点进去的 InvestigationStream 保证。
 */
export function SessionList({
  selectedId,
  onSelect,
  refreshKey,
  onUnauthorized,
}: {
  selectedId: string | null
  onSelect: (jobId: string) => void
  /** 外部要求刷新的信号（如刚提交了新调查）。 */
  refreshKey: number
  onUnauthorized?: () => void
}): React.ReactElement {
  const [jobs, setJobs] = useState<WireJob[]>([])
  const [onlyActive, setOnlyActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async (): Promise<void> => {
      try {
        const list = await listJobs({ limit: 50 })
        if (!mounted.current) return
        setJobs(list)
        setError(null)
      } catch (err) {
        if (!mounted.current) return
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.()
          return
        }
        setError(err instanceof Error ? err.message : '加载列表失败')
      }
      if (mounted.current) timer = setTimeout(() => void tick(), 3000)
    }

    void tick()
    return () => {
      mounted.current = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [refreshKey, onUnauthorized])

  const shown = onlyActive ? jobs.filter(j => isActive(j.status)) : jobs

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="row">
          <span className="sidebar-title">调查列表</span>
          <span className="spacer" />
          <span className="faint num">{shown.length}</span>
        </div>
        <label className="row" style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={e => setOnlyActive(e.target.checked)}
          />
          只看进行中
        </label>
      </div>

      {error !== null ? <div className="callout error">{error}</div> : null}

      <div className="sidebar-list">
        {shown.length === 0 ? (
          <div className="empty" style={{ padding: 20, fontSize: 12.5 }}>
            暂无调查
            <span className="empty-hint">在下方输入问题即可发起</span>
          </div>
        ) : (
          shown.map(job => (
            <button
              key={job.id}
              className="job-item"
              aria-selected={job.id === selectedId}
              onClick={() => onSelect(job.id)}
            >
              <div className="job-item-top">
                <StatusBadge status={job.status} />
                <span className="faint" style={{ fontSize: 11.5 }}>
                  {KIND_LABELS[job.kind] ?? job.kind}
                </span>
                <span className="spacer" />
                <span className="job-item-meta">{relativeTime(job.createdAt)}</span>
              </div>
              <div className="job-item-msg">{truncate(summarizeJob(job), 60)}</div>
            </button>
          ))
        )}
      </div>
    </aside>
  )
}
