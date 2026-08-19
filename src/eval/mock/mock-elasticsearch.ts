/**
 * Mock Elasticsearch HTTP server：从 RE2-SS logs.csv 提供 ES 检索 API 子集。
 *
 * 支持端点：
 *   GET  /                         — 集群信息（版本）
 *   GET  /_cat/indices             — 索引列表
 *   GET|POST /sock-shop-logs/_search — 检索（支持 ?q= 与 JSON body DSL）
 *
 * 查询支持：
 *   - q= 参数（Lucene 简化子集）：
 *       q=message:exception            — 字段包含匹配
 *       q=container_name:payment       — 字段精确/包含匹配
 *       q=severity:ERROR               — 精确匹配
 *       q=message:"Payment failed"     — 短语包含
 *       q=*:* 或空                     — 全部
 *   - body DSL：query.match / query.term / query.bool.must|filter|should /
 *       query.range / query.match_all / query.query_string / sort / size / from
 */
import http from 'node:http'
import type { LogEntry } from './csv.js'

const INDEX = 'sock-shop-logs'

export interface ElasticsearchOptions {
  entries: LogEntry[]
  port?: number
}

export interface ElasticsearchInstance {
  server: http.Server
  url: string
  port: number
}

type FilterFn = (doc: Record<string, unknown>) => boolean

/** 把 LogEntry 展开为 ES 文档字段（_source），供过滤器与排序使用。 */
function toDoc(e: LogEntry): Record<string, unknown> {
  return {
    time: e.time,
    timestamp: e.timestampNs,
    container_name: e.container,
    message: e.message,
    level: e.level,
    severity: e.severity,
    req_path: e.reqPath,
    error: e.error,
  }
}

/** 从 q= 字符串构建过滤函数（Lucene 简化子集） */
function buildQueryStringFilter(q: string): FilterFn {
  const trimmed = (q ?? '').trim()
  if (!trimmed || trimmed === '*:*') return () => true

  // 按 AND 拆（忽略大小写），全部满足
  const clauses = trimmed.split(/\s+AND\s+/i).map(c => c.trim()).filter(Boolean)

  const clauseFilters: FilterFn[] = clauses.map(clause => {
    // field:"phrase"
    const phrase = clause.match(/^([\w.]+):"([^"]+)"$/)
    if (phrase) {
      const [, field, value] = phrase
      return d => String(d[field!] ?? '').includes(value!)
    }
    // field:value
    const kv = clause.match(/^([\w.*]+):(.+)$/)
    if (kv) {
      const [, field, value] = kv
      if (field === '*') return () => true
      const lower = value.toLowerCase()
      return d => {
        const actual = String(d[field!] ?? '')
        return actual.toLowerCase() === lower || actual.toLowerCase().includes(lower)
      }
    }
    // 裸词 → 在 message 中匹配
    const lower = clause.toLowerCase()
    return d => String(d['message'] ?? '').toLowerCase().includes(lower)
  })

  return d => clauseFilters.every(f => f(d))
}

