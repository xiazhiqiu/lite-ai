/**
 * 异步 job 队列的类型模型（T2）。
 *
 * 定位：把「一次待执行的调查」抽象成可持久化、可跨进程竞争认领的 job。
 * 与 `session.ts` 的会话不是一回事——session 是**对话历史**，job 是**一次执行**。
 * 二者多对一：同一 session 可以有多个 job（多轮对话 = 多个 job 续接同一 session）。
 */

/** job 生命周期：pending → running → completed | failed。 */
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

/**
 * job 类别：
 * - `chat`    人工对话（值班台发起 / 续聊追问）
 * - `alert`   告警诊断（`IngestPipeline` 入队，关联 incident）
 * - `resolve` 源侧恢复收敛（**不走 RCA**，只关事件、不烧 token）
 */
export type JobKind = 'chat' | 'alert' | 'resolve'

export type Job = {
  id: string
  /** 提交者。per-user 隔离的基础（T6）。 */
  userId: string
  /** 服务端工作区路径（**不是**用户本地目录，见 plan G4）。 */
  cwd: string
  kind: JobKind
  /** 告警类 job 关联的 incident；人工对话为 null。 */
  incidentId: string | null
  /** 续聊目标会话 id；null = 新建会话（G2）。 */
  sessionId: string | null
  payload: Record<string, unknown>
  status: JobStatus
  /** 认领该 job 的 worker 标识。 */
  assignee: string | null
  /**
   * 乐观并发守卫（对齐 HolmesGPT `request_sequence`）。
   * 每次 claim / 状态更新递增；调用方带旧值更新时若不匹配则视为已被抢占。
   */
  requestSeq: number
  claimedAt: number | null
  finishedAt: number | null
  error: string | null
  createdAt: number
  updatedAt: number
}

/** 新建 job 的入参（id/status/时间戳由 store 生成）。 */
export type NewJob = {
  userId: string
  cwd: string
  kind: JobKind
  incidentId?: string | null
  sessionId?: string | null
  payload?: Record<string, unknown>
}

/** job 事件流的一行（SSE / 轮询的数据源）。 */
export type JobEvent = {
  jobId: string
  /** 单调递增序号；SSE `Last-Event-ID` 与 `?after=` 增量拉取都基于它。 */
  seq: number
  kind: string
  payload: Record<string, unknown>
  createdAt: number
}
