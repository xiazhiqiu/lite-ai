/**
 * PG 连接池（T2）。
 *
 * 单例 `pg.Pool`，全进程共享。三处硬约束：
 *
 * 1. **配置缺失时失败快**（对齐 HolmesGPT `server.py:911,918` 的 `SystemExit` 风格）。
 *    服务端形态下"连不上库"不是可降级状态——静默用内存实现会让运维以为数据在库里。
 * 2. **凭证不落盘**：`DATABASE_URL` 或 `PG*` 环境变量二选一，本模块只读环境。
 * 3. **`pool` 只在 `--serve` / PG 后端模式下创建**。CLI 形态（文件后端）**不应**因
 *    缺少 DATABASE_URL 而启动失败——所以这里用惰性创建 + 显式 `requirePgPool()`。
 *
 * 为什么不用 SQLite：`src/utils/json-file.ts:7` 的注释已明说"跨进程并发写建议文件锁/DB"，
 * 而异步队列 + 多实例必然多写。SQLite 单写者模型不支持（plan 决策表已拍板 PG）。
 */
import pg from 'pg'

const { Pool } = pg

/** 连接配置：优先 `DATABASE_URL`，否则回落到标准 `PG*` 变量（由 pg 自行读取）。 */
export type PgPoolConfig = {
  connectionString?: string
  max?: number
  /** 单条语句超时（毫秒）；防慢查询把 worker 卡死。 */
  statementTimeoutMs?: number
}

let pool: pg.Pool | null = null

/**
 * 从环境解析连接配置。
 * @returns 缺少一切连接信息时返回 `null`（调用方据此决定"失败快"还是"走文件后端"）
 */
export function resolvePgConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PgPoolConfig | null {
  const url = env.DATABASE_URL?.trim()
  if (url !== undefined && url !== '') return { connectionString: url }
  // pg 默认读 PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE；至少要有 host 或 database
  const hasPgVars =
    (env.PGHOST?.trim() ?? '') !== '' ||
    (env.PGDATABASE?.trim() ?? '') !== '' ||
    (env.PGUSER?.trim() ?? '') !== ''
  if (hasPgVars) return {}
  return null
}

/**
 * 建池。**不自动调用**——由 `--serve` 装配时显式调用。
 * 重复调用返回同一实例（单例）。
 */
export function createPgPool(
  config: PgPoolConfig,
  env: NodeJS.ProcessEnv = process.env,
): pg.Pool {
  if (pool !== null) return pool
  pool = new Pool({
    ...(config.connectionString === undefined
      ? {}
      : { connectionString: config.connectionString }),
    max: config.max ?? 10,
    // 防慢查询卡死 worker；由 migrations 与 claim 查询的实际耗时决定余量
    statement_timeout: config.statementTimeoutMs ?? 30_000,
    ...(env.PGSSLMODE === 'require' ? { ssl: { rejectUnauthorized: false } } : {}),
  })
  return pool
}

/**
 * 取池。未初始化时**抛错**（失败快）——而不是悄悄建一个连不上的池。
 * 供 `--serve` 装配路径调用。
 */
export function requirePgPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  if (pool !== null) return pool
  const config = resolvePgConfigFromEnv(env)
  if (config === null) {
    // 明确报错而非静默降级：运维必须立刻知道"库没配上"
    throw new Error(
      'PG 配置缺失：请设置 DATABASE_URL 或 PG* 环境变量（服务端形态不支持无库运行）',
    )
  }
  return createPgPool(config, env)
}

/** 当前是否已建池（测试 / 装配逻辑判断用）。 */
export function hasPgPool(): boolean {
  return pool !== null
}

/**
 * 健康检查：`SELECT 1`。
 * 供 `/readyz` 用——**真实查库**，不是"进程活着就算好"
 * （对齐 HolmesGPT readyz 语义：DB 挂了不该继续收流量）。
 */
export async function pingPg(poolImpl: pg.Pool = requirePgPool()): Promise<void> {
  await poolImpl.query('SELECT 1')
}

/** 关闭池（优雅退出用）。幂等。 */
export async function closePgPool(): Promise<void> {
  if (pool === null) return
  const closing = pool
  pool = null
  await closing.end()
}
