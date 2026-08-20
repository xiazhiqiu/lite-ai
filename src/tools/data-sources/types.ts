import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DataSourceConfig, DataSourceType } from '../../config.js'
import { resolveHeaderValue } from '../../config.js'
import type { ToolDefinition } from '../../tool.js'
import { elasticsearchToolset } from './elasticsearch.js'
import { prometheusToolset } from './prometheus.js'
import { kubernetesToolset } from './kubernetes.js'

const execFileAsync = promisify(execFile)

/** 单次工具输出上限：超出截断并追加标记，保证 ToolResult.output 有界。 */
export const MAX_TOOL_OUTPUT = 200_000
/** ES 单次 size 上限，超限夹逼。 */
export const ES_MAX_SIZE = 100
/** Prometheus 采样点上限，超限自动调大 step。 */
export const PROM_MAX_POINTS = 5000
/** Prometheus 默认 step（秒）。 */
export const PROM_DEFAULT_STEP = 30
/** kubectl logs --tail 上限，超限夹逼。 */
export const KUBECTL_MAX_TAIL = 500
/** kubectl 默认 namespace（演示默认，可覆盖）。 */
export const KUBECTL_DEFAULT_NAMESPACE = 'sock-shop'
/** kubectl logs 默认 tail 行数。 */
export const KUBECTL_DEFAULT_TAIL = 50
/** kubectl stdout 缓冲上限。 */
export const KUBECTL_MAX_BUFFER = 5 * 1024 * 1024

/** 各数据源类型的关键词回退匹配（type 未配置时按 name/hint 命中）。 */
const DATA_SOURCE_KEYWORDS: Record<string, string[]> = {
  elasticsearch: ['elastic'],
  prometheus: ['prometheus'],
  kubernetes: ['kubectl', 'kubernetes', 'k8s'],
  gitlab: ['gitlab'],
  skywalking: ['skywalking'],
}

/**
 * 判定单个数据源是否属于某类型：type 精确命中优先，name/hint 关键词回退。
 */
export function matchByDataSource(
  source: DataSourceConfig,
  type: DataSourceType,
): boolean {
  if (source.type === type) return true
  const keywords = DATA_SOURCE_KEYWORDS[type] ?? []
  const haystack = `${source.name} ${source.hint ?? ''}`.toLowerCase()
  return keywords.some(keyword => haystack.includes(keyword))
}

/**
 * 按 type 定位数据源实例：name 精确匹配优先（多实例消歧），缺省取第一个命中。
 */
export function resolveDataSource(
  sources: DataSourceConfig[],
  type: DataSourceType,
  name?: string,
): DataSourceConfig | undefined {
  if (name !== undefined) {
    return sources.find(s => s.name === name && matchByDataSource(s, type))
  }
  return sources.find(s => matchByDataSource(s, type))
}

/** 解析数据源配置的 headers（{{ env.NAME }} 运行期注入），密钥不落盘。 */
export function resolveDataSourceHeaders(
  source: DataSourceConfig,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(source.headers ?? {})) {
    headers[key] = resolveHeaderValue(value)
  }
  return headers
}

/** 截断工具输出，超长追加截断标记，保证输出有界。 */
export function clampToolOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text
  const truncated = text.slice(0, MAX_TOOL_OUTPUT)
  return `${truncated}\n[truncated: ${text.length} chars]`
}

/**
 * 可测试性钩子：测试时可替换 fetch / kubectlExec 为 mock，避免依赖真实数据源与网络。
 * 生产代码用真实 fetch / execFile（数组参数，不开 shell）。
 */
export const __hooks = {
  fetch: (url: string | URL, init?: RequestInit): Promise<Response> =>
    fetch(url, init),
  kubectlExec: (args: string[]): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync('kubectl', args, { maxBuffer: KUBECTL_MAX_BUFFER }),
}

/** 一类数据源对应的只读工具集。 */
export type DataSourceToolset = {
  type: DataSourceType
  /** 定位该类型数据源实例（type 精确优先，name/hint 关键词回退）。 */
  match: (sources: DataSourceConfig[]) => DataSourceConfig[]
  tools: ToolDefinition<unknown>[]
}

/** 按 type 聚合各模块，新增源 = 新增模块 + 在此登记一行。 */
export const DATA_SOURCE_TOOLSETS: DataSourceToolset[] = [
  elasticsearchToolset,
  prometheusToolset,
  kubernetesToolset,
]

/**
 * 按已配置数据源的 type（或关键词回退命中）只注册对应工具集；
 * 无对应数据源时不注册，避免空转工具暴露给模型。
 */
export function dataSourceToolsetsFor(
  sources: DataSourceConfig[],
): ToolDefinition<unknown>[] {
  const tools: ToolDefinition<unknown>[] = []
  for (const toolset of DATA_SOURCE_TOOLSETS) {
    if (toolset.match(sources).length > 0) {
      tools.push(...toolset.tools)
    }
  }
  return tools
}
