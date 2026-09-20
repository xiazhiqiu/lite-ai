/**
 * 同源静态资源托管（T10）。
 *
 * ## 为什么前端不独立部署
 *
 * 若前端跑在另一个端口，就必须开 CORS；而一旦开了 CORS，API 就"跨源暴露"了。
 * 同源托管把这件事彻底消掉：页面与 API 同一 origin，`fetch('/chat')` 天然带
 * 同源凭证、无需任何 CORS 头。这也正是 T6 的 `Authorization` 头能直接透传的前提。
 *
 * ## 本文件唯一的安全要害：路径穿越
 *
 * 请求路径来自客户端，`/../../etc/passwd`、`/..%2f..%2fsecret`、Windows 的
 * `/..\\..\\boot.ini` 都是经典攻击面。防御分三层：
 *
 * 1. **先 URL 解码**（`decodeURIComponent`），再用 `path.posix.normalize` 归一化
 *    —— `..` 与 `.` 在归一化时被消解。必须在解码**之后**归一化，否则
 *    `%2e%2e%2f` 能绕过只看原文的检查。
 * 2. **拒绝含 NUL 字节的路径**（`\0` 可截断底层 C 字符串，历史上多次成为绕过点）。
 * 3. **归一化后再拼根目录，最后用 `path.resolve` 复核结果确实落在根内**
 *    （前缀比较必须带 `path.sep`，否则 `/srv/webroot-evil` 会被误判为在
 *    `/srv/webroot` 之内 —— 这是最经典的"前缀比较漏分隔符"错误）。
 *
 * 任何一层不过，一律 404：**不透露"这个文件存在但不是静态资源"**。
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type http from 'node:http'

/** 扩展名 → Content-Type。覆盖 Vite 产物实际会用到的类型。 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * 把请求路径解析为**根目录内的绝对文件路径**。
 *
 * @returns 落在根内的绝对路径；越界/非法时返回 `null`（调用方回 404）。
 */
export function resolveSafePath(root: string, requestPath: string): string | null {
  // ① 解码。解码失败（畸形 %xx）直接拒绝——不猜、不回退。
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }

  // ② NUL 字节截断攻击
  if (decoded.includes('\0')) return null

  // ③ 按 POSIX 语义归一化（URL 路径永远用 `/`，Windows 的反斜杠在此统一转掉，
  //    否则 `..\..\` 在 Windows 上不会被 posix.normalize 消解）
  const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'))

  // 归一化后若仍以 `..` 开头，说明试图爬出根 —— 直接拒
  if (normalized.startsWith('..')) return null

  const rootAbs = path.resolve(root)
  const candidate = path.resolve(rootAbs, '.' + (normalized.startsWith('/') ? normalized : `/${normalized}`))

  // ④ 复核：必须严格等于根，或位于 `根 + 分隔符` 之下。
  //    带 `path.sep` 是关键 —— 否则 `/srv/webroot-evil` 会被 startsWith 误放行。
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + path.sep)) return null

  return candidate
}

/** 静态托管的判定结果。 */
export type StaticResult =
  | { served: true }
  | { served: false }

export type StaticServerOptions = {
  /** 静态资源根目录（`dist/web`）。目录不存在时视为"前端未构建"。 */
  root: string
  /** SPA 入口文件名，默认 `index.html`。 */
  indexFile?: string
}

/**
 * 尝试把请求当作静态资源处理。
 *
 * 语义（**SPA fallback**）：
 * - 命中真实文件 → 流式返回；
 * - 未命中且**不是 API 路径**（不含扩展名）→ 回 `index.html`，让前端路由自己处理
 *   （`/jobs/xxx` 这种深链接刷新时才不会 404）；
 * - 未命中且**看起来像资源**（带扩展名）→ 404，不回 index.html
 *   （否则浏览器拿到一个 HTML 当 JS/CSS 解析，报一堆莫名其妙的语法错）。
 *
 * @returns `{ served: true }` 表示已响应；`{ served: false }` 表示交回调用方继续路由。
 */
export async function tryServeStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: StaticServerOptions,
): Promise<StaticResult> {
  // 只处理 GET/HEAD —— 静态资源语义
  if (req.method !== 'GET' && req.method !== 'HEAD') return { served: false }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const requestPath = url.pathname
  const indexFile = opts.indexFile ?? 'index.html'

  const target = resolveSafePath(opts.root, requestPath)
  if (target === null) {
    // 越界：一律 404，不区分"非法"与"不存在"
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'not found' }))
    return { served: true }
  }

  const file = await statFile(target)
  if (file !== null) {
    return { served: await sendFile(req, res, target, file.size) }
  }

  // 未命中实际文件。带扩展名 → 像资源请求，不该 fallback（否则 MIME 错乱）。
  if (path.extname(requestPath).length > 0) return { served: false }

  // 无扩展名 → SPA 深链接，回 index.html
  const indexPath = path.join(path.resolve(opts.root), indexFile)
  const indexStat = await statFile(indexPath)
  if (indexStat === null) return { served: false } // 前端未构建 → 交回（最终 404）

  return { served: await sendFile(req, res, indexPath, indexStat.size) }
}

async function statFile(p: string): Promise<{ size: number } | null> {
  try {
    const s = await stat(p)
    // 目录不当作文件返回（否则 createReadStream 会 EISDIR）
    return s.isFile() ? { size: s.size } : null
  } catch {
    return null
  }
}

function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  size: number,
): Promise<boolean> {
  return new Promise(resolve => {
    res.statusCode = 200
    res.setHeader('Content-Type', contentTypeFor(filePath))
    res.setHeader('Content-Length', String(size))
    // HTML 不缓存（保证部署新版本后拿到新资源清单）；带 hash 的 assets 可长缓存。
    // 这里保守：一律 no-cache + 重新校验，避免"改了页面用户还看旧版"。
    res.setHeader('Cache-Control', 'no-cache')

    if (req.method === 'HEAD') {
      res.end()
      resolve(true)
      return
    }

    const stream = createReadStream(filePath)
    stream.on('error', () => {
      // 文件在 stat 与 open 之间被删（部署竞态）——此时头已发出，只能终止响应
      res.destroy()
      resolve(true)
    })
    stream.pipe(res)
    stream.on('end', () => resolve(true))
  })
}
