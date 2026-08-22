import type { ToolDefinition } from '../../tool.js'
import type {
  ResolvedToolsetConfig,
} from '../../config.js'
import { loadResolvedToolsets } from '../../config.js'
import {
  buildPrometheusTools,
  checkPrometheusConfig,
} from './prometheus.js'
import {
  buildElasticsearchTools,
  checkElasticsearchConfig,
} from './elasticsearch.js'
import { buildKubernetesTools, checkKubernetesConfig } from './kubernetes.js'
import { buildDatabaseTools, checkDatabaseConfig } from './database.js'
import { buildTempoTools, checkTempoConfig } from './tempo.js'
import type { ToolsetStatus } from './base.js'

/**
 * toolset 注册表：按配置生成可用的只读数据源工具并排序。
 * enabledToolsetsFor(cwd) 供 src/tools/index.ts 把启用的工具注入主注册表，
 * 也供提示词生成数据源段落（给出可用工具与配置原因）。
 */

type ToolsetDef = {
  type: string
  check: (toolset: ResolvedToolsetConfig) => ToolsetStatus
  build: (toolset: ResolvedToolsetConfig) => ToolDefinition<unknown>[]
}

/** 内置 toolset 清单。key 为配置中的 toolset 名（prometheus/elasticsearch/kubernetes/database）。 */
const BUILTIN_TOOLSETS: Record<string, ToolsetDef> = {
  prometheus: {
    type: 'prometheus',
    check: checkPrometheusConfig,
    build: buildPrometheusTools,
  },
  elasticsearch: {
    type: 'elasticsearch',
    check: checkElasticsearchConfig,
    build: buildElasticsearchTools,
  },
  kubernetes: {
    type: 'kubernetes',
    check: checkKubernetesConfig,
    build: buildKubernetesTools,
  },
  database: {
    type: 'database',
    check: checkDatabaseConfig,
    build: buildDatabaseTools,
  },
  tempo: {
    type: 'tempo',
    check: checkTempoConfig,
    build: buildTempoTools,
  },
}

/**
 * 读取已启用的 toolset 配置，返回可用工具的扁平列表。
 * 未配置 / config 不完整的 toolset 不产生任何工具（fail-closed）。
 */
export async function buildEnabledTools(): Promise<ToolDefinition<unknown>[]> {
  const resolved = await loadResolvedToolsets()
  const tools: ToolDefinition<unknown>[] = []
  for (const toolset of resolved) {
    const def = BUILTIN_TOOLSETS[toolset.type]
    if (!def) continue
    if (!def.check(toolset).enabled) continue
    tools.push(...def.build(toolset))
  }
  return tools
}

/** 返回各已配置 toolset 的约束状态（含未启用原因），供提示词/排查。 */
export async function toolsetStatuses(): Promise<ToolsetStatus[]> {
  const resolved = await loadResolvedToolsets()
  return resolved.map((toolset) => {
    const def = BUILTIN_TOOLSETS[toolset.type]
    if (!def) {
      return { name: toolset.name, type: toolset.type, enabled: false, reason: '未知 toolset 类型' }
    }
    return def.check(toolset)
  })
}