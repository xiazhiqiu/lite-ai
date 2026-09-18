/**
 * 拉取型 provider 共用的 HTTP 请求工具。
 *
 * 抽取动机：`http-poll`（通用 REST）与 `k8s-events`（K8s API）都要做同一件事
 * ——「发请求 → 取 JSON」，而且**失败语义必须逐字一致**。这是最容易在复制粘贴中
 * 悄悄分叉的部分：一旦"超时"与"进程关停取消"混淆，运维会把正常的优雅关停
 * 误读成源故障。第二份拷贝即抽取阈值。
 *
 * 与 `webhook/topology.ts` 的 `fetchJson` 是同一套做法（超时用独立 controller、
 * 失败上抛），但两者归属不同层：那份服务于**拓扑图**拉取，这份服务于**告警**拉取。
 */
import type { FetchLike } from '../../webhook/topology.js'

/** 默认请求超时（10 秒）：多数监控 API 的 p99 响应远在此之内。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export type JsonRequestOptions = {
  /** 调用方标识（provider 名），仅用于错误信息 —— 运维要能一眼看出是哪个源挂了 */
  owner: string
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** POST 请求体；对象会被 JSON 序列化 */
  body?: unknown
  timeoutMs?: number
  /** 可注入 fetch（测试用本地 stub，零外网依赖） */
  fetchImpl?: FetchLike
  /** 外部取消信号（调度器关停时用）；与超时区分成两种不同的错误 */
  signal?: AbortSignal
}

/**
 * 发请求并解析 JSON。
 *
 * **失败一律上抛**，由调度器捕获后 `warn` 并跳过本轮。在这里静默吞掉会让
 * "源挂了"表现为"今天没有告警" —— 那是最危险的故障模式。
 *
 * 三种失败给出**可区分**的错误：超时（>timeoutMs）/ 被取消（进程关停）/
 * HTTP 非 2xx / 响应非 JSON。
 */
export async function requestJson(opts: JsonRequestOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const relayAbort = (): void => controller.abort()
  opts.signal?.addEventListener('abort', relayAbort, { once: true })

  try {
    const fetchImpl: FetchLike =
      opts.fetchImpl ?? ((input, init) => fetch(input, init))
    const response = await fetchImpl(opts.url, {
      method: opts.method ?? 'GET',
      headers: opts.headers ?? { accept: 'application/json' },
      body:
        opts.method === 'POST' && opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined,
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`${opts.owner} 拉取失败: HTTP ${response.status} ${response.statusText}`)
    }
    try {
      return (await response.json()) as unknown
    } catch {
      throw new Error(`${opts.owner} 拉取失败: 响应不是合法 JSON`)
    }
  } catch (error) {
    if (timedOut) throw new Error(`${opts.owner} 拉取超时（>${timeoutMs}ms）`)
    if (opts.signal?.aborted === true) throw new Error(`${opts.owner} 拉取被取消（进程关停）`)
    throw error
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', relayAbort)
  }
}
