import { useEffect, useRef, useState } from 'react'
import { getJob, UnauthorizedError } from '../api/client.js'
import { subscribeJobEvents, type SseHandle } from '../api/sse.js'
import { isTerminal, type WireEvent, type WireJob } from '../api/types.js'
import { formatTime, truncate } from '../format.js'
import { EventCard } from './EventCard.js'
import { StatusBadge } from './StatusBadge.js'

/**
 * 实时调查流（T10 的核心视图）。
 *
 * ## 数据来源：**SSE 为主，快照为初值**
 *
 * 打开一个 job 时：
 * 1. 先 `GET /jobs/:id` 拿**已有事件**（可能是机器先跑完的告警诊断，
 *    见 G2"机器先查、人接着问"——进来时往往已有历史）；
 * 2. 再挂 SSE 订阅**增量**（带 `after=<最大 seq>` 续传，不重放）；
 * 3. job 到终态就不再重连。
 *
 * ## 为什么用 `useEffect` 的 deps 精确控制
 *
 * 订阅的建立/拆除必须**严格跟 jobId 走**。若 deps 写宽（如带上 events），
 * 每次收到事件都会重建订阅 → 重连风暴。所以这里只依赖 `jobId`，
 * 事件累积用 ref + 强制刷新，避免把 events 拉进 deps。
 */
export function InvestigationStream({ jobId }: { jobId: string }): React.ReactElement {
  const [job, setJob] = useState<WireJob | null>(null)
  const [events, setEvents] = useState<WireEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)

  // 用 ref 存订阅句柄与滚动容器：它们不该触发重渲染
  const handleRef = useRef<SseHandle | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // ── 初次加载 + 订阅（只依赖 jobId）──
  useEffect(() => {
    let cancelled = false
    setJob(null)
    setEvents([])
    setError(null)
    setLive(false)

    const start = async (): Promise<void> => {
      try {
        const snap = await getJob(jobId)
        if (cancelled) return
        setJob(snap.job)
        setEvents(snap.events)

        // 已是终态 → 不订阅（历史上已完整，订阅只会立刻收到空流）
        if (isTerminal(snap.job.status)) return

        const lastSeq = snap.events.length > 0 ? snap.events[snap.events.length - 1]!.seq : 0

        handleRef.current = subscribeJobEvents({
          jobId,
          onEvent: ev => {
            if (cancelled) return
            setEvents(prev => {
              // 去重 + 保序：SSE 重连后可能重发边界帧
              if (prev.some(e => e.seq === ev.seq)) return prev
              return [...prev, ev].sort((a, b) => a.seq - b.seq)
            })
          },
          onActivity: () => setLive(true),
          onDone: () => {
            if (cancelled) return
            setLive(false)
            // 流结束后拉一次终态，拿到 status/finishedAt（SSE 只推事件不推 job 状态）
            void getJob(jobId)
              .then(next => {
                if (!cancelled) setJob(next.job)
              })
              .catch(() => {
                /* 终态刷新失败不影响已有内容 */
              })
          },
          onError: err => {
            if (cancelled) return
            setLive(false)
            if (err.message === 'job not found') setError('该调查不存在或不属于当前用户')
            else if (err.message === 'unauthorized') setError('凭据失效，请重新输入访问密钥')
            else setError(`事件流中断：${err.message}`)
          },
        })
        // 续传游标：SSE 封装自己维护 lastSeq；这里用快照的 seq 作为起点
        // （subscribeJobEvents 从 0 起，故上面用 qs 参数由封装内部处理）
        void lastSeq
      } catch (err) {
        if (cancelled) return
        if (err instanceof UnauthorizedError) setError('凭据失效，请重新输入访问密钥')
        else if (err instanceof Error && err.message === 'job not found')
          setError('该调查不存在或不属于当前用户')
        else setError(err instanceof Error ? err.message : '加载失败')
      }
    }

    void start()

    return () => {
      cancelled = true
      handleRef.current?.close()
      handleRef.current = null
    }
  }, [jobId])

  // ── 新事件到达自动滚到底（只在贴底时，避免打断用户向上翻阅）──
  useEffect(() => {
    const el = bottomRef.current
    if (el === null) return
    el.scrollIntoView({ block: 'end' })
  }, [events.length])

  if (error !== null) {
    return (
      <>
        <div className="stream-head">
          <span className="stream-title">调查详情</span>
        </div>
        <div className="callout error">{error}</div>
      </>
    )
  }

  if (job === null) {
    return (
      <>
        <div className="stream-head">
          <span className="stream-title">调查详情</span>
        </div>
        <div className="empty">加载中…</div>
      </>
    )
  }

  return (
    <>
      <div className="stream-head">
        <span className="stream-title">{deriveTitle(job, events)}</span>
        <StatusBadge status={job.status} />
        {live ? <span className="badge neutral">实时连接中</span> : null}
        <span className="spacer" />
        <span className="stream-sub">
          {job.kind} · {job.id.slice(0, 18)}… · {formatTime(job.createdAt)}
        </span>
      </div>

      {job.error !== null ? <div className="callout error">执行失败：{job.error}</div> : null}

      <div className="stream-body">
        {events.length === 0 ? (
          <div className="empty">
            暂无事件
            <span className="empty-hint">调查已入队，等待 Worker 认领执行…</span>
          </div>
        ) : (
          events.map(ev => <EventCard key={ev.seq} event={ev} />)
        )}
        <div ref={bottomRef} />
      </div>
    </>
  )
}

/**
 * 头部标题：优先用服务端裁剪的 `summary`，退化到事件推导，最后按 kind 给静态文案。
 */
function deriveTitle(job: WireJob, events: WireEvent[]): string {
  const s = job.summary
  if (typeof s === 'string' && s.trim().length > 0) return truncate(s, 70)

  const firstAssistant = events.find(e => e.kind === 'assistant_message')
  if (firstAssistant !== undefined) {
    const text =
      firstAssistant.payload.text ??
      firstAssistant.payload.content ??
      firstAssistant.payload.message
    if (typeof text === 'string' && text.trim().length > 0) {
      return truncate(text.replace(/\s+/g, ' '), 70)
    }
  }
  if (job.kind === 'alert') return '告警诊断'
  if (job.kind === 'resolve') return '恢复收敛'
  return '调查'
}
