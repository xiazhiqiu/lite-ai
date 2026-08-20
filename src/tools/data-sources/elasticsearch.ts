import { z } from 'zod'
import type { DataSourceConfig } from '../../config.js'
import { loadDataSources } from '../../config.js'
import type { ToolDefinition } from '../../tool.js'
import {
  ES_MAX_SIZE,
  __hooks,
  clampToolOutput,
  matchByDataSource,
  resolveDataSource,
  resolveDataSourceHeaders,
  type DataSourceToolset,
} from './types.js'

const DEFAULT_INDEX = 'sock-shop-logs'

const EsQueryInputSchema = z.object({
  /** 数据源 name；缺省取该类型第一个命中实例（多实例消歧）。 */
  source: z.string().optional(),
  /** 索引名；缺省取 hint 中索引名或 "sock-shop-logs"。 */
  index: z.string().optional(),
  /** LiteQueryString → body.query.query_string。 */
  q: z.string().optional(),
  /** 提供则原样 POST /{index}/_search。 */
  dsl: z.record(z.string(), z.unknown()).optional(),
  from: z.number().int().min(0).optional(),
  size: z.number().int().min(1).optional(),
  sort: z.string().optional(),
})

type EsQueryInput = z.infer<typeof EsQueryInputSchema>

/** 从 hint 中提取索引名（如 "索引 sock-shop-logs"），找不到返回 null。 */
function extractHintIndex(hint: string | undefined): string | null {
  if (!hint) return null
  const match = /(?:index|索引)[\s:=：]+([A-Za-z0-9_.*-]+)/i.exec(hint)
  return match?.[1] ?? null
}

function guessIndex(input: EsQueryInput, source: DataSourceConfig): string {
  if (input.index !== undefined) return input.index
  return extractHintIndex(source.hint) ?? DEFAULT_INDEX
}

/** 构造 _search 请求体：dsl 原样透传，否则按 q 拼 query_string，并写入夹逼后的 from/size/sort。 */
function buildSearchBody(input: EsQueryInput, size: number): unknown {
  if (input.dsl !== undefined) return input.dsl
  const body: Record<string, unknown> = {
    size,
  }
  if (input.q !== undefined) {
    body.query = { query_string: { query: input.q } }
  }
  if (input.from !== undefined) body.from = input.from
  if (input.sort !== undefined) body.sort = input.sort
  return body
}

export const esQueryTool: ToolDefinition<EsQueryInput> = {
  name: 'es_query',
  description:
    'Query an Elasticsearch data source (read-only). Sends a search request to the _search endpoint only; no write endpoints are reachable. Provide "q" for a query_string search, or "dsl" to pass the full search body verbatim. Use "source" to pick a specific data source when multiple are configured. size is clamped to 100.',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Data source name (from settings dataSources). Defaults to the first matching source.',
      },
      index: { type: 'string', description: 'Index name. Defaults to the hint index or sock-shop-logs.' },
      q: { type: 'string', description: 'LiteQueryString search, mapped to query.query_string.' },
      dsl: {
        type: 'object',
        description: 'Full ES search body to send verbatim to POST /{index}/_search. Preferred over "q" for complex queries.',
      },
      from: { type: 'number', description: 'Offset for pagination.' },
      size: { type: 'number', description: 'Max hits to return (default 10, clamped to 100).' },
      sort: { type: 'string', description: 'Sort expression, e.g. "@timestamp:desc".' },
    },
  },
  schema: EsQueryInputSchema,
  isReadOnly: true,
  isParallelSafe: () => true,

  async run(input) {
    try {
      const sources = await loadDataSources()
      const source = resolveDataSource(sources, 'elasticsearch', input.source)
      if (!source) {
        return {
          ok: false,
          output:
            'No Elasticsearch data source configured. Add a dataSource with type "elasticsearch" (or name/hint containing "elastic") in settings.json, then retry.',
        }
      }

      const rawSize = input.size ?? 10
      const size = Math.min(rawSize, ES_MAX_SIZE)
      const clamped = rawSize > ES_MAX_SIZE
      const index = guessIndex(input, source)
      const body = buildSearchBody(input, size)
      const baseUrl = source.baseUrl.replace(/\/+$/, '')
      const url = `${baseUrl}/${encodeURIComponent(index)}/_search`

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...resolveDataSourceHeaders(source),
      }
      const response = await __hooks.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      const text = await response.text()

      if (!response.ok) {
        return {
          ok: false,
          output: `es_query HTTP ${response.status} ${response.statusText}: ${clampToolOutput(text)}`,
        }
      }

      const note = clamped ? `\n[size clamped to ${ES_MAX_SIZE}]` : ''
      return { ok: true, output: clampToolOutput(`${text}${note}`) }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  },
}

export const elasticsearchToolset: DataSourceToolset = {
  type: 'elasticsearch',
  match: sources => sources.filter(s => matchByDataSource(s, 'elasticsearch')),
  tools: [esQueryTool],
}