/** 从 ES body DSL 构建过滤函数 */
function buildDslFilter(body: unknown): FilterFn {
  if (typeof body !== 'object' || body === null) return () => true
  const root = body as Record<string, unknown>
  const query = root.query as Record<string, unknown> | undefined
  if (!query) return () => true

  const conditions: FilterFn[] = []

  const addMatch = (field: string, value: unknown) => {
    const lower = String(value).toLowerCase()
    conditions.push(d => {
      const actual = String(d[field] ?? '')
      return actual.toLowerCase() === lower || actual.toLowerCase().includes(lower)
    })
  }

  const addTerm = (field: string, value: unknown) => {
    const lower = String(value).toLowerCase()
    conditions.push(d => {
      const actual = String(d[field] ?? '')
      return actual.toLowerCase() === lower
    })
  }

  const addRange = (field: string, range: Record<string, unknown>) => {
    conditions.push(d => {
      const actual = Number(d[field])
      if (range.gte !== undefined && actual < Number(range.gte)) return false
      if (range.gt !== undefined && actual <= Number(range.gt)) return false
      if (range.lte !== undefined && actual > Number(range.lte)) return false
      if (range.lt !== undefined && actual >= Number(range.lt)) return false
      return true
    })
  }

  const addClause = (clause: unknown) => {
    if (typeof clause !== 'object' || clause === null) return
    const c = clause as Record<string, unknown>
    for (const [key, value] of Object.entries(c)) {
      if (key === 'match_all') continue
      if (key === 'match' && typeof value === 'object' && value !== null) {
        for (const [f, v] of Object.entries(value as Record<string, unknown>)) addMatch(f, v)
      } else if (key === 'term' && typeof value === 'object' && value !== null) {
        for (const [f, v] of Object.entries(value as Record<string, unknown>)) addTerm(f, v)
      } else if (key === 'range' && typeof value === 'object' && value !== null) {
        for (const [f, v] of Object.entries(value as Record<string, unknown>)) {
          if (typeof v === 'object' && v !== null) addRange(f, v as Record<string, unknown>)
        }
      } else if (key === 'query_string' && typeof value === 'object' && value !== null) {
        const qs = (value as Record<string, unknown>).query
        if (typeof qs === 'string') conditions.push(buildQueryStringFilter(qs))
      } else if (key === 'bool' && typeof value === 'object' && value !== null) {
        const b = value as Record<string, unknown>
        for (const section of ['must', 'filter', 'should'] as const) {
          const list = b[section]
          if (Array.isArray(list)) list.forEach(addClause)
        }
      }
    }
  }

  addClause(query)
  return d => conditions.every(f => f(d))
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

export function createElasticsearchServer(
  options: ElasticsearchOptions,
): Promise<ElasticsearchInstance> {
  return new Promise((resolve) => {
    const { entries, port = 0 } = options
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      const pathOnly = url.split('?')[0]!
      const qs = new URLSearchParams(url.includes('?') ? url.split('?')[1]! : '')
      res.setHeader('Content-Type', 'application/json')

      // 集群信息
      if (pathOnly === '/') {
        res.writeHead(200)
        res.end(
          JSON.stringify({
            name: 'mock-es-node-1',
            cluster_name: 'sock-shop',
            version: { number: '7.17.0' },
            tagline: 'You Know, for Search',
          }),
        )
        return
      }

      // 索引列表
      if (pathOnly === '/_cat/indices') {
        res.writeHead(200)
        res.end(
          `green open ${INDEX} UvD5MgJfQZa9j9y3w 1 1 ${entries.length} ${entries.length}\n`,
        )
        return
      }

      // 检索
      const isSearch =
        pathOnly === '/_search' ||
        pathOnly === `/${INDEX}/_search` ||
        pathOnly === `/${INDEX}-*/_search` ||
        pathOnly.endsWith('/_search')
      if (isSearch) {
        // 收集请求体（POST 才有）
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8')
          const body = rawBody ? parseJsonBody(rawBody) : null

          let filter: FilterFn = () => true
          let size = 10
          let from = 0
          let sortDesc = true // 默认按时间倒序

          if (qs.get('q')) {
            filter = buildQueryStringFilter(qs.get('q')!)
          } else if (body && typeof body === 'object') {
            const b = body as Record<string, unknown>
            filter = buildDslFilter(b)
            if (typeof b.size === 'number') size = b.size
            if (typeof b.from === 'number') from = b.from
            const sort = b.sort
            if (Array.isArray(sort)) {
              const first = sort[0]
              if (typeof first === 'string') sortDesc = false
              else if (first && typeof first === 'object') {
                const entry = Object.entries(first as Record<string, unknown>)[0]
                if (entry && entry[1] && typeof entry[1] === 'object') {
                  sortDesc = (entry[1] as Record<string, unknown>).order !== 'asc'
                }
              }
            }
          }
          if (qs.get('size')) size = Number(qs.get('size')) || 10
          if (qs.get('from')) from = Number(qs.get('from')) || 0

          // 将 LogEntry 展开为文档（含 container_name 等字段）再过滤
          const docs = entries.map(e => ({ doc: toDoc(e), original: e }))
          let matched = docs.filter(d => filter(d.doc))
          matched = [...matched].sort((a, b) => {
            const tsA = Number(a.doc.timestamp)
            const tsB = Number(b.doc.timestamp)
            return sortDesc ? tsB - tsA : tsA - tsB
          })
          const page = matched.slice(from, from + size)

          res.writeHead(200)
          res.end(
            JSON.stringify({
              took: 2,
              timed_out: false,
              _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
              hits: {
                total: { value: matched.length, relation: 'eq' },
                max_score: 1,
                hits: page.map((d, i) => ({
                  _index: INDEX,
                  _id: String(from + i),
                  _score: 1,
                  _source: d.doc,
                })),
              },
            }),
          )
        })
        return
      }

      res.writeHead(404)
      res.end(JSON.stringify({ error: 'not found', status: 404 }))
    })

    server.listen(port, () => {
      const addr = server.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, url: `http://localhost:${p}`, port: p })
    })
  })
}