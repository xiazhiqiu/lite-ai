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
 * job 事件类型 —— 由 `src/jobs/exec.ts` 的回调决定。
 * 后端新增 kind 时这里补一行即可；未知 kind 前端按"通用事件"渲染（见 InvestigationStream）。
 */
export const EVENT_KINDS = {
  toolStart: 'tool_start',
  toolResult: 'tool_result',
  assistantMessage: 'assistant_message',
} as const

/** 判断 job 是否处于可继续接收事件的活跃态。 */
export function isActive(status: JobStatus): boolean {
  return status === 'pending' || status === 'running'
}

/** 判断 job 是否终态（SSE 到终态即收流，不再等待）。 */
export function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed'
}
