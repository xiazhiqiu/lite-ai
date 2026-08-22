import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { clampToolOutput, type ToolsetStatus } from './base.js'
import type { ResolvedToolsetConfig } from '../../config.js'

/**
 * 关系型数据库只读查询工具集（对齐 HolmesGPT database toolset）。
 * 通过 connection_url 解析驱动（sqlite / mysql / postgres），仅允许只读 SQL。
 */

const OUTPUT_CHARS = 30_000
const MAX_ROWS_CAP = 500
const MAX_ROWS_DEFAULT = 100

const READ_ONLY_START = /^\s*(select|show|describe|explain|with)\b/i
const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|merge|replace|call|execute)\b/i

/**
 * 剥离 SQL 注释（块注释、-- 行注释、# 行注释），返回只读校验用 / 执行用的规范化 SQL。
 * 注释剥离后，注释混淆关键字（如 D-E-L-<block>-E-T-E 即 DEL 与 ETE 之间夹注释）会被还原成明文
 * 写关键字，从而被 WRITE_WORDS 拦下；同时移除 -- 行注释，防止其吞掉 queryRows 后拼的 LIMIT。
 */
function stripSqlComments(sql: string): string {
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ')
  s = s.replace(/--[^\n]*/g, ' ')
  s = s.replace(/#[^\n]*/g, ' ')
  return s
}

/** 规范化只读 SQL：去注释与两端空白。 */
function normalizeReadOnlySql(sql: string): string {
  return stripSqlComments(sql).trim()
}

/** 判断 SQL 是否只读（去注释、拒绝多语句、白名单开头、无写关键字）。 */
export function isReadOnlySql(sql: string): boolean {
  const s = normalizeReadOnlySql(sql)
  if (!s) return false
  // 拒绝带分号的多语句（postgres 的 simple query protocol 可一次执行多条）。
  if (/;/.test(s)) return false
  if (!READ_ONLY_START.test(s)) return false
  if (WRITE_WORDS.test(s)) return false
  return true
}

export function checkDatabaseConfig(
  toolset: ResolvedToolsetConfig,
): ToolsetStatus {
  const url = toolset.config.connection_url
  if (typeof url !== 'string' || url.length === 0) {
    return {
      name: toolset.name,
      type: 'database',
      enabled: false,
      reason: '缺少 connection_url',
    }
  }
  return { name: toolset.name, type: 'database', enabled: true }
}

type Dialect = 'sqlite' | 'mysql' | 'postgres'

function resolveDialect(url: string): Dialect {
  if (url.startsWith('mysql')) return 'mysql'
  if (url.startsWith('postgres') || url.startsWith('postgresql')) return 'postgres'
  return 'sqlite'
}

function stringifyRows(rows: unknown[]): string {
  return clampToolOutput(JSON.stringify(rows, null, 2), OUTPUT_CHARS)
}

/** 统一查询执行：按驱动执行带 LIMIT 的只读 SQL，返回行数组/错误。 */
async function queryRows(
  url: string,
  sql: string,
  limit: number,
): Promise<{ ok: boolean; output: string }> {
  const dialect = resolveDialect(url)
  try {
    if (dialect === 'postgres') {
      const { default: pg } = await import('pg')
      const client = new pg.Client({
        connectionString: url.replace(/^postgresql/, 'postgres'),
        // 只读诊断：限制单次查询挂起时间，防止长时间运行/阻塞拖垮 agent。
        statement_timeout: 30_000,
        query_timeout: 30_000,
      })
      await client.connect()
      try {
        const res = await client.query(`${sql} LIMIT ${limit}`)
        return { ok: true, output: stringifyRows(res.rows as unknown[]) }
      } finally {
        await client.end()
      }
    }
    if (dialect === 'mysql') {
      const { default: mysql } = await import('mysql2/promise')
      const conn = await mysql.createConnection(url)
      try {
        const [rows] = await conn.query(`SELECT * FROM (${sql}) AS _limit LIMIT ${limit}`)
        return { ok: true, output: stringifyRows(rows as unknown[]) }
      } finally {
        await conn.end()
      }
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(url.replace(/^sqlite:\/\//, ''), { readOnly: true })
    try {
      const rows = db.prepare(`${sql} LIMIT ${limit}`).all() as unknown[]
      return { ok: true, output: stringifyRows(rows) }
    } finally {
      db.close()
    }
  } catch (err) {
    return {
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    }
  }
}

function tool<T>(
  prefixedName: string,
  description: string,
  schema: z.ZodType<T>,
  exec: (url: string, input: T) => Promise<{ ok: boolean; output: string }>,
  url: string,
): ToolDefinition<T> {
  return {
    name: prefixedName,
    description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    schema,
    isReadOnly: true,
    async run(input) {
      return exec(url, input)
    },
  }
}

/** SQL 多实例：工具名为 {instance}_{action}。instance 取配置 key，非法字符归一化。 */
function safeInstanceName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
}

export function buildDatabaseTools(
  toolset: ResolvedToolsetConfig,
): ToolDefinition<unknown>[] {
  const url = String(toolset.config.connection_url)
  const inst = safeInstanceName(toolset.name)

  return [
    tool(
      `${inst}_query`,
      `Run a read-only SQL query (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH) on database instance '${toolset.name}'.`,
      z.object({ sql: z.string().min(1).max(8192) }),
      async (baseUrl, input) => {
        // 先规范化（去注释），再校验是否只读；校验通过后用规范化 SQL 执行，避免注释/分号绕过。
        const sanitized = normalizeReadOnlySql(input.sql)
        if (!isReadOnlySql(sanitized)) {
          return {
            ok: false,
            output: '仅允许只读 SQL（SELECT/SHOW/DESCRIBE/EXPLAIN/WITH，单条语句）',
          }
        }
        return queryRows(baseUrl, sanitized, MAX_ROWS_DEFAULT)
      },
      url,
    ),
    tool(
      `${inst}_list_tables`,
      'List tables of the connected database.',
      z.object({}),
      async (baseUrl) => {
        const dialect = resolveDialect(baseUrl)
        const sql =
          dialect === 'postgres'
            ? "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'"
            : dialect === 'mysql'
              ? 'SHOW TABLES'
              : "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        return queryRows(baseUrl, sql, MAX_ROWS_CAP)
      },
      url,
    ),
    tool(
      `${inst}_describe_table`,
      'Describe the columns of a table.',
      z.object({
        table: z.string().min(1).max(256),
        limit: z.number().int().min(1).max(MAX_ROWS_CAP).optional(),
      }),
      async (baseUrl, input) => {
        const dialect = resolveDialect(baseUrl)
        const safeTable = input.table.replace(/'/g, "''")
        const sql =
          dialect === 'postgres'
            ? `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${safeTable}'`
            : dialect === 'mysql'
              ? `DESCRIBE \`${input.table.replace(/`/g, '')}\``
              : `PRAGMA table_info('${safeTable}')`
        return queryRows(baseUrl, sql, MAX_ROWS_CAP)
      },
      url,
    ),
  ]
}