import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { clampToolOutput, httpGet, type ToolsetStatus } from './base.js'
import type { ResolvedToolsetConfig } from '../../config.js'

/**
 * Prometheus / VictoriaMetrics 只读查询工具集。
 * 路由对齐 HolmesGPT 的 prometheus/metrics：prometheus_url。
 */

const OUTPUT_CHARS = 30_000

export function checkPrometheusConfig(
  toolset: ResolvedToolsetConfig,
): ToolsetStatus {
  const url = toolset.config.prometheus_url
  if (typeof url !== 'string' || url.length === 0) {
    return {
      name: toolset.name,
      type: 'prometheus',
      enabled: false,
      reason: '缺少 prometheus_url',
    }
  }
  return { name: toolset.name, type: 'prometheus', enabled: true }
}

/** 发送 GET 请求并解析 JSON；非 2xx 或非 JSON 时给出稳定错误信息。 */
async function apiQuery(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
  const url = new URL(`${baseUrl}${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  const http = await httpGet(url.toString())
  const body = clampToolOutput(http.text, OUTPUT_CHARS)
  if (!http.ok) return { ok: false, output: `HTTP ${http.status}: ${body}` }
  try {
    const parsed = JSON.parse(http.text) as unknown
    return { ok: true, output: JSON.stringify(parsed, null, 2) }
  } catch {
    return { ok: false, output: `Invalid JSON (HTTP ${http.status}): ${body}` }
  }
}

const metricName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_:][A-Za-z0-9_:]*$/, '非法指标名')
const labelName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_]*$/, '非法标签名')
const matcher = z
  .string()
  .min(1)
  .max(512)
  .regex(/[A-Za-z0-9_]+[=~!]?="(?:[^"\\]|\\.)*"/, '非法标签匹配器')

/** 生成单一只读工具（闭包捕获 baseUrl）。 */
function tool<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  exec: (baseUrl: string, input: T) => Promise<{ ok: boolean; output: string }>,
  baseUrl: string,
): ToolDefinition<T> {
  return {
    name: `prometheus_${name}`,
    description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    schema,
    isReadOnly: true,
    async run(input) {
      return exec(baseUrl, input)
    },
  }
}

export function buildPrometheusTools(
  toolset: ResolvedToolsetConfig,
): ToolDefinition<unknown>[] {
  const baseUrl = String(toolset.config.prometheus_url).replace(/\/+$/, '')

  const tools: ToolDefinition<unknown>[] = [
    tool(
      'list_rules',
      'List all Prometheus alerting/recording rules.',
      z.object({}),
      (base) => apiQuery(base, '/api/v1/rules', {}),
      baseUrl,
    ),
    tool(
      'get_metric_names',
      'List all metric names, optionally refined by a matcher.',
      z.object({ matcher: matcher.optional() }),
      (base, input) => {
        const params: Record<string, string> = {}
        if (input.matcher !== undefined) params.matcher = input.matcher
        return apiQuery(base, '/api/v1/label/__name__/values', params)
      },
      baseUrl,
    ),
    tool(
      'get_label_values',
      'List values of a label, optionally refined by a matcher.',
      z.object({ label: labelName, matcher: matcher.optional() }),
      (base, input) => {
        const params: Record<string, string> = {}
        if (input.matcher !== undefined) params.matcher = input.matcher
        return apiQuery(base, `/api/v1/label/${input.label}/values`, params)
      },
      baseUrl,
    ),
    tool(
      'get_all_labels',
      'List all label names present in the store.',
      z.object({ matcher: matcher.optional() }),
      (base, input) => {
        const params: Record<string, string> = {}
        if (input.matcher !== undefined) params.matcher = input.matcher
        return apiQuery(base, '/api/v1/labels', params)
      },
      baseUrl,
    ),
    tool(
      'get_series',
      'List the time series matching one or more selectors.',
      z.object({ matches: z.array(matcher).min(1) }),
      (base, input) =>
        apiQuery(base, '/api/v1/series', { 'match[]': input.matches.join(',') }),
      baseUrl,
    ),
    tool(
      'get_metric_metadata',
      'Get metadata (type, help, unit) for metric names.',
      z.object({
        metric: metricName.optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      (base, input) => {
        const params: Record<string, string> = {}
        if (input.metric !== undefined) params.metric = input.metric
        if (input.limit !== undefined) params.limit = String(input.limit)
        return apiQuery(base, '/api/v1/metadata', params)
      },
      baseUrl,
    ),
    tool(
      'execute_prometheus_instant_query',
      'Execute an instant PromQL query at the current (or given) time.',
      z.object({ query: z.string().min(1).max(4096), time: z.string().optional() }),
      (base, input) => {
        const params: Record<string, string> = { query: input.query }
        if (input.time !== undefined) params.time = input.time
        return apiQuery(base, '/api/v1/query', params)
      },
      baseUrl,
    ),
    tool(
      'execute_prometheus_range_query',
      'Execute a PromQL query over a time range (start/end/step).',
      z.object({
        query: z.string().min(1).max(4096),
        start: z.string().min(1),
        end: z.string().min(1),
        step: z.string().min(1),
      }),
      (base, input) =>
        apiQuery(base, '/api/v1/query_range', {
          query: input.query,
          start: input.start,
          end: input.end,
          step: input.step,
        }),
      baseUrl,
    ),
  ]

  return tools
}