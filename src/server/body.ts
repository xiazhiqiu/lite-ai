/**
 * HTTP 请求体读取（传输层共用）。
 *
 * 抽成独立模块是因为 G7 之后 `POST /webhook` 由 `--serve` 吸收，与旧的 webhook
 * 进程**共用同一份实现**。body 上限与超限行为若分成两份，改一处漏一处就会出现
 * "同一条告警在两种形态下被不同上限截断"的口径漂移 —— 这正是 G7 要消灭的那种分叉。
 *
 * 本模块零外部依赖，因此 `server/http.ts` 引入它不会拉起整个告警/agent 栈。
 */
import type { IncomingMessage } from 'node:http'

/** 请求体上限（5MB）。Alertmanager 一批告警远小于此，超限基本意味着异常投递。 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024

/**
 * 读取请求体。超过 `MAX_BODY_BYTES` 时 reject **并销毁请求** ——
 * 不继续收数据，否则恶意超大 body 会先把内存吃光。
 */
export function readBody(req: IncomingMessage): Promise<string> {
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
