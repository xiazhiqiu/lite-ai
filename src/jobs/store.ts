/**
 * JobStore 接口（T2）。
 *
 * 这是**队列存储的 seam**，与 T1 的 `SessionStore` 同思路：
 * 上层（HTTP 层 / Worker）只依赖此接口，PG 实现与内存假实现可互换。
 *
 * 为什么要有内存实现（plan G6）：
 * claim / reassign 的**并发正确性**正是选异步队列的全部理由，不能因为 CI 里没有
 * PG 就把它跳掉。内存实现让「并发 claim 不重复分配」「stale 回收」这两个核心语义
 * 可以在无 PG 环境下被自动化测试**真实证明**，而不是 skip 掉假装通过。
 */
import type { Job, JobEvent, JobStatus, NewJob } from './types.js'

/** claim 的入参。 */
export type ClaimOptions = {
  /** worker 标识，写入 `assignee`。 */
  assignee: string
  /** 单次最多认领几条（防一个 worker 独吞整批）。 */
  limit?: number
}

/** 列出 job 的过滤条件（per-user 隔离 + 前端列表页）。 */
export type ListJobsFilter = {
  userId?: string
  status?: JobStatus
  incidentId?: string
  sessionId?: string
  limit?: number
}

export type JobStore = {
  /**
   * 创建 job（状态 `pending`）。返回落库后的完整 job。
   * @param now 注入时钟（测试用；缺省 `Date.now`）
   */
  create(input: NewJob, now?: number): Promise<Job>

  /**
   * **原子**认领至多 `limit` 条 pending job，标记为 running 并写 assignee/claimedAt。
   *
   * 契约（并发安全的定义）：
   * 1. 同一个 job 在任意时刻**只可能被一个调用方**认领成功——不论多少调用方
   *    同时调用、也不论它们是否跨进程。
   * 2. 认领按 `createdAt` 升序（先来先服务）。
   * 3. 认领同时把 `requestSeq` 递增（乐观并发守卫）。
   * 4. 无 pending 时返回 `[]`，不是错误。
   */
  claim(opts: ClaimOptions, now?: number): Promise<Job[]>

  /**
   * 把 `claimedAt < now - leaseMs` 的 running job 打回 pending（**故障转移**）。
   *
   * 这是"值班机挂了任务不能废"的解：worker 崩溃后来不及写终态，job 会永远卡在
   * running；stale sweep 把它释放回 pending，别的实例即可重新认领。
   *
   * 契约：已 `completed` / `failed` 的 job **不受影响**（终态不可回退）。
   * @returns 被回收的 job 列表
   */
  reassignStale(leaseMs: number, now?: number): Promise<Job[]>

  /** 按 id 取 job；不存在返回 null。 */
  get(id: string): Promise<Job | null>

  /** 条件更新：仅当 job 仍处 `expectStatus` 时写入 `status`（+ 可选 error）。 */
  finish(
    id: string,
    status: Extract<JobStatus, 'completed' | 'failed'>,
    opts?: { error?: string | null; now?: number },
  ): Promise<boolean>

  list(filter?: ListJobsFilter): Promise<Job[]>

  /**
   * 追加一条 job 事件。
   * @returns 落库后的事件（含分配的 `seq`）
   */
  appendEvent(
    jobId: string,
    kind: string,
    payload: Record<string, unknown>,
    now?: number,
  ): Promise<JobEvent>

  /** 取事件增量：`seq > afterSeq`，按 seq 升序。 */
  listEvents(jobId: string, afterSeq?: number): Promise<JobEvent[]>

  /**
   * **批量**追加事件（T5）。一次 turn 里工具事件可达数百条，逐条 `appendEvent`
   * 会把 DB 往返打成瓶颈（PG 实现下每条都是一次网络往返）。
   *
   * 语义约束：
   * - 返回顺序与入参顺序**一一对应**，`seq` 在同一批内连续递增、且严格大于批前最大 seq。
   * - **原子性**：整批要么都写入，要么都不写。半批写入会让 SSE 客户端拿到
   *   缺号的事件流（`Last-Event-ID` 之后永远等不到那个 seq）。
   * - 可选实现：缺省时调用方应回退到逐条 `appendEvent`。内存/PG 实现均提供。
   */
  appendEvents?(
    jobId: string,
    entries: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>,
    now?: number,
  ): Promise<JobEvent[]>
}
