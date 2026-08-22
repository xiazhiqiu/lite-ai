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
 * Grafana Tempo 只读查询工具集（对齐 HolmesGPT grafana/tempo toolset）。
 * 路由：直接连 Tempo 的 HTTP API（默认 3200）；配置 grafana_datasource_uid 时，
 * 请求经 `${api_url}/api/datasources/proxy/uid/{uid}` 走 Grafana 数据源代理。
 *
 * 覆盖 4 类能力：
 *   - 搜索：TraceQL（/api/search?q=）、legacy 标签（/api/search?tags=）
 *   - 明细：/api/v2/traces/{trace_id}（OpenTelemetry 格式）
 *   - 元数据：/api/v2/search/tags、/api/v2/search/tag/{tag}/values
 *   - TraceQL 指标：/api/metrics/query、/api/metrics/query_range
 */

const DEFAULT_GRAPH_TIME_SPAN_SECONDS = 3600 // 与 HolmesGPT 一致：默认回看 1 小时
const MAX_GRAPH_POINTS = 300

export function checkTempoConfig(
  toolset: ResolvedToolsetConfig,
): ToolsetStatus {
  const url = toolset.config.api_url
  if (typeof url !== 'string' || url.length === 0) {
    return {
      name: toolset.name,
      type: 'tempo',
      enabled: false,
      reason: '缺少 api_url',
    }
  }
  return { name: toolset.name, type: 'tempo', enabled: true }
}

type LabelMapping = {
  pod: string
  namespace: string
  deployment: string
  node: string
  service: string
}

const DEFAULT_LABELS: LabelMapping = {
  pod: 'k8s.pod.name',
  namespace: 'k8s.namespace.name',
  deployment: 'k8s.deployment.name',
  node: 'k8s.node.name',
  service: 'service.name',
}

type TempoClient = {
  baseUrl: string
  headers: Record<string, string>
  auth?: { username: string; password: string }
  timeoutMs: number
  labels: LabelMapping
}

function readLabels(config: Record<string, unknown>): LabelMapping {
  const raw = config.labels
  if (typeof raw !== 'object' || raw === null) return DEFAULT_LABELS
  const rec = raw as Record<string, unknown>
  const pick = (key: keyof LabelMapping): string => {
    const v = rec[key]
    return typeof v === 'string' && v.length > 0 ? v : DEFAULT_LABELS[key]
  }
  return {
    pod: pick('pod'),
    namespace: pick('namespace'),
    deployment: pick('deployment'),
    node: pick('node'),
    service: pick('service'),
  }
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
function buildClient(config: Record<string, unknown>): TempoClient {
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
    labels: readLabels(config),
  }
}

function buildAuthHeaders(client: TempoClient): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...client.headers }
  if (client.auth) {
    const token = Buffer.from(
      `${client.auth.username}:${client.auth.password}`,
      'utf8',
    ).toString('base64')
    headers.Authorization = `Basic ${token}`
  }
  return headers
}

function replacePathParams(
  template: string,
  pathParams: Record<string, string>,
): string {
  let path = template
  for (const [key, value] of Object.entries(pathParams)) {
    path = path.replace(`{${key}}`, encodeURIComponent(value))
  }
  return path
}

