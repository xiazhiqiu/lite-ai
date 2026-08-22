import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import type { ResolvedToolsetConfig } from '../../config.js'
import {
  clampToolOutput,
  httpGet,
  DEFAULT_OUTPUT_CHARS,
  type HttpResult,
  type ToolsetStatus,
} from './base.js'

/**
 * Grafana Loki 只读查询工具集（对齐 HolmesGPT grafana/loki toolset）。
 * 路由：直接连 Loki HTTP API（默认 3100）；配置 grafana_datasource_uid 时，
 * 请求经 `${api_url}/api/datasources/proxy/uid/{uid}` 走 Grafana 数据源代理。
 *
 * 覆盖 4 类能力：
 *   - 按 LogQL 查询日志：/loki/api/v1/query_range
 *   - 标签名：/loki/api/v1/labels
 *   - 标签值：/loki/api/v1/label/{name}/values
 *   - 标签系列：/loki/api/v1/series
 */

const DEFAULT_GRAPH_TIME_SPAN_SECONDS = 3600 // 默认回看 1 小时
const LOG_LIMIT = 100 // 默认日志条数上限

export function checkLokiConfig(
  toolset: ResolvedToolsetConfig,
): ToolsetStatus {
  const url = toolset.config.api_url
  if (typeof url !== 'string' || url.length === 0) {
    return {
      name: toolset.name,
      type: 'loki',
      enabled: false,
      reason: '缺少 api_url',
    }
  }
  return { name: toolset.name, type: 'loki', enabled: true }
}

type LokiClient = {
  baseUrl: string
  headers: Record<string, string>
  auth?: { username: string; password: string }
  timeoutMs: number
}

function readHeaders(config: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {}
  const additional = config.additional_headers
  if (typeof additional === 'object' && additional !== null) {
    for (const [key, value] of Object.entries(
      additional as Record<string, unknown>,
    )) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  const apiKey = config.api_key
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

function readTimeoutMs(config: Record<string, unknown>): number {
  const raw = Number(config.timeout_seconds ?? 30) * 1000
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000
}

/** 解析连接参数 → 内部客户端（含 Grafana 代理 baseUrl 与认证头）。 */
function buildClient(config: Record<string, unknown>): LokiClient {
  const apiUrl = String(config.api_url ?? '').replace(/\/+$/, '')
  const uid = config.grafana_datasource_uid
  const baseUrl =
    typeof uid === 'string' && uid.length > 0
      ? `${apiUrl}/api/datasources/proxy/uid/${encodeURIComponent(uid)}`
      : apiUrl

  const username = config.username
  const password = config.password
  const auth =
    typeof username === 'string' &&
    username.length > 0 &&
    typeof password === 'string' &&
    password.length > 0
      ? { username, password }
      : undefined

  return {
    baseUrl,
    headers: readHeaders(config),
    auth,
    timeoutMs: readTimeoutMs(config),
  }
}

function buildAuthHeaders(client: LokiClient): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...client.headers,
  }
  if (client.auth) {
    const token = Buffer.from(
      `${client.auth.username}:${client.auth.password}`,
      'utf8',
    ).toString('base64')
    headers.Authorization = `Basic ${token}`
  }
  return headers
}

