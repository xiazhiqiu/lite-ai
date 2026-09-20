/**
 * JobStore 的 PG 实现（T2）。
 *
 * 与 `memory-store.ts` **语义等价**，通过同一组契约测试（`test/jobs-claim.test.ts`
 * 导出的 `runJobStoreContract`）。
 *
 * 唯一的关键差异：**原子 claim 必须靠 SQL 语句达成**，而不是靠"单线程临界区"。
 * `schema.sql` 里的 `claim_jobs()` 用 CTE + `FOR UPDATE SKIP LOCKED` 把
 * "选待办"与"标记认领"合成**一条语句**——若拆成 SELECT 再 UPDATE，两者之间的
 * 窗口期会让两个 worker 读到同一批 pending（这正是内存实现不需要担心、
 * 但多进程必须显式处理的问题）。
 */
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { ClaimOptions, JobStore, ListJobsFilter } from './store.js'
import type { Job, JobEvent, JobStatus, NewJob } from './types.js'

/** jobs 表的行形态（snake_case → camelCase 在这里收口）。 */
type JobRow = {
  id: string
  user_id: string
  cwd: string
  kind: string
  incident_id: string | null
  session_id: string | null
  payload: Record<string, unknown>
  status: string
  assignee: string | null
  request_seq: number | string
  claimed_at: string | number | null
  finished_at: string | number | null
  error: string | null
  created_at: string | number
  updated_at: string | number
}

type EventRow = {
  job_id: string
  seq: number | string
  kind: string
  payload: Record<string, unknown>
  created_at: string | number
}

/**
 * BIGINT 经 pg 驱动返回**字符串**（防 JS 精度丢失），这里统一转 number。
 * 时间戳是毫秒级（1.7e12 << 2^53），转 number 安全。
 */
function toNumber(value: string | number | null): number | null {
  if (value === null) return null
  return typeof value === 'number' ? value : Number(value)
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    userId: row.user_id,
    cwd: row.cwd,
    kind: row.kind as Job['kind'],
    incidentId: row.incident_id,
    sessionId: row.session_id,
    payload: row.payload ?? {},
    status: row.status as JobStatus,
    assignee: row.assignee,
    requestSeq: toNumber(row.request_seq) ?? 0,
    claimedAt: toNumber(row.claimed_at),
    finishedAt: toNumber(row.finished_at),
    error: row.error,
    createdAt: toNumber(row.created_at) ?? 0,
    updatedAt: toNumber(row.updated_at) ?? 0,
  }
}

function toEvent(row: EventRow): JobEvent {
  return {
    jobId: row.job_id,
    seq: toNumber(row.seq) ?? 0,
    kind: row.kind,
    payload: row.payload ?? {},
    createdAt: toNumber(row.created_at) ?? 0,
  }
}

