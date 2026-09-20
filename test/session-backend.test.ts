/**
 * T8 后端选择（`resolveSessionBackend` / `getSessionStore`）的测试。
 *
 * ## 为什么这组测试值得单独存在
 *
 * 后端选择是**配置解析**，看起来"写个 if-else 能有什么问题"。但它有三个
 * 容易写错的点，且错了都是**静默的**：
 * 1. 默认值写死 `pg` → 所有 CLI 用户没配库就启动失败（回退能力丢失）；
 * 2. 默认值写死 `file` → 服务端多实例静默各写各的本地文件（会话不共享）；
 * 3. 非法配置值静默回退 → 运维以为在跑 PG，实际数据全在本机。
 *
 * 所以这里逐条钉住：推导规则、显式覆盖、非法值**抛错**（而非回退）。
 *
 * ## 为什么不断言"给定 env 会真的建出 PG 后端"
 *
 * 那需要真连库 —— 而本文件的职责是**配置解析**的纯逻辑。真连库的等价性
 * 由 `session-store-pg.test.ts` 的契约测试覆盖（无 PG 时 skip）。
 * 这里只验证"env → 后端名"的映射，不需要任何外部依赖，永远真跑。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveSessionBackend } from '../src/config.js'

/** 造一个只含指定键的 env（避免读到进程真实环境里的 DATABASE_URL）。 */
function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...vars } as NodeJS.ProcessEnv
}

describe('T8 resolveSessionBackend：后端推导规则', () => {
  it('什么都没配 → file（CLI / 离线形态必须能起来）', () => {
    assert.equal(resolveSessionBackend(env({})), 'file')
  })

  it('配了 DATABASE_URL → pg', () => {
    assert.equal(resolveSessionBackend(env({ DATABASE_URL: 'postgres://x/y' })), 'pg')
  })

  it('只配了 PG* 变量也算配了 → pg', () => {
    assert.equal(resolveSessionBackend(env({ PGHOST: 'db.internal' })), 'pg')
    assert.equal(resolveSessionBackend(env({ PGDATABASE: 'liteai' })), 'pg')
    assert.equal(resolveSessionBackend(env({ PGUSER: 'svc' })), 'pg')
  })

  it('空字符串不算"配了"（容易被 .env 里的空行坑到）', () => {
    assert.equal(resolveSessionBackend(env({ DATABASE_URL: '' })), 'file')
    assert.equal(resolveSessionBackend(env({ DATABASE_URL: '   ' })), 'file')
    assert.equal(resolveSessionBackend(env({ PGHOST: '' })), 'file')
  })
})

describe('T8 resolveSessionBackend：显式覆盖', () => {
  it('LITE_AI_SESSION_BACKEND=file 可强制文件后端（即使配了 PG）', () => {
    // 用途：离线回退、灾备时先跑本机。必须**能压过** DATABASE_URL 的存在，
    // 否则"我想先用文件跑"这个诉求没法表达。
    assert.equal(
      resolveSessionBackend(env({ LITE_AI_SESSION_BACKEND: 'file', DATABASE_URL: 'postgres://x/y' })),
      'file',
    )
  })

  it('LITE_AI_SESSION_BACKEND=pg 可强制 PG（即使没配 PG 变量）', () => {
    // 这条的语义是"我就是要 PG"——没配库时后续 requirePgPool() 会失败快。
    // 若这里静默回退成 file，就失去了"失败快"的保护。
    assert.equal(resolveSessionBackend(env({ LITE_AI_SESSION_BACKEND: 'pg' })), 'pg')
  })

  it('大小写与空白可容忍', () => {
    assert.equal(resolveSessionBackend(env({ LITE_AI_SESSION_BACKEND: 'PG' })), 'pg')
    assert.equal(resolveSessionBackend(env({ LITE_AI_SESSION_BACKEND: ' File ' })), 'file')
  })

  it('【关键】非法取值抛错，不静默回退', () => {
    // 打错成 postgres / pgx / 1 之类，必须**立刻报错**。
    // 静默当成 file 会让运维以为在跑 PG 多实例 —— 而实际数据全在本机。
    for (const bad of ['postgres', 'pgx', 'sqlite', '1', 'true']) {
      assert.throws(
        () => resolveSessionBackend(env({ LITE_AI_SESSION_BACKEND: bad })),
        /LITE_AI_SESSION_BACKEND 取值非法/,
        `取值 '${bad}' 应当抛错`,
      )
    }
  })
})
