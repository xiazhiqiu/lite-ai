import { useMemo, useState } from 'react'
import type { WireEvent } from '../api/types.js'
import { eventSummary, formatPayload, formatTime, renderMarkdown } from '../format.js'

/**
 * 单条事件卡片。
 *
 * - 默认**折叠**（只显示 kind + 一行摘要）：一次调查可能几十上百条工具调用，
 *   全展开会让值班员淹没在细节里。
 * - `assistant_message`（结论）**默认展开**并按 Markdown 渲染——那是值班员
 *   真正要读的东西。
 * - 工具调用/结果折叠，需要取证时再展开。
 */
export function EventCard({ event }: { event: WireEvent }): React.ReactElement {
  // 结论默认展开；工具类默认折叠（信息密度取舍）
  const [open, setOpen] = useState(event.kind === 'assistant_message')
  const summary = eventSummary(event.kind, event.payload)

  // 结论用 Markdown 渲染；其余用等宽原始文本
  const html = useMemo(() => {
    if (event.kind !== 'assistant_message') return null
    const text = event.payload.text ?? event.payload.content ?? event.payload.message
    return typeof text === 'string' ? renderMarkdown(text) : null
  }, [event])

  return (
    <div className={`event ${event.kind}`}>
      <div
        className="event-head"
        onClick={() => setOpen(v => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(v => !v)
          }
        }}
        aria-expanded={open}
      >
        <span className={`disclosure ${open ? 'open' : ''}`}>▶</span>
        <span className="event-kind">{event.kind}</span>
        {!open ? <span className="muted">{summary}</span> : null}
        <span className="spacer" />
        <span className="event-seq">
          #{event.seq} · {formatTime(event.createdAt)}
        </span>
      </div>

      {open ? (
        <div className="event-body">
          {html !== null ? (
            <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre>{formatPayload(event.payload)}</pre>
          )}
        </div>
      ) : null}
    </div>
  )
}
