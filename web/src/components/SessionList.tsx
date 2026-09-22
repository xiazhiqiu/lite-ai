import { useCallback, useEffect, useRef, useState } from 'react'
import {
  forkSession,
  listJobs,
  listSessions,
  renameSession,
  UnauthorizedError,
} from '../api/client.js'
import { isActive, type WireJob, type WireSession } from '../api/types.js'
import { KIND_LABELS, relativeTime, truncate } from '../format.js'
import { StatusBadge } from './StatusBadge.js'

/**
 * 会话侧栏（第 1 档改造）。
 *
 * ## 为什么从"job 列表"改成"会话列表"
 *
 * 会话是**跨多轮**的容器（同一会话追问两轮 = 一个会话、两条 job）。此前栏里平铺
 * job，导致"追问一次就多一条记录"，看不出它们属于同一次排查。现在按会话聚合，
 * 每条显示该会话**最近一次** job 的状态。
 *
 * ## "只看我的"仍无需前端传参
 *
 * 服务端从鉴权头解析 userId 并强制过滤。**注意 `/sessions` 的过滤口径**：只返回
 * "自己有 job 的会话" —— 会话本身没有 userId 维度，归属靠 job 所有权反查。
 * 所以这里拿不到无主会话，是刻意的（见 `server/http.ts` 的 handleListSessions）。
 *
 * ## 轮询而非 SSE
 *
 * 列表只需"大致新鲜"，用 3 秒轮询；实时性由点进去的 InvestigationStream 保证。
 */
export function SessionList({
  selectedSessionId,
  onSelect,
  onForked,
  refreshKey,
  onUnauthorized,
}: {
  selectedSessionId: string | null
  /** 选中某会话：回传会话 id 与它**最近一次** job 的 id（右侧据此渲染事件流）。 */
  onSelect: (sessionId: string, latestJobId: string) => void
  /** 分叉完成后回传**新**会话 id（让上层切过去；新会话要发一次问才有 job）。 */
  onForked: (newSessionId: string) => void
  /** 外部要求刷新的信号（如刚提交了新调查）。 */
  refreshKey: number
  onUnauthorized?: () => void
}): React.ReactElement {
  const [sessions, setSessions] = useState<WireSession[]>([])
  const [jobs, setJobs] = useState<WireJob[]>([])
  const [onlyActive, setOnlyActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localRefresh, setLocalRefresh] = useState(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async (): Promise<void> => {
      try {
        // 两个请求并发：会话列表 + job 列表。后者用于给每个会话找"最近一次 job"
        // （状态徽标、以及点进去要打开哪条）。job 的 limit 给大一些，避免老会话
        // 因为它的 job 落在窗口外而显示不出状态。
        const [nextSessions, nextJobs] = await Promise.all([
          listSessions({ limit: 50 }),
          listJobs({ limit: 100 }),
        ])
        if (!mounted.current) return
        setSessions(nextSessions)
        setJobs(nextJobs)
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
  }, [refreshKey, localRefresh, onUnauthorized])

  /** 每个会话 → 它最近一次 job（按 createdAt 取最新）。 */
  const latestJobBySession = new Map<string, WireJob>()
  for (const j of jobs) {
    if (j.sessionId === null) continue
    const prev = latestJobBySession.get(j.sessionId)
    if (prev === undefined || j.createdAt > prev.createdAt) {
      latestJobBySession.set(j.sessionId, j)
    }
  }

  const rows = sessions
    .map(session => ({ session, job: latestJobBySession.get(session.id) ?? null }))
    .filter(row => (onlyActive ? row.job !== null && isActive(row.job.status) : true))

  const doRename = useCallback(async (s: WireSession): Promise<void> => {
    const next = window.prompt('重命名会话', s.title ?? '')
    if (next === null || next.trim().length === 0) return
    try {
      await renameSession(s.id, next.trim())
      setLocalRefresh(k => k + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败')
    }
  }, [])

  const doFork = useCallback(
    async (s: WireSession): Promise<void> => {
      try {
        const newId = await forkSession(s.id)
        setError(null)
        setLocalRefresh(k => k + 1)
        onForked(newId)
      } catch (err) {
        setError(err instanceof Error ? err.message : '分叉失败')
      }
    },
    [onForked],
  )

  const open = (row: { session: WireSession; job: WireJob | null }): void => {
    // 没有 job 的会话不会出现在列表里（服务端归属口径决定），所以 job 必非空；
    // 这里仍做一次防御，避免把 undefined 传下去。
    if (row.job !== null) onSelect(row.session.id, row.job.id)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="row">
          <span className="sidebar-title">会话</span>
          <span className="spacer" />
          <span className="faint num">{rows.length}</span>
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
        {rows.length === 0 ? (
          <div className="empty" style={{ padding: 20, fontSize: 12.5 }}>
            暂无会话
            <span className="empty-hint">在下方输入问题即可发起</span>
          </div>
        ) : (
          rows.map(({ session, job }) => (
            <div
              key={session.id}
              className="job-item"
              role="button"
              tabIndex={0}
              aria-selected={session.id === selectedSessionId}
              style={{ cursor: 'pointer' }}
              onClick={() => open({ session, job })}
              onKeyDown={e => {
                if (e.key === 'Enter') open({ session, job })
              }}
            >
              <div className="job-item-top">
                <StatusBadge status={job?.status ?? 'completed'} />
                {job !== null ? (
                  <span className="faint" style={{ fontSize: 11.5 }}>
                    {KIND_LABELS[job.kind] ?? job.kind}
                  </span>
                ) : null}
                <span className="spacer" />
                <span className="job-item-meta">{relativeTime(session.updatedAt)}</span>
              </div>
              <div className="job-item-msg">
                {truncate(session.title ?? '（未命名会话）', 60)}
              </div>
              <div className="row" style={{ marginTop: 6, gap: 10 }}>
                <span
                  role="button"
                  tabIndex={-1}
                  className="faint"
                  style={{ fontSize: 11.5, cursor: 'pointer' }}
                  onClick={e => {
                    e.stopPropagation()
                    void doRename(session)
                  }}
                >
                  重命名
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="faint"
                  style={{ fontSize: 11.5, cursor: 'pointer' }}
                  onClick={e => {
                    e.stopPropagation()
                    void doFork(session)
                  }}
                >
                  分叉
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
