/**
 * JobStore 内存实现（T2，plan G6）。
 *
 * 三处用途：
 * 1. **单测**——让并发 claim / stale 语义在无 PG 环境下可被真实证明（不 skip）。
 * 2. **CLI / 单进程 webhook 形态**——无需 DB 即可跑，保持既有行为零变化。
 * 3. **PG 实现的语义基准**——两者跑同一组契约测试（`test/jobs-claim.test.ts`）。
 *
 * 并发语义如何保证（Node 单线程 + 零 await 的临界区）：
 * `claim()` 里"扫描 pending → 标记 running"这一段**是同一次事件循环 tick 内的同步代码**
 * （`jobs` 是内存 Map，无 IO）。JS 不会在同步代码中间切换协程，因此不存在交错窗口——
 * 这正是 PG 实现里必须靠 `FOR UPDATE SKIP LOCKED` 显式达成的同一件事。
 * 一旦有人在这里插入 `await`，互斥即刻失效——**这是本文件最脆弱的约束**。
 */
import { randomUUID } from 'node:crypto'
import type { ClaimOptions, JobStore, ListJobsFilter } from './store.js'
import type { Job, JobEvent, JobStatus, NewJob } from './types.js'

export function createMemoryJobStore(): JobStore {
  const jobs = new Map<string, Job>()
  const events = new Map<string, JobEvent[]>()
  const now = (t?: number): number => t ?? Date.now()

  /** 事件序号：取该 job 现有的最大 seq + 1（同步，无交错风险）。 */
  const nextSeq = (jobId: string): number => {
    const list = events.get(jobId)
    return list === undefined || list.length === 0 ? 1 : list[list.length - 1]!.seq + 1
  }

  const clone = (job: Job): Job => ({ ...job, payload: { ...job.payload } })

  return {
    async create(input: NewJob, at?: number): Promise<Job> {
      const ts = now(at)
      const job: Job = {
        id: `job-${randomUUID()}`,
        userId: input.userId,
        cwd: input.cwd,
        kind: input.kind,
        incidentId: input.incidentId ?? null,
        sessionId: input.sessionId ?? null,
        payload: { ...(input.payload ?? {}) },
        status: 'pending',
        assignee: null,
        requestSeq: 0,
        claimedAt: null,
        finishedAt: null,
        error: null,
        createdAt: ts,
        updatedAt: ts,
      }
      jobs.set(job.id, job)
      return clone(job)
    },

    async claim(opts: ClaimOptions, at?: number): Promise<Job[]> {
      const ts = now(at)
      const limit = opts.limit ?? 1
      // ↓↓↓ 临界区：本段必须全程同步（无 await），否则互斥失效 ↓↓↓
      const candidates = [...jobs.values()]
        .filter(job => job.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit)

      const claimed: Job[] = []
      for (const job of candidates) {
        job.status = 'running'
        job.assignee = opts.assignee
        job.claimedAt = ts
        job.updatedAt = ts
        job.requestSeq += 1
        claimed.push(clone(job))
      }
      // ↑↑↑ 临界区结束 ↑↑↑
      return claimed
    },

    async reassignStale(leaseMs: number, at?: number): Promise<Job[]> {
      const ts = now(at)
      // 临界区：同上，全程同步
      const stale = [...jobs.values()].filter(
        job =>
          job.status === 'running' &&
          job.claimedAt !== null &&
          job.claimedAt < ts - leaseMs,
      )
      for (const job of stale) {
        // 保留 assignee/claimedAt 供排查"哪个实例挂了"；重新认领时会覆盖
        job.status = 'pending'
        job.updatedAt = ts
      }
      return stale.map(clone)
    },

    async get(id: string): Promise<Job | null> {
      const job = jobs.get(id)
      return job === undefined ? null : clone(job)
    },

    async finish(
      id: string,
      status: Extract<JobStatus, 'completed' | 'failed'>,
      opts?: { error?: string | null; now?: number },
    ): Promise<boolean> {
      const job = jobs.get(id)
      if (job === undefined) return false
      // 仅允许从 running 落终态（pending 直接 finish 视为非法，不改状态）
      if (job.status !== 'running') return false
      const ts = now(opts?.now)
      job.status = status
      job.finishedAt = ts
      job.updatedAt = ts
      job.error = opts?.error ?? null
      return true
    },

    async list(filter?: ListJobsFilter): Promise<Job[]> {
      let result = [...jobs.values()]
      if (filter?.userId !== undefined) result = result.filter(j => j.userId === filter.userId)
      if (filter?.status !== undefined) result = result.filter(j => j.status === filter.status)
      if (filter?.incidentId !== undefined) {
        result = result.filter(j => j.incidentId === filter.incidentId)
      }
      if (filter?.sessionId !== undefined) {
        result = result.filter(j => j.sessionId === filter.sessionId)
      }
      result.sort((a, b) => b.createdAt - a.createdAt)
      return result.slice(0, filter?.limit ?? result.length).map(clone)
    },

    async appendEvent(
      jobId: string,
      kind: string,
      payload: Record<string, unknown>,
      at?: number,
    ): Promise<JobEvent> {
      const event: JobEvent = {
        jobId,
        seq: nextSeq(jobId),
        kind,
        payload: { ...payload },
        createdAt: now(at),
      }
      const list = events.get(jobId)
      if (list === undefined) events.set(jobId, [event])
      else list.push(event)
      return { ...event, payload: { ...event.payload } }
    },

    async listEvents(jobId: string, afterSeq = 0): Promise<JobEvent[]> {
      const list = events.get(jobId) ?? []
      return list
        .filter(event => event.seq > afterSeq)
        .map(event => ({ ...event, payload: { ...event.payload } }))
    },

    /**
     * 批量追加（T5）。整段同步无 await —— 保证一批的 seq 连续、不与他批交错。
     * 但**先全量构造再一次性 push**：避免中途抛错造成"半批写入"。
     */
    async appendEvents(
      jobId: string,
      entries: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>,
      at?: number,
    ): Promise<JobEvent[]> {
      if (entries.length === 0) return []
      const base = nextSeq(jobId)
      const ts = now(at)
      // 构造阶段不触碰存储：任一条构造失败都不会留下半批。
      const batch: JobEvent[] = entries.map((entry, index) => ({
        jobId,
        seq: base + index,
        kind: entry.kind,
        payload: { ...entry.payload },
        createdAt: ts,
      }))
      const list = events.get(jobId)
      if (list === undefined) events.set(jobId, [...batch])
      else list.push(...batch)
      return batch.map(event => ({ ...event, payload: { ...event.payload } }))
    },
  }
}
