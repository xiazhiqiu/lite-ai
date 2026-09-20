/**
 * schema 迁移（T2）。
 *
 * 极简：把 `schema.sql` 整份执行。**幂等**（DDL 全用 `IF NOT EXISTS` /
 * `CREATE OR REPLACE FUNCTION`），可重复跑。
 *
 * 为什么不做版本化迁移框架：当前是**单仓单服务**、schema 只有本文件一份来源，
 * 引入 knex/prisma-migrate 是过度设计（plan 明确"不引额外依赖"）。
 * 日后真要版本化，再在上方加 `schema_migrations` 表记录已应用版本即可——
 * 本函数的整流式设计不阻碍该演进。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))

/** schema.sql 的绝对路径（与编译产物同目录布局）。 */
export const SCHEMA_PATH = path.join(here, 'schema.sql')

/** 读 schema.sql 原文（单独导出便于测试断言表名齐全）。 */
export async function loadSchemaSql(schemaPath = SCHEMA_PATH): Promise<string> {
  return readFile(schemaPath, 'utf8')
}

/**
 * 应用 schema。
 * @returns 执行的语句数（粗略统计，供日志）
 */
export async function migrate(pool: pg.Pool, schemaPath = SCHEMA_PATH): Promise<number> {
  const sql = await loadSchemaSql(schemaPath)
  // 整份执行：schema.sql 内每条语句自带 IF NOT EXISTS / OR REPLACE，天然幂等。
  // 不用 `pool.query` 的多语句分割，是因为 schema.sql 里含 `$$ ... $$` 函数体，
  // 朴素地按分号切会切碎函数定义 —— 让 PG 自己解析整份最稳。
  await pool.query(sql)
  return sql.split(';').filter(part => part.trim() !== '').length
}
