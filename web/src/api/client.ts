/**
 * 服务端 API 客户端（T10）。
 *
 * ## 三条口径
 *
 * 1. **鉴权头统一在这里加**。所有请求走 `request()` 一个出口——散落各处必然
 *    漏掉某个调用，那正是"某个页面莫名 401"的来源。
 *
 * 2. **401 抛 `UnauthorizedError`**（而非返回空数据）。让调用方显式处理
 *    "凭据失效"，而不是静默渲染一个空列表（值班员会以为"今天没告警"）。
 *
 * 3. **404 让它自然抛出**。`request()` 对非 2xx 一律抛 `ApiError`；对"不存在的
 *    job"这类正常业务分支，调用方 catch 后按需处理。不做"404 返回 null"的
 *    隐式宽恕——那会把越权 404 和真的不存在混为一谈（服务端刻意让二者同形）。
 */
import type { ChatAccepted, JobSnapshot, UsageSnapshot, WireJob } from './types.js'

/** 服务端返回的业务错误（非 2xx）。 */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 401 —— 凭据缺失/失效。前端据此提示重新输入 key。 */
export class UnauthorizedError extends ApiError {
  constructor(message = 'unauthorized') {
    super(401, message)
    this.name = 'UnauthorizedError'
  }
}

/**
 * key 的存放策略（plan T10 注记：**敏感 key 不在 localStorage 明文长期驻留**）。
 *
 * 这里只存在**内存**里（模块级变量）：刷新页面即需重输。
 * - 优点：不落盘、XSS 也偷不走"持久化"的凭据；
 * - 代价：刷新要重新贴 key —— 内网值班台可接受（且比长期驻留安全）。
 *
 * 若日后要"记住我"，应改为服务端下发 `HttpOnly` cookie 会话，而非把 key
 * 写进 localStorage（那里是 XSS 的首选目标）。
 */
let apiKey: string | null = null

export function setApiKey(key: string | null): void {
  apiKey = key !== null && key.trim().length > 0 ? key.trim() : null
}

export function getApiKey(): string | null {
  return apiKey
}

/** 构造请求头：有 key 就带 `Authorization`。 */
export function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  if (apiKey !== null) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const headers = buildHeaders(
    init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
  )

  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  })

  if (res.status === 401) {
    throw new UnauthorizedError()
  }
  if (!res.ok) {
    // 尽量把服务端的 `{ error }` 文案带出来，便于值班员/排障看到原因
    let detail = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: unknown }
      if (typeof body.error === 'string') detail = body.error
    } catch {
      /* 响应体不是 JSON（如 502 的 HTML 错误页）——保留状态码即可 */
    }
    throw new ApiError(res.status, detail)
  }

  return (await res.json()) as T
}

/**
 * 发起新调查，或带 `sessionId` **续聊追问**（G2）。
 *
 * 注意：**不传 userId**。提交者由服务端从鉴权头解析（T6 口径）——
 * 前端塞 userId 既不生效、也不该尝试。
 */
export async function postChat(input: {
  message: string
  sessionId?: string
}): Promise<ChatAccepted> {
  const body: Record<string, unknown> = { message: input.message }
  if (input.sessionId !== undefined && input.sessionId.length > 0) {
    body.sessionId = input.sessionId
  }
  return request<ChatAccepted>('/chat', { method: 'POST', body })
}

/** 取 job 状态快照 + 事件（`after` 用于增量拉取，SSE 断线重连的兜底路径）。 */
export async function getJob(jobId: string, after?: number): Promise<JobSnapshot> {
  const qs = after !== undefined && after > 0 ? `?after=${after}` : ''
  return request<JobSnapshot>(`/jobs/${encodeURIComponent(jobId)}${qs}`)
}

/** 列出 job（`userId` 由服务端从鉴权头注入过滤，"只看我的"无需前端传参）。 */
export async function listJobs(filter?: {
  status?: string
  limit?: number
}): Promise<WireJob[]> {
  const params = new URLSearchParams()
  if (filter?.status !== undefined) params.set('status', filter.status)
  if (filter?.limit !== undefined) params.set('limit', String(filter.limit))
  const qs = params.toString()
  const body = await request<{ jobs: WireJob[] }>(`/jobs${qs.length > 0 ? `?${qs}` : ''}`)
  return body.jobs
}

/**
 * 取用量 / 审计账本（T7）。
 *
 * 返回值同时含**明细**与**服务端全量聚合** —— 前者用于表格，后者用于顶部统计卡。
 * 前端**不要**自己从 `events` 累加统计数字：`events` 受 `limit` 截断，
 * 自行累加会得到一个"随分页变化的假总数"。见 `types.ts` 的 `WireUsageSummary`。
 *
 * `userId` 同 `/jobs`：由服务端从鉴权头注入，前端不传、也传不了。
 */
export async function getUsage(filter?: {
  jobId?: string
  limit?: number
}): Promise<UsageSnapshot> {
  const params = new URLSearchParams()
  if (filter?.jobId !== undefined) params.set('jobId', filter.jobId)
  if (filter?.limit !== undefined) params.set('limit', String(filter.limit))
  const qs = params.toString()
  return request<UsageSnapshot>(`/usage${qs.length > 0 ? `?${qs}` : ''}`)
}
