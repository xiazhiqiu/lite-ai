import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { clampToolOutput, type ToolsetStatus } from './base.js'
import type { ResolvedToolsetConfig } from '../../config.js'

/**
 * Elasticsearch 只读查询工具集。
 * 路由对齐 HolmesGPT 的 ELK（es_url）。全部走 ES REST API，避免 shell/curl 造成权限弹窗。
 */

const OUTPUT_CHARS = 30_000

export function checkElasticsearchConfig(
  toolset: ResolvedToolsetConfig,
): ToolsetStatus {
  const url = toolset.config.es_url
  if (typeof url !== 'string' || url.length === 0) {
    return {
      name: toolset.name,
      type: 'elasticsearch',
      enabled: false,
      reason: '缺少 es_url',
    }
  }
  return { name: toolset.name, type: 'elasticsearch', enabled: true }
}

/** 发送 GET/POST 请求并解析 JSON；非 2xx 或非 JSON 时给出稳定错误信息。 */
async function esRequest(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; output: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } finally {
    clearTimeout(timer)
  }
  const text = clampToolOutput(await res.text(), OUTPUT_CHARS)
  if (!res.ok) return { ok: false, output: `HTTP ${res.status}: ${text}` }
  try {
    const parsed = JSON.parse(text) as unknown
    return { ok: true, output: JSON.stringify(parsed, null, 2) }
  } catch {
    return { ok: false, output: `Invalid JSON (HTTP ${res.status}): ${text}` }
  }
}

const indexName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9._*-]+$/, '非法索引名（仅小写字母/数字/._*-）')
const queryObj = z.record(z.string(), z.unknown())

/** 生成单一只读工具（闭包捕获 baseUrl）。 */
function tool<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  exec: (baseUrl: string, input: T) => Promise<{ ok: boolean; output: string }>,
  baseUrl: string,
): ToolDefinition<T> {
  return {
    name: `elasticsearch_${name}`,
    description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    schema,
    isReadOnly: true,
    async run(input) {
      return exec(baseUrl, input)
    },
  }
}

export function buildElasticsearchTools(
  toolset: ResolvedToolsetConfig,
): ToolDefinition<unknown>[] {
  const baseUrl = String(toolset.config.es_url).replace(/\/+$/, '')

  return [
    tool(
      'search',
      'Query documents in an index via the _search API.',
      z.object({
        index: indexName,
        query: queryObj,
        size: z.number().int().min(0).max(1000).optional(),
      }),
      (base, input) =>
        esRequest(base, 'POST', `/${input.index}/_search`, {
          query: input.query,
          ...(input.size !== undefined ? { size: input.size } : {}),
        }),
      baseUrl,
    ),
    tool(
      'mappings',
      'Get the field mappings of an index.',
      z.object({ index: indexName }),
      (base, input) => esRequest(base, 'GET', `/${input.index}/_mappings`),
      baseUrl,
    ),
    tool(
      'list_indices',
      'List the names and health of all indices.',
      z.object({}),
      (base) =>
        esRequest(
          base,
          'GET',
          '/_cat/indices?format=json&h=index,health,status,docs.count,store.size',
        ),
      baseUrl,
    ),
    tool(
      'cat',
      'Run an Elasticsearch _cat query (e.g. nodes/shards/indices) with a pattern.',
      z.object({ pattern: z.string().min(1).max(256) }),
      (base, input) => esRequest(base, 'GET', `/_cat/${input.pattern}?format=json`),
      baseUrl,
    ),
    tool(
      'cluster_health',
      'Get cluster health status.',
      z.object({}),
      (base) => esRequest(base, 'GET', '/_cluster/health'),
      baseUrl,
    ),
    tool(
      'index_stats',
      'Get index-level statistics.',
      z.object({ index: indexName.optional() }),
      (base, input) =>
        esRequest(
          base,
          'GET',
          input.index !== undefined ? `/${input.index}/_stats` : '/_stats',
        ),
      baseUrl,
    ),
    tool(
      'allocation_explain',
      'Explain why a shard is misplaced.',
      z.object({ index: indexName.optional(), shard: z.number().int().optional() }),
      (base, input) =>
        esRequest(base, 'POST', '/_cluster/allocation/explain', {
          ...(input.index !== undefined ? { index: input.index } : {}),
          ...(input.shard !== undefined ? { shard: input.shard } : {}),
        }),
      baseUrl,
    ),
    tool(
      'nodes_stats',
      'Get node-level statistics (memory, cpu, heap).',
      z.object({ metric: z.string().optional() }),
      (base, input) =>
        esRequest(
          base,
          'GET',
          `/_nodes/stats${input.metric !== undefined ? `/${input.metric}` : ''}`,
        ),
      baseUrl,
    ),
  ]
}