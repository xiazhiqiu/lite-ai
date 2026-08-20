import { z } from 'zod'
import { loadDataSources } from '../../config.js'
import type { ToolDefinition } from '../../tool.js'
import {
  PROM_DEFAULT_STEP,
  PROM_MAX_POINTS,
  __hooks,
  clampToolOutput,
  matchByDataSource,
  resolveDataSource,
  resolveDataSourceHeaders,
  type DataSourceToolset,
} from './types.js'

const PromQueryInputSchema = z.object({
  /** 数据源 name；缺省取该类型第一个命中实例（多实例消歧）。 */
  source: z.string().optional(),
  /** PromQL 查询表达式。 */
  query: z.string().min(1),
  /** true 或未提供 start/end → GET /api/v1/query（瞬时查询）。 */
  instant: z.boolean().optional(),
  /** 范围查询起始时间戳（秒）。 */
  start: z.number().optional(),
  /** 范围查询结束时间戳（秒）。 */
  end: z.number().optional(),
  /** 采样步长（秒，或 "30s"/"1m" 等 Prometheus step 格式）。 */
  step: z.union([z.number(), z.string()]).optional(),
})

type PromQueryInput = z.infer<typeof PromQueryInputSchema>

/** 把 step 解析为秒数：数字原样，字符串支持 s/m/h 后缀，非法值回退默认步长。 */
function parseStepSeconds(step: number | string | undefined): number {
  if (step === undefined) return PROM_DEFAULT_STEP
  if (typeof step === 'number') return step
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(step.trim())
  if (!match) return PROM_DEFAULT_STEP
  const value = Number(match[1])
  const factor = match[2] === 'm' ? 60 : match[2] === 'h' ? 3600 : 1
  return value * factor
}

export const promQueryTool: ToolDefinition<PromQueryInput> = {
  name: 'prom_query',
  description:
    'Query a Prometheus data source (read-only). For an instant query use "instant": true or omit start/end (GET /api/v1/query). For a range query provide start/end (and optionally step) → GET /api/v1/query_range. Sample points are limited to 5000; step is auto-adjusted when the range exceeds it. Use "source" to pick a specific data source when multiple are configured.',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Data source name (from settings dataSources). Defaults to the first matching source.',
      },
      query: { type: 'string', description: 'PromQL expression, e.g. rate(http_requests_total[5m]).' },
      instant: { type: 'boolean', description: 'Instant query via /api/v1/query.' },
      start: { type: 'number', description: 'Range start unix timestamp (seconds).' },
      end: { type: 'number', description: 'Range end unix timestamp (seconds).' },
      step: { type: 'string', description: 'Sample step (seconds, or "30s"/"1m"). Defaults to 30.' },
    },
    required: ['query'],
  },
  schema: PromQueryInputSchema,
  isReadOnly: true,
  isParallelSafe: () => true,

  async run(input) {
    try {
      const sources = await loadDataSources()
      const source = resolveDataSource(sources, 'prometheus', input.source)
      if (!source) {
        return {
          ok: false,
          output:
            'No Prometheus data source configured. Add a dataSource with type "prometheus" (or name/hint containing "prometheus") in settings.json, then retry.',
        }
      }

      const isInstant = input.instant === true || input.start === undefined || input.end === undefined
      const baseUrl = source.baseUrl.replace(/\/+$/, '')
      const headers = resolveDataSourceHeaders(source)

      if (isInstant) {
        const url = `${baseUrl}/api/v1/query?${new URLSearchParams({ query: input.query })}`
        const response = await __hooks.fetch(url, { method: 'GET', headers })
        const text = await response.text()
        if (!response.ok) {
          return {
            ok: false,
            output: `prom_query HTTP ${response.status} ${response.statusText}: ${clampToolOutput(text)}`,
          }
        }
        return { ok: true, output: clampToolOutput(text) }
      }

      const start = input.start!
      const end = input.end!
      const rangeSeconds = end - start
      const stepSeconds = parseStepSeconds(input.step)
      let effectiveStep: number | string = input.step ?? stepSeconds
      let note = ''
      if (stepSeconds > 0 && rangeSeconds / stepSeconds > PROM_MAX_POINTS) {
        const adjusted = Math.ceil(rangeSeconds / PROM_MAX_POINTS)
        effectiveStep = adjusted
        note = `\n[step adjusted to ${adjusted}s to keep <= ${PROM_MAX_POINTS} points]`
      }

      const params = new URLSearchParams({
        query: input.query,
        start: String(start),
        end: String(end),
        step: String(effectiveStep),
      })
      const url = `${baseUrl}/api/v1/query_range?${params}`
      const response = await __hooks.fetch(url, { method: 'GET', headers })
      const text = await response.text()
      if (!response.ok) {
        return {
          ok: false,
          output: `prom_query HTTP ${response.status} ${response.statusText}: ${clampToolOutput(text)}`,
        }
      }
      return { ok: true, output: clampToolOutput(`${text}${note}`) }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  },
}

export const prometheusToolset: DataSourceToolset = {
  type: 'prometheus',
  match: sources => sources.filter(s => matchByDataSource(s, 'prometheus')),
  tools: [promQueryTool],
}
