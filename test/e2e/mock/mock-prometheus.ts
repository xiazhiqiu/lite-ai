/**
 * Mock Prometheus HTTP server：从 RE2-SS metrics.csv 提供标准 Prometheus HTTP API 子集。
 *
 * 支持端点：
 *   /api/v1/query           — Instant query（EXACT metric name match）
 *   /api/v1/query_range     — Range query（EXACT metric name, start/end/step）
 *   /api/v1/label/__name__/values — 列出所有指标名
 *   /api/v1/series          — 按 matcher 匹配时序
 *   /-/ready                — 健康检查
 */
import http from 'node:http'
import type { MetricSeries } from './csv.js'

export interface PrometheusOptions {
  /** 指标时序列表 */
  series: MetricSeries[]
  /** 监听端口（默认 0 → 自动分配） */
  port?: number
}

export interface PrometheusInstance {
  server: http.Server
  url: string // base URL, e.g. http://localhost:12345
  port: number
}

/** 构造 Prometheus 序列标签 {} */
function promLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${v}"`,
  )
  return `{${parts.join(', ')}}`
}

/** 查找匹配指标名的时序 */
function findSeries(
  series: MetricSeries[],
  metricName: string,
): MetricSeries | undefined {
  return series.find(s => s.name === metricName)
}

/** 按 range query 返回采样点（外推首尾点让 Grafana 不认为数据断点） */
function rangePoints(
  series: MetricSeries,
  start: number,
  end: number,
  step: number,
): Array<[number, string]> {
  const result: Array<[number, string]> = []
  if (series.points.length === 0) return result

  // 排序
  const pts = [...series.points].sort((a, b) => a[0] - b[0])

  // 取第一个时间戳之前的值：用第一个点填充
  let currentIdx = 0
  let t = start
  while (t <= end) {
    // 向前推进索引
    while (currentIdx < pts.length - 1 && pts[currentIdx + 1]![0] <= t) {
      currentIdx++
    }
    if (pts[currentIdx] && pts[currentIdx]![0] <= t) {
      result.push([t, String(pts[currentIdx]![1])])
    }
    // 如果 t 在数据范围外但 step 还在范围内，用最近的点填充
    else if (pts.length > 0) {
      // 在第一个数据点之前：用第一个值
      if (t < pts[0]![0]) {
        result.push([t, String(pts[0]![1])])
      }
      // 在最后一个数据点之后：用最后一个值
      else if (t > pts[pts.length - 1]![0]) {
        result.push([t, String(pts[pts.length - 1]![1])])
      }
    }
    t += step
  }

  return result
}

/** 按 instant query 取最近的值 */
function instantValue(
  series: MetricSeries,
  time: number,
): [number, string] | null {
  const pts = [...series.points].sort((a, b) => a[0] - b[0])
  // 找 <= time 的最近点
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i]![0] <= time) {
      return [pts[i]![0], String(pts[i]![1])]
    }
  }
  // 无前面的点，用第一个点
  if (pts.length > 0) {
    return [pts[0]![0], String(pts[0]![1])]
  }
  return null
}

/** URL 解析：从 query string 取参数 */
function parseQueryParams(
  url: string,
): Record<string, string> {
  const idx = url.indexOf('?')
  if (idx < 0) return {}
  const params: Record<string, string> = {}
  for (const part of url.slice(idx + 1).split('&')) {
    const eq = part.indexOf('=')
    if (eq > 0) {
      params[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(
        part.slice(eq + 1),
      )
    }
  }
  return params
}

/** 解析 PromQL 查询提取指标名（仅支持 `metric_name` 和 `metric_name{...}` 形式） */
function extractMetricName(promql: string): string | null {
  // 处理 {__name__="xxx"} 形式
  const nameLabel = promql.match(/\{__name__\s*=\s*"([^"]+)"\}/)
  if (nameLabel) return nameLabel[1]!
  // 处理 裸 metric_name（允许 - . 等，RE2-SS 指标名多含连字符）
  const bare = promql.match(/^([a-zA-Z_][a-zA-Z0-9_.-]*)/)
  if (bare) return bare[1]!
  return null
}

export function createPrometheusServer(
  options: PrometheusOptions,
): Promise<PrometheusInstance> {
  return new Promise((resolve) => {
    const { series, port = 0 } = options
    const server = http.createServer((req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Content-Type', 'application/json')

      // 健康检查
      if (req.url === '/-/ready') {
        res.writeHead(200)
        res.end(JSON.stringify({ status: 'ready' }))
        return
      }

      // 列出指标名
      if (req.url === '/api/v1/label/__name__/values') {
        const names = [...new Set(series.map(s => s.name))]
        res.writeHead(200)
        res.end(JSON.stringify({ status: 'success', data: names }))
        return
      }

      // 查询系列
      if (req.url?.startsWith('/api/v1/series')) {
        const params = parseQueryParams(req.url)
        const match = params['match[]'] ?? ''
        const mName = match ? extractMetricName(match) : null
        const matched = mName
          ? series.filter(s => s.name === mName)
          : series
        res.writeHead(200)
        res.end(
          JSON.stringify({
            status: 'success',
            data: matched.map(s => ({
              __name__: s.name,
              ...s.labels,
            })),
          }),
        )
        return
      }

      // range query
      if (req.url?.startsWith('/api/v1/query_range')) {
        const params = parseQueryParams(req.url)
        const query = params.query ?? ''
        const start = Number(params.start) || 0
        const end = Number(params.end) || 0
        const step = Number(params.step) || 15
        const mName = extractMetricName(query)
        const matched = findSeries(series, mName ?? '')

        if (!matched) {
          res.writeHead(200)
          res.end(JSON.stringify({ status: 'success', data: { result: [] } }))
          return
        }
        const values = rangePoints(matched, start, end, step)
        res.writeHead(200)
        res.end(
          JSON.stringify({
            status: 'success',
            data: {
              resultType: 'matrix',
              result: [
                {
                  metric: { __name__: matched.name, ...matched.labels },
                  values: values.map(([t, v]) => [t, v]),
                },
              ],
            },
          }),
        )
        return
      }

      // instant query
      if (req.url?.startsWith('/api/v1/query')) {
        const params = parseQueryParams(req.url)
        const query = params.query ?? ''
        const time = Number(params.time) || Date.now() / 1000
        const mName = extractMetricName(query)
        const matched = findSeries(series, mName ?? '')

        if (!matched) {
          res.writeHead(200)
          res.end(JSON.stringify({ status: 'success', data: { result: [] } }))
          return
        }
        const iv = instantValue(matched, time)
        if (!iv) {
          res.writeHead(200)
          res.end(JSON.stringify({ status: 'success', data: { result: [] } }))
          return
        }
        res.writeHead(200)
        res.end(
          JSON.stringify({
            status: 'success',
            data: {
              resultType: 'vector',
              result: [
                {
                  metric: { __name__: matched.name, ...matched.labels },
                  value: iv,
                },
              ],
            },
          }),
        )
        return
      }

      // fallback
      res.writeHead(404)
      res.end(JSON.stringify({ status: 'error', error: 'not found' }))
    })

    server.listen(port, () => {
      const addr = server.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, url: `http://localhost:${p}`, port: p })
    })
  })
}