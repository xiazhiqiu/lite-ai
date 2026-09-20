/**
 * JobStore 契约测试（T2）——**PG 实现**。
 *
 * **复用 `helpers/job-store-contract.ts` 的同一组断言**——这是"两种实现语义等价"
 * 的机器化证明，而不是靠人肉比对两份代码。
 *
 * 无 PG 时的策略（plan G6 明确要求）：
 * - **跳过集成测试，而不是失败**——CI 里没有 PG 不该让整个基线变红。
 * - 但并发正确性**不能被跳过**：它已由 `jobs-claim.test.ts` 的内存实现覆盖
 *   （那组断言不依赖 PG）。PG 路径额外验证"SQL 语句本身写对了"。
 *
 * 启用方式：设置 `DATABASE_URL`（或 `PG*`）后跑本文件即可。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePgConfigFromEnv, createPgPool, closePgPool } from '../src/db/pool.js'
import { migrate } from '../src/db/migrate.js'
import { createPgJobStore } from '../src/jobs/pg-store.js'
import { runJobStoreContract } from './helpers/job-store-contract.js'

const pgConfig = resolvePgConfigFromEnv()

if (pgConfig === null) {
  describe('JobStore contract (PG)', () => {
    it('skipped: no DATABASE_URL / PG* env configured', ctx => {
      ctx.skip('未配置 PG 连接，跳过（并发语义已由内存实现覆盖）')
    })
  })
} else {
  const pool = createPgPool(pgConfig)

  before(async () => {
    await migrate(pool)
  })

  after(async () => {
    await pool.query('TRUNCATE jobs, job_events CASCADE')
    await closePgPool()
  })

  // 每个用例前清表：契约用例之间互不干扰。
  // `reset` 由契约 helper 通过鸭子类型探测调用（内存实现没有该方法）。
  const makeStore = () => {
    const store = createPgJobStore(pool)
    const reset = async (): Promise<void> => {
      await pool.query('TRUNCATE jobs, job_events CASCADE')
    }
    // 把 reset 挂在 store 上，让契约 helper 的 beforeEach 能取到
    return Object.assign(store, { reset })
  }

  runJobStoreContract('pg', makeStore)

  // ---- PG 特有的验证：SQL 层语义（内存实现无法覆盖） ----
  describe('PG-specific SQL semantics', () => {
    before(async () => {
      await pool.query('TRUNCATE jobs, job_events CASCADE')
    })

    it('claim_jobs is a single atomic statement (no pending/running double-assign)', async () => {
      const store = createPgJobStore(pool)
      await pool.query('TRUNCATE jobs, job_events CASCADE')
      for (let i = 0; i < 8; i++) {
        await store.create({ userId: 'u', cwd: '/w', kind: 'chat' }, 1000 + i)
      }

      // 8 个并发 claim，每个抢 2 条 → 至多 8 条被分配，且无重复
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.claim({ assignee: `w${i}`, limit: 2 })),
      )
      const ids = results.flat().map(j => j.id)
      assert.equal(new Set(ids).size, ids.length, '原子 claim 把同一 job 分配给了多人')
      assert.equal(ids.length, 8)
    })

    it('reassign_stale_jobs leaves terminal rows untouched', async () => {
      const store = createPgJobStore(pool)
      await pool.query('TRUNCATE jobs, job_events CASCADE')
      const a = await store.create({ userId: 'u', cwd: '/w', kind: 'chat' }, 1000)
      await store.claim({ assignee: 'w1' }, 2000)
      await store.finish(a.id, 'completed', { now: 2500 })

      // 把 claimed_at 手动推旧，验证终态仍不被打回
      await pool.query('UPDATE jobs SET claimed_at = 1 WHERE id = $1', [a.id])
      const swept = await store.reassignStale(1000)
      assert.equal(swept.length, 0)
      assert.equal((await store.get(a.id))!.status, 'completed')
    })

    it('job_events seq is scoped per job and starts at 1 independently', async () => {
      const store = createPgJobStore(pool)
      await pool.query('TRUNCATE jobs, job_events CASCADE')
      const a = await store.create({ userId: 'u', cwd: '/w', kind: 'chat' }, 1000)
      const b = await store.create({ userId: 'u', cwd: '/w', kind: 'chat' }, 1001)

      assert.equal((await store.appendEvent(a.id, 'x', {}, 1100)).seq, 1)
      assert.equal((await store.appendEvent(a.id, 'x', {}, 1101)).seq, 2)
      // 另一个 job 的 seq 独立从 1 开始
      assert.equal((await store.appendEvent(b.id, 'y', {}, 1102)).seq, 1)
    })

    it('migrate is idempotent and creates all seven tables', async () => {
      await migrate(pool)
      await migrate(pool)
      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('incidents','incident_members','alert_dedupe',
                               'jobs','job_events','sessions','usage_events')
          ORDER BY table_name`,
      )
      assert.deepEqual(
        rows.map(r => r.table_name),
        ['alert_dedupe', 'incident_members', 'incidents', 'job_events', 'jobs', 'sessions', 'usage_events'],
      )
    })
  })
}
