import { useEffect, useRef, useState } from 'react'
import { postChat, UnauthorizedError } from '../api/client.js'

/**
 * 发起新调查 / 续聊追问（T10 + G2）。
 *
 * ## 关键：`sessionId` 的可选传入决定了"这是新会话还是续聊"
 *
 * - **不传** → 服务端新开一个 session（此时返回的 `sessionId` 要记下来，
 *   供后续追问复用）；
 * - **传了** → 挂在既有会话上**续聊**。这正是"**机器先查、人接着问**"的实现：
 *   告警自动诊断产出的会话，值班员可以在同一个 session 里接着追问上下文。
 *
 * 服务端刻意**不校验 session 是否存在**（`server/http.ts` 注释），所以即便
 * 会话是 Worker 侧刚建、前端还没见过，也能直接续接。
 */
export type ChatInputProps = {
  /** 续聊目标会话；不传 = 新会话。 */
  sessionId?: string
  /** 入队成功回调（把新 jobId 交给上层去切换视图）。 */
  onSubmitted: (result: { jobId: string; sessionId: string }) => void
  /** 未授权回调（让上层弹登录）。 */
  onUnauthorized?: () => void
  /** 占位文案。 */
  placeholder?: string
  /** 提交按钮文案。 */
  submitLabel?: string
}

export function ChatInput({
  sessionId,
  onSubmitted,
  onUnauthorized,
  placeholder,
  submitLabel,
}: ChatInputProps): React.ReactElement {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement | null>(null)

  // 切换会话时清空草稿（避免把 A 会话的追问发到 B 会话）
  useEffect(() => {
    setValue('')
    setError(null)
  }, [sessionId])

  const submit = async (): Promise<void> => {
    const message = value.trim()
    if (message.length === 0 || busy) return

    setBusy(true)
    setError(null)
    try {
      const result = await postChat(
        sessionId !== undefined && sessionId.length > 0 ? { message, sessionId } : { message },
      )
      setValue('')
      onSubmitted(result)
      ref.current?.focus()
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.()
        return
      }
      setError(err instanceof Error ? err.message : '提交失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="composer">
      {error !== null ? <div className="callout error">{error}</div> : null}
      <div className="composer-row">
        <textarea
          ref={ref}
          value={value}
          placeholder={
            placeholder ??
            (sessionId !== undefined
              ? '继续追问这个调查（会复用当前会话上下文）…'
              : '描述要排查的问题，例如：为什么订单接口 P99 延迟升高了？')
          }
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            // Enter 发送、Shift+Enter 换行 —— 与常见 IM 一致
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          rows={2}
        />
        <button
          className="btn primary"
          onClick={() => void submit()}
          disabled={busy || value.trim().length === 0}
        >
          {busy ? '提交中…' : (submitLabel ?? (sessionId !== undefined ? '追问' : '发起调查'))}
        </button>
      </div>
    </div>
  )
}
