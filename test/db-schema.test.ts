/**
 * `schema.sql` 的**定义存在性**契约（文本级）。
 *
 * ## 为什么是文本级、不是执行级
 *
 * 本仓所有 PG 相关测试（`test/*-pg.test.ts`）都要求 `DATABASE_URL`，没配即 skip
 * —— 也就是说 **`schema.sql` 此前从未被任何测试读过**（`loadSchemaSql` 是个
 * 无消费者的导出，尽管它的注释写着"便于测试断言表名齐全"）。这里补上那一层。
 *
 * 它防的是「改 schema 时误删索引 / 触发器」这类**静默退化**：
 * 删掉一个 `CREATE INDEX` 不会让任何测试变红，只会让线上某条查询悄悄变慢。
 *
 * ⚠️ **它不能证明 SQL 在 PG 上可执行** —— 语法错、函数体错、触发器等级写错都
 * 逃得过文本匹配。升级路径：一旦测试环境有 PG，改成 `migrate(pool)` 之后查
 * `pg_indexes` 与 `information_schema.triggers`（执行级证据）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadSchemaSql } from '../src/db/migrate.js'

let cached: string | null = null

/** 读一次、缓存（schema.sql 在测试期间不会变）。 */
async function schema(): Promise<string> {
  cached ??= await loadSchemaSql()
  return cached
}

describe('schema.sql 定义完整性', () => {
  it('核心表都有建表语句', async () => {
    const sql = await schema()
    for (const table of ['jobs', 'job_events', 'usage_events', 'sessions']) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `缺建表语句：${table}`)
    }
  })

  it('usage_events 的四个查询维度都有索引（session / trace 是 T-obs 补的）', async () => {
    const sql = await schema()
    const expected: Array<[index: string, column: string]> = [
      ['usage_events_user_idx', 'user_id'],
      ['usage_events_job_idx', 'job_id'],
      ['usage_events_session_idx', 'session_id'],
      ['usage_events_trace_idx', 'trace_id'],
    ]
    for (const [index, column] of expected) {
      const decl = new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b[^;]*\\(\\s*${column}\\b`, 's')
      assert.match(sql, decl, `缺索引或缺列：${index} 应覆盖 ${column}`)
    }
  })

  it('usage_events 有 DB 级 append-only 强制（UPDATE/DELETE 与 TRUNCATE 各一条）', async () => {
    const sql = await schema()
    assert.match(sql, /FUNCTION usage_events_forbid_mutation\b/, '缺 append-only 函数')
    assert.match(
      sql,
      /CREATE TRIGGER usage_events_no_mutation[\s\S]{0,200}?BEFORE UPDATE OR DELETE ON usage_events/,
      '缺 BEFORE UPDATE OR DELETE 触发器',
    )
    assert.match(
      sql,
      /CREATE TRIGGER usage_events_no_truncate[\s\S]{0,200}?BEFORE TRUNCATE ON usage_events/,
      '缺 BEFORE TRUNCATE 触发器',
    )
  })

  it('append-only 函数体真的抛错（不是空实现）', async () => {
    const sql = await schema()
    assert.match(sql, /RAISE EXCEPTION 'usage_events is append-only/)
  })

  it('原子 claim 函数仍在（FOR UPDATE SKIP LOCKED 语义的地基）', async () => {
    const sql = await schema()
    assert.match(sql, /CREATE OR REPLACE FUNCTION claim_jobs\b/)
    assert.match(sql, /FOR UPDATE SKIP LOCKED/)
  })
})