/** 统一 GET 请求：组装 URL + 认证头 + 超时，返回原始响应。 */
async function tempoGet(
  client: TempoClient,
  pathTemplate: string,
  pathParams: Record<string, string>,
  params: Record<string, string>,
): Promise<HttpResult> {
  const path = replacePathParams(pathTemplate, pathParams)
  const url = new URL(`${client.baseUrl}${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return httpGet(url.toString(), {
    headers: buildAuthHeaders(client),
    timeoutMs: client.timeoutMs,
  })
}

/** 把 Tempo 响应格式化为稳定输出；listData 时对字符串数组做摘要。 */
function formatResponse(
  http: HttpResult,
  listData = false,
): { ok: boolean; output: string } {
  if (!http.ok) {
    return { ok: false, output: clampToolOutput(`HTTP ${http.status}: ${http.text}`, DEFAULT_OUTPUT_CHARS) }
  }
  try {
    const parsed = JSON.parse(http.text) as { data?: unknown }
    if (listData && Array.isArray(parsed.data)) {
      const values = parsed.data as string[]
      const max = 30
      parsed.data =
        values.length <= max
          ? `${values.length} total: [${values.join(', ')}]`
          : `${values.length} total: [${values.slice(0, max).join(', ')}] ...(${values.length - max} more omitted)`
    }
    return { ok: true, output: clampToolOutput(JSON.stringify(parsed, null, 2), DEFAULT_OUTPUT_CHARS) }
  } catch {
    return { ok: false, output: clampToolOutput(`Invalid JSON (HTTP ${http.status}): ${http.text}`, DEFAULT_OUTPUT_CHARS) }
  }
}

// ---------- 时间 / 步长解析 ----------

const UNIT_SECONDS: Record<string, number> = {
  w: 7 * 24 * 3600,
  d: 24 * 3600,
  h: 3600,
  m: 60,
  s: 1,
}

function toUnixSeconds(raw: string, base: number): number {
  const s = raw.trim()
  const parsedDate = Date.parse(s)
  if (!Number.isNaN(parsedDate)) return Math.floor(parsedDate / 1000)
  if (/^-?\d+$/.test(s)) return base + Number(s) // 相对秒数（支持负值）
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

function durationToSeconds(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const pattern = /(\d+)([wdhms])/g
  let total = 0
  let matched = false
  let m: RegExpExecArray | null
  while ((m = pattern.exec(value)) !== null) {
    matched = true
    total += Number(m[1]) * UNIT_SECONDS[m[2]]
  }
  if (!matched) throw new Error(`非法持续时长: ${value}`)
  return total
}

function secondsToDuration(seconds: number): string {
  if (seconds < 0) seconds = 0
  const parts: string[] = []
  let rest = seconds
  const units: Array<[string, number]> = [
    ['w', 7 * 24 * 3600],
    ['d', 24 * 3600],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ]
  for (const [unit, size] of units) {
    const count = Math.floor(rest / size)
    if (count > 0) {
      parts.push(`${count}${unit}`)
      rest -= count * size
    }
  }
  return parts.length > 0 ? parts.join('') : '0s'
}

/** TraceQL 指标 range 的 step 校准：保证点数 <= MAX_GRAPH_POINTS。 */
function resolveStep(
  timeRangeSeconds: number,
  stepRaw: unknown,
): string {
  const smallest = Math.ceil(timeRangeSeconds / MAX_GRAPH_POINTS)
  let stepSec: number
  if (stepRaw !== undefined && stepRaw !== null && String(stepRaw).trim() !== '') {
    stepSec = Math.max(smallest, durationToSeconds(String(stepRaw).trim()))
  } else {
    stepSec = smallest
  }
  return secondsToDuration(stepSec)
}

// ---------- k8s 过滤 ----------

function escapeQuote(value: string): string {
  return value.replaceAll('"', '\\"')
}

/** 由 service/pod/namespace/deployment/node 参数构造 TraceQL 过滤器数组（部分匹配用 =~）。 */
function buildFilters(
  client: TempoClient,
  params: Record<string, unknown>,
  useExactMatch: boolean,
): string[] {
  const prefix = 'resource.'
  const mappings: Array<[string, keyof LabelMapping]> = [
    ['service_name', 'service'],
    ['pod_name', 'pod'],
    ['namespace_name', 'namespace'],
    ['deployment_name', 'deployment'],
    ['node_name', 'node'],
  ]
  const filters: string[] = []
  for (const [paramName, attr] of mappings) {
    const value = params[paramName]
    if (value === undefined || value === null || String(value).trim() === '') continue
    const attribute = prefix + client.labels[attr]
    filters.push(
      useExactMatch
        ? `${attribute}="${escapeQuote(String(value))}"`
        : `${attribute}=~".*${String(value)}.*"`,
    )
  }
  return filters
}

// ---------- tool 工厂 ----------

function tool<T>(
  client: TempoClient,
  name: string,
  description: string,
  schema: z.ZodType<T>,
  exec: (client: TempoClient, input: T) => Promise<{ ok: boolean; output: string }>,
): ToolDefinition<T> {
  return {
    name: `tempo_${name}`,
    description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    schema,
    isReadOnly: true,
    async run(input) {
      return exec(client, input)
    },
  }
}

const traceId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9]+$/, '非法 trace ID（仅十六进制字符）')

/** 通用 start/end 参数（RFC3339 或 Unix 秒数）。 */
const timeRangeSchema = {
  start: z.string().min(1).max(128).optional(),
  end: z.string().min(1).max(128).optional(),
}

function searchParamsOf(
  start: number,
  end: number,
  limit?: number,
  spss?: number,
): Record<string, string> {
  const params: Record<string, string> = { start: String(start), end: String(end) }
  if (limit !== undefined) params.limit = String(limit)
  if (spss !== undefined) params.spss = String(spss)
  return params
}

export function buildTempoTools(
  toolset: ResolvedToolsetConfig,
): ToolDefinition<unknown>[] {
  const client = buildClient(toolset.config)

  return [
    // ---- 对比采样（最快/典型/最慢）----
    tool(
      client,
      'fetch_traces_comparative_sample',
      'Fetches statistics and representative samples of fast, slow, and typical traces for performance analysis. Requires either a `base_query` OR at least one of `service_name`, `pod_name`, `namespace_name`, `deployment_name`, `node_name`. Call this tool first when investigating performance issues via traces.',
      z.object({
        service_name: z.string().min(1).max(256).optional(),
        pod_name: z.string().min(1).max(256).optional(),
        namespace_name: z.string().min(1).max(256).optional(),
        deployment_name: z.string().min(1).max(256).optional(),
        node_name: z.string().min(1).max(256).optional(),
        base_query: z
          .string()
          .min(1)
          .max(2048)
          .optional(),
        sample_count: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional(),
        ...timeRangeSchema,
      }),
      async (c, input) => {
        let baseQuery: string
        if (input.base_query) {
          baseQuery = input.base_query
        } else {
          const filters = buildFilters(c, input as Record<string, unknown>, false)
          if (filters.length === 0) {
            return {
              ok: false,
              output:
                'At least one of service_name/pod_name/namespace_name/deployment_name/node_name or base_query is required but none were provided.',
            }
          }
          baseQuery = filters.join(' && ')
        }

        const [start, end] = resolveTimeRange(input.start, input.end)
        const maxTraces = 1000
        const search = await tempoGet(
          c,
          '/api/search',
          {},
          { q: `{${baseQuery}}`, ...searchParamsOf(start, end, maxTraces) },
        )
        if (!search.ok) return formatResponse(search)

        let parsed: { traces?: unknown[] }
        try {
          parsed = JSON.parse(search.text) as { traces?: unknown[] }
        } catch {
          return formatResponse(search)
        }
        const traces = parsed.traces ?? []
        if (traces.length === 0) {
          return { ok: true, output: 'No traces found matching the query' }
        }

        const sorted = [...traces].sort(
          (a, b) => (duration(a) || 0) - (duration(b) || 0),
        )
        const durations = sorted.map(duration)
        const sampleCount = input.sample_count ?? 3

        const stats = {
          trace_count: durations.length,
          min_ms: durations[0],
          p25_ms: percentile(durations, 0.25),
          p50_ms: percentile(durations, 0.5),
          p75_ms: percentile(durations, 0.75),
          p90_ms: percentile(durations, 0.9),
          p99_ms: percentile(durations, 0.99),
          max_ms: durations[durations.length - 1],
        }

        const fastestIndices = Array.from(
          { length: Math.min(sampleCount, sorted.length) },
          (_, i) => i,
        )
        const slowestIndices = Array.from(
          { length: Math.min(sampleCount, sorted.length) },
          (_, i) => Math.max(0, sorted.length - sampleCount) + i,
        )
        const medianIndex = Math.floor(sorted.length / 2)

        const selectedIndices = Array.from(
          new Set([...fastestIndices, medianIndex, ...slowestIndices]),
        )
        const fetched = await Promise.all(
          selectedIndices.map(async i => ({
            i,
            data: await fetchFullTrace(c, sorted[i]),
          })),
        )
        const byIndex = new Map(fetched.map(r => [r.i, r.data]))
        const fastest = fastestIndices.map(i => byIndex.get(i))
        const median = byIndex.get(medianIndex)
        const slowest = slowestIndices.map(i => byIndex.get(i))

        return {
          ok: true,
          output: clampToolOutput(
            JSON.stringify(
              { statistics: stats, fastest_traces: fastest, median_trace: median, slowest_traces: slowest },
              null,
              2,
            ),
            60_000,
          ),
        }
      },
    ),

    // ---- 按 TraceQL 搜索 ----
    tool(
      client,
      'search_traces_by_query',
      'Search for traces using TraceQL query language (recommended). Supports span/resource attributes, duration, and aggregates count()/avg()/min()/max()/sum(). Example: {resource.service.name="frontend" && status=error}.',
      z.object({
        q: z.string().min(1).max(4096),
        limit: z.number().int().min(1).max(1000).optional(),
        spss: z.number().int().min(1).max(1000).optional(),
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const http = await tempoGet(
          c,
          '/api/search',
          {},
          { q: input.q, ...searchParamsOf(start, end, input.limit, input.spss) },
        )
        return formatResponse(http)
      },
    ),

    // ---- 按标签搜索（legacy）----
    tool(
      client,
      'search_traces_by_tags',
      'Search for traces using logfmt-encoded tags (legacy). Example: service.name="api" http.status_code="500". Supports min_duration/max_duration.',
      z.object({
        tags: z.string().min(1).max(2048),
        min_duration: z.string().min(1).max(32).optional(),
        max_duration: z.string().min(1).max(32).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        spss: z.number().int().min(1).max(1000).optional(),
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const params = searchParamsOf(start, end, input.limit, input.spss)
        params.tags = input.tags
        if (input.min_duration !== undefined) params.minDuration = input.min_duration
        if (input.max_duration !== undefined) params.maxDuration = input.max_duration
        const http = await tempoGet(c, '/api/search', {}, params)
        return formatResponse(http)
      },
    ),

    // ---- 按 trace ID 查明细 ----
    tool(
      client,
      'query_trace_by_id',
      'Retrieve detailed trace information by trace ID. Returns the full trace data in OpenTelemetry format.',
      z.object({
        trace_id: traceId,
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const http = await tempoGet(
          c,
          '/api/v2/traces/{trace_id}',
          { trace_id: input.trace_id },
          { start: String(start), end: String(end) },
        )
        return formatResponse(http)
      },
    ),

    // ---- 标签名 ----
    tool(
      client,
      'search_tag_names',
      'Discover available tag names across traces, organized by scope (resource/span/intrinsic).',
      z.object({
        scope: z.enum(['resource', 'span', 'intrinsic']).optional(),
        q: z.string().min(1).max(4096).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        max_stale_values: z.number().int().min(0).optional(),
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const params: Record<string, string> = { start: String(start), end: String(end) }
        if (input.scope !== undefined) params.scope = input.scope
        if (input.q !== undefined) params.q = input.q
        if (input.limit !== undefined) params.limit = String(input.limit)
        if (input.max_stale_values !== undefined) {
          params.maxStaleValues = String(input.max_stale_values)
        }
        const http = await tempoGet(c, '/api/v2/search/tags', {}, params)
        return formatResponse(http)
      },
    ),

    // ---- 标签值 ----
    tool(
      client,
      'search_tag_values',
      "Get all values for a specific tag. Useful for discovering what values exist (e.g. 'resource.service.name').",
      z.object({
        tag: z.string().min(1).max(256),
        q: z.string().min(1).max(4096).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        max_stale_values: z.number().int().min(0).optional(),
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const params: Record<string, string> = { start: String(start), end: String(end) }
        if (input.q !== undefined) params.q = input.q
        if (input.limit !== undefined) params.limit = String(input.limit)
        if (input.max_stale_values !== undefined) {
          params.maxStaleValues = String(input.max_stale_values)
        }
        const http = await tempoGet(
          c,
          '/api/v2/search/tag/{tag}/values',
          { tag: input.tag },
          params,
        )
        return formatResponse(http)
      },
    ),

    // ---- TraceQL 指标：瞬时 ----
    tool(
      client,
      'query_metrics_instant',
      'Compute a single TraceQL metric value across the time range. Syntax: {selector} | function(attribute) [by (grouping)]. Preferred over range when only a total/summary is needed.',
      z.object({
        q: z.string().min(1).max(4096),
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const http = await tempoGet(
          c,
          '/api/metrics/query',
          {},
          { q: input.q, start: String(start), end: String(end) },
        )
        return formatResponse(http)
      },
    ),

    // ---- TraceQL 指标：区间 ----
    tool(
      client,
      'query_metrics_range',
      'Get time series data from TraceQL metrics queries, computed at regular intervals (step). Use for graphing/trend analysis.',
      z.object({
        q: z.string().min(1).max(4096),
        step: z.string().min(1).max(32).optional(),
        exemplars: z.number().int().min(1).max(1000).optional(),
        ...timeRangeSchema,
      }),
      async (c, input) => {
        const [start, end] = resolveTimeRange(input.start, input.end)
        const params: Record<string, string> = {
          q: input.q,
          start: String(start),
          end: String(end),
          step: resolveStep(end - start, input.step),
        }
        if (input.exemplars !== undefined) params.exemplars = String(input.exemplars)
        const http = await tempoGet(c, '/api/metrics/query_range', {}, params)
        return formatResponse(http)
      },
    ),
  ]
}

// ---------- 对比采样辅助 ----------

function duration(trace: unknown): number {
  if (typeof trace !== 'object' || trace === null) return 0
  const v = (trace as { durationMs?: unknown }).durationMs
  return typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0
}

/** 排序后数组的分位数索引采样（对应 HolmesGPT 的 p25/p50/...）。 */
function percentile(sorted: number[], ratio: number): number {
  const len = sorted.length
  if (ratio <= 0) return sorted[0]
  if (ratio >= 1) return sorted[len - 1]
  if (len < 4 && (ratio === 0.25 || ratio === 0.75)) {
    return ratio === 0.25 ? sorted[0] : sorted[len - 1]
  }
  if (len < 10 && ratio === 0.9) return sorted[len - 1]
  if (len < 100 && ratio === 0.99) return sorted[len - 1]
  return sorted[Math.floor(len * ratio)]
}

async function fetchFullTrace(
  client: TempoClient,
  summary: unknown,
): Promise<{ traceID: string; durationMs: number; rootServiceName: string; traceData: unknown }> {
  const rec = (summary ?? {}) as Record<string, unknown>
  const id = rec.traceID
  if (typeof id !== 'string' || id.length === 0) {
    return { traceID: 'unknown', durationMs: 0, rootServiceName: 'unknown', traceData: null }
  }
  const startNano = rec.startTimeUnixNano
  const traceStart =
    typeof startNano === 'number' || typeof startNano === 'string'
      ? Math.floor(Number(startNano) / 1_000_000_000)
      : undefined
  const params: Record<string, string> = {}
  if (traceStart !== undefined && Number.isFinite(traceStart)) {
    params.start = String(traceStart)
  }
  const http = await tempoGet(client, '/api/v2/traces/{trace_id}', { trace_id: id }, params)
  if (!http.ok) {
    return {
      traceID: id,
      durationMs: duration(summary),
      rootServiceName: String(rec.rootServiceName ?? 'unknown'),
      traceData: { error: clampToolOutput(http.text, 2000) },
    }
  }
  try {
    return {
      traceID: id,
      durationMs: duration(summary),
      rootServiceName: String(rec.rootServiceName ?? 'unknown'),
      traceData: JSON.parse(http.text) as unknown,
    }
  } catch {
    return { traceID: id, durationMs: duration(summary), rootServiceName: 'unknown', traceData: null }
  }
}