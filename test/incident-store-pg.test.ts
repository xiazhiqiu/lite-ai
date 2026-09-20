/**
 * IncidentStore / DedupeStore 契约测试（T12）——**PG 实现**。
 *
 * 复用 `helpers/incident-store-contract.ts` 的同一组断言（"两种实现语义等价"的机器化证明）。
 *
 * 无 PG 时**跳过集成测试而非失败**（plan G6 策略一致），
 * 但跨实例关联语义已由内存实现覆盖（`incident-store.test.ts`），不会被漏掉。
 *
 * 启用方式：设置 `DATABASE_URL`（或 `PG*`）后跑本文件。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePgConfigFromEnv, createPgPool, closePgPool } from '../src/db/pool.js'
import { migrate } from '../src/db/migrate.js'
import { createPgIncidentStore, createPgDedupeStore } from '../src/incident/pg-store.js'
import { runIncidentStoreContract, contractRecord } from './helpers/incident-store-contract.js'

const pgConfig = resolvePgConfigFromEnv()

if (pgConfig === null) {
  describe('IncidentStore contract (PG)', () => {
    it('skipped: no DATABASE_URL / PG* env configured', ctx => {
      ctx.skip('未配置 PG 连接，跳过（跨实例关联语义已由内存实现覆盖）')
    })
  })
} else {
  const pool = createPgPool(pgConfig)

  before(async () => {
    await migrate(pool)
  })

  after(async () => {
    await pool.query('TRUNCATE incidents, incident_members, alert_dedupe CASCADE')
    await closePgPool()
  })

  const reset = async (): Promise<void> => {
    await pool.query('TRUNCATE incidents, incident_members, alert_dedupe CASCADE')
  }

  runIncidentStoreContract(
    'pg',
    () => ({
      incident: createPgIncidentStore(pool),
      dedupe: createPgDedupeStore(pool),
    }),
    reset,
  )

  // ---- PG 特有验证：SQL 层语义（内存实现无法覆盖）----
  describe('PG-specific SQL semantics', () => {
    before(async () => {
      await reset()
    })

    it('部分唯一索引：同一 (key_name, group_key) 的第二个 open 事件被拒绝', async () => {
      const store = createPgIncidentStore(pool)
      const first = contractRecord('inc-a', 'service=pay', ['m1'])
      const second = contractRecord('inc-b', 'service=pay', ['m2'])

      await store.commit({ created: [first], updated: [], deleted: [], memberUpserts: [] })
      // 第二个同键 open 事件：应被唯一索引拒绝（实现里忽略冲突，不抛错）
      await store.commit({ created: [second], updated: [], deleted: [], memberUpserts: [] })

      const snap = await store.loadAll()
      const keys = [...snap.byId.values()].map(r => r.groupKey)
      assert.equal(
        keys.filter(k => k === 'service=pay').length,
        1,
        `同键 open 事件只能有一个（防多实例重复建事件），实际 ${keys.length} 个`,
      )
    })

    it('check 的单条语句原子性：并发 check 只有一个看到 null', async () => {
      const store = createPgDedupeStore(pool)
      await reset()
      // 10 个并发调用同一 alertId：应恰好 1 个看到 null（首次），其余看到旧值。
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.check('race-1', { hash: `h${i}`, firstSeen: 1000 + i }),
        ),
      )
      const nullCount = results.filter(r => r === null).length
      assert.equal(
        nullCount,
        1,
        `并发 check 应恰好 1 个看到 null（否则去重失效、重复诊断），实际 ${nullCount}`,
      )
    })

    it('成员明细被真正写入 incident_members（可回查）', async () => {
      await reset()
      const store = createPgIncidentStore(pool)
      await store.commit({
        created: [contractRecord('inc-m', 'service=cart', ['x1', 'x2', 'x3'])],
        updated: [],
        deleted: [],
        memberUpserts: [],
      })
      const { rows } = await pool.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM incident_members WHERE incident_id = $1',
        ['inc-m'],
      )
      assert.equal(rows[0]!.n, '3', '3 个成员应落库')
    })

    it('删除事件级联删除成员（ON DELETE CASCADE）', async () => {
      await reset()
      const store = createPgIncidentStore(pool)
      await store.commit({
        created: [contractRecord('inc-c', 'service=search', ['y1'])],
        updated: [],
        deleted: [],
        memberUpserts: [],
      })
      await store.commit({ created: [], updated: [], deleted: ['inc-c'], memberUpserts: [] })
      const { rows } = await pool.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM incident_members WHERE incident_id = $1',
        ['inc-c'],
      )
      assert.equal(rows[0]!.n, '0', '级联删除应清掉成员')
    })
  })
}
