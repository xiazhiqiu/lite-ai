/**
 * 服务端装配入口（T3）——把 HTTP 层、存储层、就绪探测拼起来并监听。
 *
 * 为什么单开一个文件而不是塞进 `http.ts`：
 * `http.ts` 负责**路由语义**（可脱离进程单测），本文件负责**进程装配**
 * （选 JobStore、接 PG、装信号处理），两者关注点不同、测试方式也不同。
 */
import type http from 'node:http'
import os from 'node:os'
import { requirePgPool, pingPg, resolvePgConfigFromEnv } from '../db/pool.js'
import { createMemoryJobStore } from '../jobs/memory-store.js'
import { createPgJobStore } from '../jobs/pg-store.js'
import type { JobStore } from '../jobs/store.js'
import type { Job } from '../jobs/types.js'
import { createWorker, type Worker } from '../jobs/worker.js'
import {
  assertAuthConfigForBinding,
  resolveApiKeysFromEnv,
  type ApiKeyEntry,
} from './auth.js'
import { createServerApp, MAX_BODY_BYTES } from './http.js'

export type ServeOptions = {
  /** 服务端工作区路径（plan G4），缺省 `process.cwd()`。 */
  cwd: string
  port: number
  host: string
  /**
   * 共享 secret（T3 形态）。绑定非回环地址时**强制要求**，否则拒绝启动。
   *
   * T6 起逐步被下面的 `apiKeys` 取代 —— 单 secret 只能答"是不是自己人"，
   * 答不了"你是谁"，无法支撑 per-user 隔离。留着是为了兼容老部署。
   */
  secret?: string
  /**
   * T6 鉴权 key 表（key → userId）。缺省时从环境变量解析
   * （`LITE_AI_API_KEYS` / `LITE_AI_API_KEY`，见 `auth.ts`）。
   */
  apiKeys?: readonly ApiKeyEntry[]
  /** 外部注入 store（测试用）；缺省按 DATABASE_URL 自动选。 */
  store?: JobStore
  /**
   * Worker 执行器（T5 接线 `runAgentTurn`）。
   * 缺省时用一个**明确抛错**的占位实现 —— 让缺接线这件事暴露成 failed，
   * 而不是静默假装成功。
   */
  execute?: (job: Job) => Promise<void>
  /** Worker claim 轮询间隔（测试可调）。 */
  workerPollMs?: number
  /** 外部触发关闭。 */
  abortSignal?: AbortSignal
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

/**
 * 真实执行器装配（T5）。
 *
 * 模型选择沿用 `diagnose.ts` 的约定：`LITE_AI_MODEL_MODE=mock` 时用 MockModelAdapter
 * （离线演示 / 冒烟测试），否则按运行时 provider 建真实 adapter。
 *
 * 模型走**工厂**而非实例：adapter 构造需要 tools（见 `diagnose.ts:40-52`），
 * 而 tools 要到每次执行时才装配。工厂形态也让"服务启动"与"建模型客户端"解耦 ——
 * 模型配置错误不该让 `/healthz` 起不来，而应落到那次 job 的 failed 上。
 *
 * 懒加载：只有真要跑 job 时才 import agent 栈。
 */
async function defaultExecute(
  store: JobStore,
  cwd: string,
): Promise<(job: Job) => Promise<void>> {
  const { createJobExecutor } = await import('../jobs/exec.js')
  const { getSessionStore } = await import('../session.js')

  return createJobExecutor({
    jobStore: store,
    sessionStore: getSessionStore(),
    cwd,
    model: async ({ tools }) => {
      if (process.env.LITE_AI_MODEL_MODE === 'mock') {
        const { MockModelAdapter } = await import('../mock-model.js')
        return new MockModelAdapter()
      }
      const { loadRuntimeConfig } = await import('../config.js')
      const runtime = await loadRuntimeConfig()
      if (runtime.provider === 'openai') {
        const { OpenAIModelAdapter } = await import('../openai-adapter.js')
        return new OpenAIModelAdapter(tools, loadRuntimeConfig)
      }
      const { AnthropicModelAdapter } = await import('../anthropic-adapter.js')
      return new AnthropicModelAdapter(tools, loadRuntimeConfig)
    },
    modelName: process.env.LITE_AI_MODEL_MODE === 'mock' ? 'mock' : '',
    log: (level, message) => {
      if (level === 'error') console.error(message)
      else if (level === 'warn') console.warn(message)
      else console.log(message)
    },
  })
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const host = opts.host

  // ── 鉴权配置（T6）──
  // 解析顺序：显式 opts.apiKeys > 环境变量 LITE_AI_API_KEYS/LITE_AI_API_KEY >
  // 老形态 opts.secret（降级为单一身份）。
  let apiKeys: readonly ApiKeyEntry[] = opts.apiKeys ?? resolveApiKeysFromEnv(process.env)
  if (apiKeys.length === 0 && opts.secret !== undefined && opts.secret.length > 0) {
    // 老部署兼容：单个共享 secret → 映射成单一 userId（per-user 隔离随之退化，
    // 只挡"外人"、不区分"内部谁是谁"）。这里显式打日志，别让它静默发生。
    apiKeys = [{ key: opts.secret, userId: 'operator' }]
    console.warn(
      '[serve] 使用单 secret 形态（webhook.secret）：所有调用方共享身份 operator，' +
        'per-user 隔离不生效。要区分用户请配置 LITE_AI_API_KEYS="<key>:<userId>,..."。',
    )
  }

  // fail-closed：非回环绑定必须有 key，否则任何人可触发诊断（提权/RCE 面）。
  // 回环绑定允许无 key（本机开发形态，Docker/k8s 探针也不需要凭证）。
  assertAuthConfigForBinding(host, apiKeys)
  if (apiKeys.length === 0) {
    console.warn('[serve] 回环地址且未配置 API key：**不启用鉴权**，仅限本机开发使用。')
  }

  const { store, ready, dispose } = await selectStore(opts)

  const app = createServerApp({
    store,
    cwd: opts.cwd,
    ready,
    auth: { keys: apiKeys },
    abortSignal: opts.abortSignal,
  })

  // ── Worker 装配（T4）+ 执行器接线（T5）──
  // 真实执行器 = `createJobExecutor`：组装 runAgentTurn（唯一一份调查逻辑）
  // 并把回调翻译成 job_events。测试/嵌入方可用 `opts.execute` 覆盖。
  const execute = opts.execute ?? (await defaultExecute(store, opts.cwd))
  const worker: Worker = createWorker({
    store,
    assignee: `${os.hostname()}-${process.pid}`,
    execute,
    pollMs: opts.workerPollMs,
  })
  worker.start()

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
      console.log(`[serve]   worker ${os.hostname()}-${process.pid} 已启动（消费 jobs 队列）`)
      resolve()
    })
  })

  return new Promise<void>(resolve => {
    let shuttingDown = false
    const shutdown = (): void => {
      if (shuttingDown) return
      shuttingDown = true
      console.log('[serve] 收到退出信号，关闭 ...')
      // 顺序很重要：先停 claim（不再接新活），等在途 job 跑完，最后关连接与池。
      // 反过来的话，正在执行的 job 会被拦腰砍断，而它已经占着 running 状态，
      // 只能等租期超时才被回收 —— 白白浪费一次已完成的调查。
      worker.stop()
      app.server.close()
      app.server.closeAllConnections?.()
      void worker
        .drained()
        .then(() => dispose())
        .then(() => resolve())
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    opts.abortSignal?.addEventListener('abort', shutdown, { once: true })
  })
}

export { MAX_BODY_BYTES, createServerApp }
export type { http }