/** 统一 GET 请求，返回原始响应。 */
async function lokiGet(
  client: LokiClient,
  path: string,
  params: Record<string, string>,
): Promise<HttpResult> {
  const url = new URL(`${client.baseUrl}${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return httpGet(url.toString(), {
    headers: buildAuthHeaders(client),
    timeoutMs: client.timeoutMs,
  })
}

/** 统一格式化 Loki 响应。 */
function formatResponse(
  http: HttpResult,
  maxChars: number = DEFAULT_OUTPUT_CHARS,
): { ok: boolean; output: string } {
  if (!http.ok) {
    return {
      ok: false,
      output: clampToolOutput(`HTTP ${http.status}: ${http.text}`, maxChars),
    }
  }
  try {
    const parsed = JSON.parse(http.text) as unknown
    return {
      ok: true,
      output: clampToolOutput(JSON.stringify(parsed, null, 2), maxChars),
    }
  } catch {
    return {
      ok: false,
      output: clampToolOutput(`Invalid JSON (HTTP ${http.status}): ${http.text}`, maxChars),
    }
  }
}

// ---------- 时间戳解析 ----------

function toUnixSeconds(raw: string, base: number): number {
  const s = raw.trim()
  const parsedDate = Date.parse(s)
  if (!Number.isNaN(parsedDate)) return Math.floor(parsedDate / 1000)
  if (/^-?\d+$/.test(s)) return base + Number(s)
  throw new Error(`无法解析时间戳: "${raw}"（支持 RFC3339 或 Unix 秒数）`)
}

/** 归一化 start/end 为 Unix 秒；缺省 end=now，start=end-1h。 */
function resolveTimeRange(
  startRaw: unknown,
  endRaw: unknown,
): [number, number] {
  const now = Math.floor(Date.now() / 1000)
  let end: number
  const endStr = endRaw !== null && endRaw !== undefined ? String(endRaw).trim() : ''
  if (endStr === '' || endStr === '0') end = now
  else end = toUnixSeconds(endStr, now)

  let start: number
  const startStr =
    startRaw !== null && startRaw !== undefined ? String(startRaw).trim() : ''
  if (startStr === '') start = end - DEFAULT_GRAPH_TIME_SPAN_SECONDS
  else start = toUnixSeconds(startStr, end)
  return start > end ? [end, start] : [start, end]
}

// ---------- tool 工厂 ----------

function tool<T>(
  client: LokiClient,
  name: string,
  description: string,
  schema: z.ZodType<T>,
  exec: (client: LokiClient, input: T) => Promise<{ ok: boolean; output: string }>,
): ToolDefinition<T> {
  return {
    name: `loki_${name}`,
    description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    schema,
    isReadOnly: true,
    async run(input) {
      return exec(client, input)
    },
  }
}

/** 通用 start/end 参数（RFC3339 或 Unix 秒数），供各工具 schema 展开。 */
const timeRangeSchema = {
  start: z.string().min(1).max(128).optional(),
  end: z.string().min(1).max(128).optional(),
}

export function buildLokiTools(
  toolset: ResolvedToolsetConfig,
): ToolDefinition<unknown>[] {
  const client = buildClient(toolset.config)

  return [
    // ---- LogQL 查询 ----
    tool(
      client,
      'query_logs',
      'Query Loki for log lines using LogQL. Supports label matchers, line filters (|= |=~ != !~), and log pipeline operators. Example: {service_name="paymentservice"} |= "error" != "timeout". Returns log entries with timestamps.',
      z.object({
        query: z.string().min(1).max(4096),
        limit: z.number().int().min(1).max(5000).optional(),
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const params: Record<string, string> = {
          query: input.query,
          start: `${start}000000000`,
          end: `${end}000000000`,
          limit: String(input.limit ?? LOG_LIMIT),
          direction: 'backward',
        }
        // 日志输出可能很长，放大上限但做智能截断
        const http = await lokiGet(c, '/loki/api/v1/query_range', params)
        if (!http.ok) return formatResponse(http)
        try {
          const parsed = JSON.parse(http.text) as {
            data?: { result?: unknown }
          }
          const result = parsed.data?.result
          if (Array.isArray(result)) {
            const total = result.reduce<number>(
              (acc, stream: unknown) =>
                acc + ((stream as { values?: unknown[] }).values?.length ?? 0),
              0,
            )
            return {
              ok: true,
              output: clampToolOutput(
                `${JSON.stringify(parsed, null, 2)}\n\n[log streams: ${result.length}, entries: ${total}]`,
                60_000,
              ),
            }
          }
          return { ok: true, output: clampToolOutput(JSON.stringify(parsed, null, 2), 60_000) }
        } catch {
          return formatResponse(http, 60_000)
        }
      },
    ),

    // ---- 标签名 ----
    tool(
      client,
      'query_labels',
      'Get all label names currently configured in Loki.',
      z.object({
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const http = await lokiGet(c, '/loki/api/v1/labels', {
          start: `${start}000000000`,
          end: `${end}000000000`,
        })
        return formatResponse(http)
      },
    ),

    // ---- 标签值 ----
    tool(
      client,
      'query_label_values',
      'Get values for a specific label name. Useful for discovering available service names, status codes, etc.',
      z.object({
        label: z.string().min(1).max(256),
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const label = encodeURIComponent(input.label)
        const http = await lokiGet(c, `/loki/api/v1/label/${label}/values`, {
          start: `${start}000000000`,
          end: `${end}000000000`,
        })
        return formatResponse(http)
      },
    ),

    // ---- 标签系列 ----
    tool(
      client,
      'query_series',
      'Get the set of label combinations (series) matching a LogQL label matcher. Example: {service_name=~"payment.*"}.',
      z.object({
        match: z.string().min(1).max(2048),
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const http = await lokiGet(c, '/loki/api/v1/series', {
          match: input.match,
          start: `${start}000000000`,
          end: `${end}000000000`,
        })
        return formatResponse(http)
      },
    ),
  ]
}