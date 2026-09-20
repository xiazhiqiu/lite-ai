/**
 * 服务端装配入口（T3）——把 HTTP 层、存储层、就绪探测拼起来并监听。
 *
 * 为什么单开一个文件而不是塞进 `http.ts`：
 * `http.ts` 负责**路由语义**（可脱离进程单测），本文件负责**进程装配**
 * （选 JobStore、接 PG、装信号处理），两者关注点不同、测试方式也不同。
 */
import type http from 'node:http'
import { requirePgPool, pingPg, resolvePgConfigFromEnv } from '../db/pool.js'
import { createMemoryJobStore } from '../jobs/memory-store.js'
import { createPgJobStore } from '../jobs/pg-store.js'
import type { JobStore } from '../jobs/store.js'
import { createServerApp, MAX_BODY_BYTES } from './http.js'

export type ServeOptions = {
  /** 服务端工作区路径（plan G4），缺省 `process.cwd()`。 */
  cwd: string
  port: number
  host: string
  /**
   * 共享 secret（T6 会升级为 API key / SSO）。
   * 绑定非回环地址时**强制要求**，否则拒绝启动（防未授权触发调查）。
   */
  secret?: string
  /** 外部注入 store（测试用）；缺省按 DATABASE_URL 自动选。 */
  store?: JobStore
  /** 外部触发关闭。 */
  abortSignal?: AbortSignal
}

/** 回环地址判定：仅回环时允许多进程本机访问而无需 secret。 */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

/**
 * 选存储实现：
 * - 配了 `DATABASE_URL` / `PG*` → PG（生产路径，多实例共享队列）
 * - 否则 → 内存（单进程开发/演示；**重启即丢**，且多实例不共享）
 */
async function selectStore(opts: ServeOptions): Promise<{
  store: JobStore
  ready: () => Promise<boolean>
  dispose: () => Promise<void>
}> {
  if (opts.store !== undefined) {
    return { store: opts.store, ready: async () => true, dispose: async () => {} }
  }

  const pgConfig = resolvePgConfigFromEnv(process.env)
  if (pgConfig === null) {
    console.warn(
      '[serve] 未检测到 DATABASE_URL / PG* 配置，使用**内存队列**（重启即丢、多实例不共享）。' +
        '生产部署请配置 Postgres。',
    )
    return {
      store: createMemoryJobStore(),
      ready: async () => true,
      dispose: async () => {},
    }
  }

  // 缺配置时失败快（对齐 HolmesGPT server.py:911,918）——不要静默降级成内存，
  // 否则运维以为在跑生产队列、实际数据没有落库。
  const pool = requirePgPool(process.env)
  return {
    store: createPgJobStore(pool),
    // pingPg 失败时**抛错**而非返回 false，这里转成布尔以适配 /readyz 的探测语义。
    // 不吞异常：抛错即"未就绪"，与 DB 真的不可用时行为一致。
    ready: async () => {
      try {
        await pingPg(pool)
        return true
      } catch {
        return false
      }
    },
    dispose: async () => {
      await pool.end()
    },
  }
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const host = opts.host

  // fail-closed：非回环绑定必须有 secret，否则任何人可触发诊断（提权/RCE 面）。
  if (!opts.secret && !isLoopbackHost(host)) {
    throw new Error(
      `[serve] 绑定到非回环地址 ${host} 时必须配置 webhook.secret，否则拒绝启动（防未授权调查）`,
    )
  }

  const { store, ready, dispose } = await selectStore(opts)

  const app = createServerApp({
    store,
    cwd: opts.cwd,
    ready,
    abortSignal: opts.abortSignal,
  })

  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(opts.port, host, () => {
      const addr = app.server.address()
      const shown =
        typeof addr === 'object' && addr !== null ? addr.port : opts.port
      console.log(`[serve] listening on http://${host}:${shown}`)
      console.log('[serve]   POST /chat            入队（202 + jobId）')
      console.log('[serve]   GET  /jobs/:id         状态 + 事件增量（?after=<seq>）')
      console.log('[serve]   GET  /jobs/:id/stream  SSE 事件流')
      console.log('[serve]   GET  /healthz /readyz  健康/就绪（免鉴权）')
      resolve()
    })
  })

  return new Promise<void>(resolve => {
    let shuttingDown = false
    const shutdown = (): void => {
      if (shuttingDown) return
      shuttingDown = true
      console.log('[serve] 收到退出信号，关闭 ...')
      app.server.close()
      app.server.closeAllConnections?.()
      void dispose().then(() => resolve())
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    opts.abortSignal?.addEventListener('abort', shutdown, { once: true })
  })
}

export { MAX_BODY_BYTES, createServerApp }
export type { http }
