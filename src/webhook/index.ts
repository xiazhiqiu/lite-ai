/**
 * Webhook 常驻监听进程（**只负责传输层**）：
 * POST /webhook → 鉴权 → 读 body → 路由解析（适配器归一化）→ 交给 IngestPipeline
 * → 存会话 → 通知。
 *
 * 边界：本文件不再包含去重 / 关联 / 并发池 / 拓扑刷新等后处理逻辑 —— 它们已抽到
 * `src/ingest/pipeline.ts`，与传输方式无关，供将来的**拉取型 provider** 复用同一条
 * 链路（否则 push 与 pull 会 divergent 成两套口径）。
 */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { WebhookConfig } from '../config.js'
import { routeAlertSource } from './sources/index.js'
import { IngestPipeline } from '../ingest/pipeline.js'
import type { BoundedPool } from '../jobs/pool.js'
import { runAlertDiagnosis, type DiagnosisResult } from './diagnose.js'
import type { Alert, Incident } from './types.js'

const MAX_BODY_BYTES = 5 * 1024 * 1024

export type WebhookServerOptions = {
  cwd: string
  config: WebhookConfig
  /**
   * 诊断执行器，默认 runAlertDiagnosis（测试可注入）。
   * 事件级诊断时第二个参数为 Incident（sessionId 取 incidentId）；单条诊断时不传。
   */
  diagnose?: (alert: Alert, incident?: Incident) => Promise<DiagnosisResult>
  /**
   * 注入并发池（测试用）。缺省用进程级全局单例（plan G1）——
   * 生产路径下摄入管道与 Worker **必须共用同一个池**，否则 provider
   * 实际看到的并发会是两池之和。测试注入可隔离不同用例的限流上限。
   */
  pool?: BoundedPool
  /** 外部触发优雅关闭（测试可注入）；与 SIGINT/SIGTERM 等效 */
  abortSignal?: AbortSignal
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      if (rejected) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejected = true
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

/** 校验 secret：支持 `Bearer <token>` 或裸 token，恒定时间比较防时序侧信道。 */
function matchesSecret(secret: string, header: unknown): boolean {
  if (typeof header !== 'string') return false
  const raw = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header
  const candidate = raw.trim()
  if (candidate.length === 0 || candidate.length !== secret.length) return false
  return timingSafeEqual(Buffer.from(secret), Buffer.from(candidate))
}

/** 判断监听地址是否为回环（仅回环时允许多进程本机访问，无需 secret）。 */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

function reply(
  res: http.ServerResponse,
  code: number,
  data: Record<string, unknown>,
): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

export async function runWebhookServer(
  opts: WebhookServerOptions,
): Promise<void> {
  const config = opts.config
  const host = config.host ?? '127.0.0.1'

  // fail-closed：绑定到非回环地址时强制要求 secret，否则拒绝启动（防未授权触发诊断 / 提权 / RCE）。
  if (!config.secret && !isLoopbackHost(host)) {
    throw new Error(
      `[webhook] 绑定到非回环地址 ${host} 时必须配置 webhook.secret，否则拒绝启动（防未授权诊断）`,
    )
  }

  // 后处理链路（去重 / 关联 / 分级 / 有界并发池 / 拓扑刷新）全部由管道持有。
  const pipeline = new IngestPipeline(opts.cwd, config, {
    diagnose:
      opts.diagnose ??
      ((alert: Alert, incident?: Incident) =>
        runAlertDiagnosis({ cwd: opts.cwd, alert, incident })),
    pool: opts.pool,
  })
  pipeline.start()

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      reply(res, 405, { error: 'method not allowed' })
      return
    }
    if (!req.url || !req.url.startsWith('/webhook')) {
      reply(res, 404, { error: 'not found' })
      return
    }

    if (config.secret && !matchesSecret(config.secret, req.headers.authorization ?? req.headers['x-webhook-secret'])) {
      reply(res, 401, { error: 'unauthorized' })
      return
    }

    let bodyStr: string
    try {
      bodyStr = await readBody(req)
    } catch {
      reply(res, 400, { error: 'payload too large' })
      return
    }

    let body: unknown
    try {
      body = JSON.parse(bodyStr || '{}')
    } catch {
      reply(res, 400, { error: 'invalid json' })
      return
    }

    let adapter
    try {
      adapter = routeAlertSource(body)
    } catch {
      reply(res, 400, { error: 'unrecognized alert source payload' })
      return
    }

    let alerts: Alert[]
    try {
      alerts = adapter.parse(body)
    } catch {
      reply(res, 400, { error: 'payload parse failed' })
      return
    }

    // 归一化之后的一切与"这条告警是怎么来的"无关 —— 推送与拉取共用同一条管道。
    reply(res, 202, pipeline.ingest(alerts))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      const addr = server.address()
      const shownPort =
        typeof addr === 'object' && addr !== null ? addr.port : config.port
      console.log(
        `[webhook] listening on http://${config.host}:${shownPort}/webhook`,
      )
      resolve()
    })
  })

  // 优雅退出：停止接收新请求，排空队列后关闭。
  return new Promise<void>(resolve => {
    let shuttingDown = false
    const shutdown = (): void => {
      if (shuttingDown) return
      shuttingDown = true
      console.log('[webhook] 收到退出信号，排空队列后关闭 ...')
      pipeline.close()
      server.close()
      void pipeline.drained().then(() => {
        server.closeAllConnections?.()
        resolve()
      })
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    opts.abortSignal?.addEventListener('abort', shutdown, { once: true })
  })
}

export { MAX_BODY_BYTES }
