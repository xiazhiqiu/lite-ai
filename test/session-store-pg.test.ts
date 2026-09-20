/**
 * SessionStore 契约测试（T8）——**PG 实现**。
 *
 * ## 复用 vs PG 特有
 *
 * 主体直接复用 `helpers/session-store-contract.ts` 的**同一组断言** ——
 * 这是"两种实现语义等价"的机器化证明，而不是靠人肉比对两份代码。
 *
 * 后面另有一组 **PG-specific**：验证那些**只有 SQL 形态才有意义**的性质
 * （seq 作用域、并发写入、事件信封完整性），内存/文件形态无从谈起。
 *
 * ## 无 PG 时的策略（对齐 jobs-claim-pg.test.ts，plan G6）
 *
 * **跳过而非失败** —— CI 里没有 PG 不该让基线变红。
 * 会话语义本身已由文件实现的契约跑全覆盖；这里额外验证的是"SQL 写对了没"。
 *
 * 启用：配置 `DATABASE_URL`（或 `PG*`）后跑本文件即可。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePgConfigFromEnv, createPgPool, closePgPool } from '../src/db/pool.js'
import { migrate } from '../src/db/migrate.js'
import { createPgSessionStore } from '../src/session/pg-store.js'
import { runSessionStoreContract } from './helpers/session-store-contract.js'

const pgConfig = resolvePgConfigFromEnv()

if (pgConfig === null) {
  describe('SessionStore contract (PG)', () => {
    it('skipped: no DATABASE_URL / PG* env configured', ctx => {
      ctx.skip('未配置 PG 连接，跳过（会话语义已由文件实现覆盖）')
    })
  })
} else {
  const pool = createPgPool(pgConfig)

  before(async () => {
    await migrate(pool)
  })

  after(async () => {
    await pool.query('TRUNCATE sessions CASCADE')
    await closePgPool()
  })

  const makeStore = () => {
    const store = createPgSessionStore(pool)
    const reset = async (): Promise<void> => {
      await pool.query('TRUNCATE sessions CASCADE')
    }
    return Object.assign(store, { reset })
  }

  runSessionStoreContract('pg', makeStore)

  // ─────────── PG 特有：只有 SQL 形态才谈得上 ───────────

  describe('PG-specific session semantics', () => {
    before(async () => {
      await pool.query('TRUNCATE sessions CASCADE')
    })

    it('seq 按 (cwd, session_id) 作用域各自从 1 递增', async () => {
      const store = createPgSessionStore(pool)
      await pool.query('TRUNCATE sessions CASCADE')
      await store.save('/pg/scope', 'a', [
        { role: 'system', content: 's' },
        { role: 'user', content: 'a1' },
      ])
      await store.save('/pg/scope', 'b', [
        { role: 'system', content: 's' },
        { role: 'user', content: 'b1' },
      ])

      const { rows } = await pool.query<{ session_id: string; seq: number }>(
        `SELECT session_id, seq FROM sessions WHERE cwd = '/pg/scope' ORDER BY session_id, seq`,
      )
      const seqA = rows.filter(r => r.session_id === 'a').map(r => r.seq)
      const seqB = rows.filter(r => r.session_id === 'b').map(r => r.seq)
      // 两个会话的 seq 各自从 1 开始（不是全局自增）
      assert.deepEqual(seqA, [1])
      assert.deepEqual(seqB, [1])
    })

    it('同一会话的 seq 连续（append-only，中间无空洞）', async () => {
      const store = createPgSessionStore(pool)
      await pool.query('TRUNCATE sessions CASCADE')
      const cwd = '/pg/contig'
      for (let i = 0; i < 4; i++) {
        await store.save(cwd, 's', [
          { role: 'system', content: 's' },
          { role: 'user', content: `m${i}` },
        ])
      }
      const { rows } = await pool.query<{ seq: number }>(
        `SELECT seq FROM sessions WHERE cwd = $1 ORDER BY seq`,
        [cwd],
      )
      assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4])
    })

    it('event 列保存了完整事件信封（与文件实现的 JSONL 行等价）', async () => {
      const store = createPgSessionStore(pool)
      await pool.query('TRUNCATE sessions CASCADE')
      const cwd = '/pg/envelope'
      await store.save(cwd, 's', [
        { role: 'system', content: 's' },
        { role: 'user', content: 'hello' },
      ])

      const { rows } = await pool.query<{ event: Record<string, unknown> }>(
        `SELECT event FROM sessions WHERE cwd = $1 ORDER BY seq`,
        [cwd],
      )
      const event = rows[0]!.event
      // 信封必须含这些字段 —— 缺任何一个，读路径的重建逻辑都会静默退化
      for (const key of ['type', 'message', 'uuid', 'timestamp', 'sessionId', 'cwd', 'parentUuid']) {
        assert.ok(key in event, `信封缺字段: ${key}`)
      }
      assert.equal(event.type, 'user')
      assert.equal((event.message as { content: string }).content, 'hello')
    })

    it('snip boundary 事件的 parentUuid 为 null，前驱记在 logicalParentUuid', async () => {
      const store = createPgSessionStore(pool)
      await pool.query('TRUNCATE sessions CASCADE')
      const cwd = '/pg/snip'
      await store.save(cwd, 's', [
        { role: 'system', content: 's' },
        { role: 'user', content: 'x' },
      ])
      await store.appendSnipBoundary(cwd, 's', {
        role: 'snip_boundary',
        content: '',
        removedMessageIds: [],
        removedCount: 0,
        tokensFreed: 0,
      } as never)

      const { rows } = await pool.query<{ event: Record<string, unknown> }>(
        `SELECT event FROM sessions WHERE cwd = $1 ORDER BY seq DESC LIMIT 1`,
        [cwd],
      )
      const event = rows[0]!.event
      assert.equal(event.parentUuid, null, 'snip 是旁路事件，不接主链')
      assert.ok(event.logicalParentUuid, '真实前驱应记在 logicalParentUuid')
      assert.ok(event.snipMetadata, 'snipMetadata 必须落库（否则重建逻辑失效）')
    })

    it('migrate 建出的 sessions 表含 event / type 列（schema 未被回滚）', async () => {
      await migrate(pool)
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'sessions' AND column_name IN ('event','type','seq','role','content')
          ORDER BY column_name`,
      )
      assert.deepEqual(
        rows.map(r => r.column_name),
        ['content', 'event', 'role', 'seq', 'type'],
      )
    })

    it('【升级路径】旧表（无 type/event）跑 migrate 后新列被补齐', async () => {
      // 造旧现场：把 T8 新增的两列删掉，模拟 T2 时期投产的库。
      // 这是 `CREATE TABLE IF NOT EXISTS` 覆盖不到的场景 —— upgrade 唯一的守护。
      await pool.query('ALTER TABLE sessions DROP COLUMN IF EXISTS type')
      await pool.query('ALTER TABLE sessions DROP COLUMN IF EXISTS event')

      // 先插一行"旧形状"的数据（有 role 无 type），验证回填不是纸上谈兵
      await pool.query(
        `INSERT INTO sessions (cwd, session_id, seq, role, content, created_at)
         VALUES ('/pg/legacy', 'old', 1, 'user', '{"content":"旧数据"}'::jsonb, $1)`,
        [Date.now()],
      )

      await migrate(pool)

      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'sessions' AND column_name IN ('type','event')
          ORDER BY column_name`,
      )
      assert.deepEqual(rows.map(r => r.column_name), ['event', 'type'], '两列必须被补回来')

      // 回填：旧行的 type 不能留 NULL（否则 NOT NULL 约束根本收紧不了）
      const { rows: legacy } = await pool.query<{ type: string | null }>(
        `SELECT type FROM sessions WHERE cwd = '/pg/legacy'`,
      )
      assert.equal(legacy[0]!.type, 'user', '存量行的 type 应由 role 回填')

      // 收紧后的约束是真的生效：新写入缺 type 必须报错
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO sessions (cwd, session_id, seq, role, content, created_at)
             VALUES ('/pg/legacy', 'old', 2, 'user', '{}'::jsonb, $1)`,
            [Date.now()],
          ),
        /null value in column "type"/,
        'type 必须是 NOT NULL',
      )

      // 还原干净，别把脏数据留给后面的用例
      await pool.query('TRUNCATE sessions CASCADE')
    })
  })
}
