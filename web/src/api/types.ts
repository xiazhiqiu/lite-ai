/**
 * 服务端 API 的**线格式类型**（T10）。
 *
 * 与 `src/server/http.ts` 的 `toWireJob` / `toWireEvent` **逐字段对齐**。
 * 这些类型是前后端唯一契约面：服务端改了字段名，这里必须同步；否则运行时
 * 静默拿到 `undefined`（TS 拦不住，因为 JSON.parse 的返回是 `unknown`）。
 *
 * 字段名沿用服务端输出（`userId` / `sessionId` / `createdAt`…），不做 camelCase
 * 转换——多一层映射只会多一处可能对不上的地方。
 */

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

/** 对齐 `toWireJob`（server/http.ts）。 */
export type WireJob = {
  id: string
  userId: string
  kind: 'chat' | 'alert' | 'resolve'
  status: JobStatus
  sessionId: string | null
  incidentId: string | null
  assignee: string | null
  error: string | null
  /**
   * 一行摘要（服务端从 payload 裁剪出的字符串，非整个 payload）。
   * 老版本服务端可能没有此字段 → 可为 null，前端自行兜底。
   */
  summary?: string | null
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}

/**
 * 对齐 `toWireSession`（server/http.ts）—— `GET /sessions` 的返回项。
 *
 * 与 `WireJob` 的关键区别：会话是**跨多轮**的容器（追问两轮 = 一个会话、两条 job），
 * 而 `WireJob` 是单次执行。值班台的左侧栏应按会话分组，而不是按 job 平铺。
 */
export type WireSession = {
  id: string
  /** `null` = 还没起名（刻意区别于空串），前端自行兜底成占位标题。 */
  title: string | null
  messageCount: number
  updatedAt: number
}

/** 对齐 `toWireEvent`（server/http.ts）。 */
export type WireEvent = {
  seq: number
  kind: string
  payload: Record<string, unknown>
  createdAt: number
}

/** `GET /jobs/:id` 响应体。 */
export type JobSnapshot = {
  job: WireJob
  events: WireEvent[]
}

/** `POST /chat` 响应体（202 Accepted）。 */
export type ChatAccepted = {
  jobId: string
  sessionId: string
}

/**
 * 用量 / 审计明细行 —— 对齐 `toWireUsage`（server/http.ts）。
 *
 * 与 `WireJob` 的**关键区别**：这些数字来自 `usage_events` 账本（T7），
 * 是服务端在执行期**实测**出来的，不是从 job 时间戳推导的近似值。
 */
export type WireUsageEvent = {
  id: number
  jobId: string | null
  sessionId: string | null
  traceId: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
  durationMs: number | null
  status: string | null
  createdAt: number
}

/**
 * 服务端全量聚合（`UsageStore.summarize`）。
 *
 * **注意**：这个 summary **不受 `limit` 影响** —— 它是账本的全量口径。
 * 前端**不得**用本页 `events` 自行累加来替代它（那样数字会随分页变化）。
 */
export type WireUsageSummary = {
  total: number
  completed: number
  failed: number
  inputTokens: number
  outputTokens: number
  avgDurationMs: number | null
}

/** `GET /usage` 响应体。 */
export type UsageSnapshot = {
  events: WireUsageEvent[]
  summary: WireUsageSummary
}

/**
 * job 事件类型 —— 由 `src/jobs/exec.ts` 的回调决定。
 * 后端新增 kind 时这里补一行即可；未知 kind 前端按"通用事件"渲染（见 InvestigationStream）。
 */
export const EVENT_KINDS = {
  toolStart: 'tool_start',
  toolResult: 'tool_result',
  assistantMessage: 'assistant_message',
  /** 【T55】上下文压缩（L1 snip / L2 collapse / L3 compact），由 exec.ts 透出。 */
  contextCompacted: 'context_compacted',
} as const

/** 判断 job 是否处于可继续接收事件的活跃态。 */
export function isActive(status: JobStatus): boolean {
  return status === 'pending' || status === 'running'
}

/** 判断 job 是否终态（SSE 到终态即收流，不再等待）。 */
export function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed'
}
