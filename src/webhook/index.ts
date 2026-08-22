/**
 * Webhook 常驻监听进程：POST /webhook → 路由解析 → 兜底去重 → 硬截断 →
 * 串行队列自动诊断 → 存会话 → 通知。单会话串行，满足"无并发写"约束。
 */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { WebhookConfig } from '../config.js'
import { routeAlertSource } from './sources/index.js'
import { AlertDedupe, truncateAlerts } from './dedupe.js'
import { runAlertDiagnosis, type DiagnosisResult } from './diagnose.js'
import type { Alert } from './types.js'

const MAX_BODY_BYTES = 5 * 1024 * 1024

export type WebhookServerOptions = {
  cwd: string
  config: WebhookConfig
  /** 诊断执行器，默认 runAlertDiagnosis（测试可注入） */
  diagnose?: (alert: Alert) => Promise<DiagnosisResult>
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

  const dedupe = new AlertDedupe()
  const diagnose = opts.diagnose ?? ((alert: Alert) => runAlertDiagnosis({ cwd: opts.cwd, alert }))

  // 串行队列：一次只跑一个诊断。
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(async () => {
      try {
        await task()
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`[webhook] 诊断失败: ${reason}`)
      }
    })
  }

  // 返回 true 表示已入队。
  const handleAlert = (alert: Alert): boolean => {
    if (!dedupe.shouldDiagnose(alert.id)) {
      console.log(`[webhook] 去重跳过 ${alert.title} (${alert.id})，冷却窗口内`)
      return false
    }
    enqueue(async () => {
      try {
        const result = await diagnose(alert)
        console.log(
          `[webhook] 诊断完成 ${alert.title} (${alert.severity}) → session ${result.sessionId}`,
        )
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`[webhook] 诊断异常 ${alert.title}: ${reason}`)
      }
    })
    return true
  }

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

    const { alerts: kept, truncated } = truncateAlerts(alerts)
    if (truncated > 0) {
      console.warn(
        `[webhook] 告警被截断: 原始 ${alerts.length} 条 → 保留 ${kept.length} 条（critical 优先）。请检查 Alertmanager group_by/repeat_interval 配置。`,
      )
    }

    let accepted = 0
    let deduplicated = 0
    for (const alert of kept) {
      if (config.autoDiagnose === false) continue
      if (!handleAlert(alert)) {
        deduplicated += 1
      } else {
        accepted += 1
      }
    }

    reply(res, 202, { accepted, deduplicated, truncated })
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
      server.close()
      void queue.then(() => {
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