export function createPgJobStore(pool: pg.Pool): JobStore {
  const now = (t?: number): number => t ?? Date.now()

  return {
    async create(input: NewJob, at?: number): Promise<Job> {
      const ts = now(at)
      const { rows } = await pool.query<JobRow>(
        `INSERT INTO jobs (id, user_id, cwd, kind, incident_id, session_id, payload,
                           status, request_seq, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', 0, $8, $8)
         RETURNING *`,
        [
          `job-${randomUUID()}`,
          input.userId,
          input.cwd,
          input.kind,
          input.incidentId ?? null,
          input.sessionId ?? null,
          JSON.stringify(input.payload ?? {}),
          ts,
        ],
      )
      return toJob(rows[0]!)
    },

    async claim(opts: ClaimOptions, at?: number): Promise<Job[]> {
      // 时间戳由 SQL 内 clock_timestamp() 决定（见 schema.sql），保证与
      // stale 判定同一时钟源，不受应用进程时钟漂移影响。
      // `at` 参数保留仅为与内存实现签名一致；PG 路径下以库时钟为准。
      void now(at)
      const { rows } = await pool.query<JobRow>(
        'SELECT * FROM claim_jobs($1, $2)',
        [opts.assignee, opts.limit ?? 1],
      )
      return rows.map(toJob)
    },

    async reassignStale(leaseMs: number, at?: number): Promise<Job[]> {
      void now(at)
      const { rows } = await pool.query<JobRow>(
        'SELECT * FROM reassign_stale_jobs($1)',
        [leaseMs],
      )
      return rows.map(toJob)
    },

    async get(id: string): Promise<Job | null> {
      const { rows } = await pool.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id])
      return rows.length === 0 ? null : toJob(rows[0]!)
    },

    async finish(
      id: string,
      status: Extract<JobStatus, 'completed' | 'failed'>,
      opts?: { error?: string | null; now?: number },
    ): Promise<boolean> {
      // 只允许从 running 落终态：与内存实现同语义（pending 直接 finish 非法）。
      const { rowCount } = await pool.query(
        `UPDATE jobs
            SET status = $2, finished_at = $3, updated_at = $3, error = $4
          WHERE id = $1 AND status = 'running'`,
        [id, status, now(opts?.now), opts?.error ?? null],
      )
      return (rowCount ?? 0) > 0
    },

    async list(filter?: ListJobsFilter): Promise<Job[]> {
      const where: string[] = []
      const params: unknown[] = []
      const push = (clause: string, value: unknown): void => {
        params.push(value)
        where.push(clause.replace('?', `$${params.length}`))
      }
      if (filter?.userId !== undefined) push('user_id = ?', filter.userId)
      if (filter?.status !== undefined) push('status = ?', filter.status)
      if (filter?.incidentId !== undefined) push('incident_id = ?', filter.incidentId)
      if (filter?.sessionId !== undefined) push('session_id = ?', filter.sessionId)

      const limit = filter?.limit ?? 100
      params.push(limit)
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs
         ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params,
      )
      return rows.map(toJob)
    },

    async appendEvent(
      jobId: string,
      kind: string,
      payload: Record<string, unknown>,
      at?: number,
    ): Promise<JobEvent> {
      // seq 由 `COALESCE(MAX(seq), 0) + 1` 在**单条语句内**算出。
      // 并发写同一 job 时，(job_id, seq) 主键会拒绝重复——调用方重试即可。
      // 之所以不用序列：seq 要求**按 job 作用域**从 1 开始（SSE Last-Event-ID 语义）。
      const { rows } = await pool.query<EventRow>(
        `INSERT INTO job_events (job_id, seq, kind, payload, created_at)
         VALUES (
           $1,
           COALESCE((SELECT MAX(seq) FROM job_events WHERE job_id = $1), 0) + 1,
           $2, $3::jsonb, $4
         )
         RETURNING *`,
        [jobId, kind, JSON.stringify(payload), now(at)],
      )
      return toEvent(rows[0]!)
    },

    async listEvents(jobId: string, afterSeq = 0): Promise<JobEvent[]> {
      const { rows } = await pool.query<EventRow>(
        `SELECT * FROM job_events
          WHERE job_id = $1 AND seq > $2
          ORDER BY seq`,
        [jobId, afterSeq],
      )
      return rows.map(toEvent)
    },

    /**
     * 批量追加（T5）：一条 `INSERT ... SELECT` 写完整批。
     *
     * 为什么必须是**单条语句**：seq 靠 `MAX(seq)+1` 现算，若逐条 INSERT，
     * 中间会有别的写者插入（并发 append 同一 job）→ 整批 seq 被打散，
     * 且并发下 `(job_id, seq)` 主键冲突导致部分成功（半批写入）。
     *
     * 用 `generate_series` + `row_number()` 在**一条语句的同一快照**里算出连续 seq，
     * `unnest` 展开 kind/payload。整条语句是原子的：要么全写入，要么一条都不写。
     */
    async appendEvents(
      jobId: string,
      entries: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>,
      at?: number,
    ): Promise<JobEvent[]> {
      if (entries.length === 0) return []
      const kinds = entries.map(e => e.kind)
      const payloads = entries.map(e => JSON.stringify(e.payload))
      const { rows } = await pool.query<EventRow>(
        `WITH base AS (
           SELECT COALESCE((SELECT MAX(seq) FROM job_events WHERE job_id = $1), 0) AS max_seq
         ), input AS (
           SELECT kind, payload, ordinality
             FROM unnest($2::text[], $3::jsonb[]) WITH ORDINALITY AS t(kind, payload, ordinality)
         )
         INSERT INTO job_events (job_id, seq, kind, payload, created_at)
         SELECT $1, base.max_seq + input.ordinality, input.kind, input.payload, $4
           FROM input CROSS JOIN base
         RETURNING *`,
        [jobId, kinds, payloads, now(at)],
      )
      // RETURNING 顺序不保证等于插入顺序 → 显式按 seq 排序，
      // 以满足契约「返回顺序与入参顺序一一对应」。
      return rows.map(toEvent).sort((a, b) => a.seq - b.seq)
    },
  }
}
