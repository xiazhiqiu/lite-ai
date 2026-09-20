/**
 * SSE 封装（T10）。
 *
 * ## 为什么不用原生 `EventSource`
 *
 * 1. **原生 `EventSource` 无法自定义请求头** —— 而 T6 起所有 API 都要
 *    `Authorization`。所以这里用 `fetch` + `ReadableStream` 自己解析 SSE
 *    （原生 EventSource 只能靠 cookie 鉴权，我们用的是 Bearer 头）。
 * 2. **需要 `Last-Event-ID` 断线续传** —— 服务端按 seq 增量推送，重连时
 *    必须把"已收到的最大 seq"带上，否则会重放全部事件（重复渲染工具调用）。
 * 3. **需要终态即停** —— job 到 completed/failed 后服务端会收流，
 *    客户端也要停止重连，否则会无限重试一个已结束的 job。
 *
 * ## 关键设计：`lastSeq` 由本模块维护
 *
 * 调用方不需要关心游标。每次收到事件就更新 `lastSeq`，重连时自动带上
 * `?after=<lastSeq>`（服务端同时支持 `Last-Event-ID` 头与 `?after=` 查询参数，
 * 这里用查询参数——`fetch` 下发自定义头在跨代理场景更容易出岔子）。
 */
import type { WireEvent } from './types.js'
import { getApiKey } from './client.js'

/** SSE 客户端选项。 */
export type SseOptions = {
  jobId: string
  /** 每收到一条事件回调（按 seq 升序，不重不漏）。 */
  onEvent: (event: WireEvent) => void
  /** 流正常结束（服务端确认终态）时回调。 */
  onDone?: () => void
  /** 出错回调（含网络错误；会自动重连，此回调仅用于展示状态）。 */
  onError?: (err: Error) => void
  /** 收到任一数据（含心跳）时回调——用于 UI 显示"连接活跃"。 */
  onActivity?: () => void
  /** 最大重连次数（默认 5）；超限后放弃并回调 onError。 */
  maxRetries?: number
}

/** 可取消的 SSE 订阅句柄。 */
export type SseHandle = {
  /** 主动关闭（不再重连）。 */
  close: () => void
  /** 当前已接收到的最大 seq（便于调试/断言）。 */
  lastSeq: () => number
}

/**
 * 解析 SSE 文本块为事件列表。
 *
 * 暴露为纯函数以便单测（不需要真起 HTTP）。
 *
 * SSE 帧格式：
 * ```
 * id: 3\n
 * event: tool_result\n
 * data: {"ok":true}\n
 * \n            ← 空行分隔帧
 * ```
 *
 * 注意：**一行 `data:` 可以出现多次**（规范允许多行 data，按 `\n` 拼接）。
 * 服务端的 `payload` 是单行 JSON，但这里仍按规范实现，避免日后服务端改动即坏。
 */
export function parseSseChunk(chunk: string): Array<{
  id: number | null
  event: string | null
  data: string
}> {
  const frames: Array<{ id: number | null; event: string | null; data: string }> = []

  for (const rawFrame of chunk.split('\n\n')) {
    const frame = rawFrame.trim()
    if (frame.length === 0) continue
    // 纯注释帧（心跳 `: ping`）——无 data，忽略
    if (frame.startsWith(':')) continue

    let id: number | null = null
    let event: string | null = null
    const dataLines: string[] = []

    for (const line of frame.split('\n')) {
      if (line.startsWith('id:')) {
        const n = Number(line.slice('id:'.length).trim())
        id = Number.isFinite(n) ? n : null
      } else if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
      }
      // 其他字段（retry: 等）忽略
    }

    if (dataLines.length === 0) continue
    frames.push({ id, event, data: dataLines.join('\n') })
  }

  return frames
}

/**
 * 订阅某个 job 的事件流。
 *
 * 返回的 `close()` 会中止当前请求并停止重连。
 */
export function subscribeJobEvents(opts: SseOptions): SseHandle {
  const maxRetries = opts.maxRetries ?? 5
  let lastSeq = 0
  let closed = false
  let controller: AbortController | null = null
  let retries = 0

  const run = async (): Promise<void> => {
    while (!closed) {
      controller = new AbortController()

      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      const key = getApiKey()
      if (key !== null) headers.Authorization = `Bearer ${key}`

      // 断线续传：带上已收到的最大 seq
      const qs = lastSeq > 0 ? `?after=${lastSeq}` : ''

      try {
        const res = await fetch(
          `/jobs/${encodeURIComponent(opts.jobId)}/stream${qs}`,
          { headers, signal: controller.signal },
        )

        if (res.status === 401) {
          opts.onError?.(new Error('unauthorized'))
          return // 凭据问题，重连无意义
        }
        if (res.status === 404) {
          // job 不存在或**不属于当前用户**（服务端刻意同形）→ 不重连
          opts.onError?.(new Error('job not found'))
          return
        }
        if (!res.ok || res.body === null) {
          throw new Error(`stream failed: HTTP ${res.status}`)
        }

        retries = 0 // 连上了，重置重试计数
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (closed) {
            await reader.cancel()
            return
          }

          buffer += decoder.decode(value, { stream: true })
          opts.onActivity?.()

          // 只在完整的帧边界切分；最后一段可能不完整，留在 buffer 里
          const lastBoundary = buffer.lastIndexOf('\n\n')
          if (lastBoundary === -1) continue

          const complete = buffer.slice(0, lastBoundary + 2)
          buffer = buffer.slice(lastBoundary + 2)

          for (const frame of parseSseChunk(complete)) {
            if (frame.event === null) continue
            let payload: Record<string, unknown> = {}
            try {
              const parsed: unknown = JSON.parse(frame.data)
              if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                payload = parsed as Record<string, unknown>
              }
            } catch {
              // payload 不是 JSON（不应发生）→ 以原文包装，别丢事件
              payload = { raw: frame.data }
            }

            const seq = frame.id ?? lastSeq + 1
            if (seq <= lastSeq) continue // 去重：重连后服务端可能重发边界帧
            lastSeq = seq
            opts.onEvent({ seq, kind: frame.event, payload, createdAt: Date.now() })
          }
        }

        // 流自然结束 = 服务端判定终态并收流
        if (!closed) opts.onDone?.()
        return
      } catch (err) {
        if (closed) return
        if (err instanceof Error && err.name === 'AbortError') return

        retries += 1
        if (retries > maxRetries) {
          opts.onError?.(err instanceof Error ? err : new Error(String(err)))
          return
        }
        opts.onError?.(err instanceof Error ? err : new Error(String(err)))

        // 退避重连：0.5s、1s、1.5s…（内网值班台，无需指数退避）
        await sleep(500 * retries)
      }
    }
  }

  void run()

  return {
    close: (): void => {
      closed = true
      controller?.abort()
    },
    lastSeq: (): number => lastSeq,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
