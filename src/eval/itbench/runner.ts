/**
 * ITBench 评测运行器（方案 A：真实 Kind 集群 + 实时故障注入）。
 *
 * 每个场景：
 *   1. setup     注入故障（kubectl/sh 命令）→ 等待生效
 *   2. agent     用内置只读数据源工具（prometheus/tempo/loki/kubernetes）查真数据 → RCA
 *   3. teardown  恢复故障 → 等待回稳
 *
 * agent 工具集由 createDefaultToolRegistry 构建，数据源端点来自
 * ~/.lite-ai/settings.json 的 toolsets 配置，直接连真实端点。
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { LITE_AI_SETTINGS_PATH } from '../../config.js'
import type { HypothesisList } from '../../utils/hypothesis-store.js'
import type { ItbenchScenario } from './manifest.js'
import {
  scoreInstance,
  type ItbenchInstanceResult,
} from './scorer.js'

const execFileAsync = promisify(execFile)

/** 内存缓存动态 import 的模块。 */
let importedModules: {
  OpenAIModelAdapter: typeof import('../../openai-adapter.js').OpenAIModelAdapter
  createDefaultToolRegistry: typeof import('../../tools/index.js').createDefaultToolRegistry
  hydrateMcpTools: typeof import('../../tools/index.js').hydrateMcpTools
  loadRuntimeConfig: typeof import('../../config.js').loadRuntimeConfig
  buildSystemPrompt: typeof import('../../prompt.js').buildSystemPrompt
  PermissionManager: typeof import('../../permissions.js').PermissionManager
  runAgentTurn: typeof import('../../agent-loop.js').runAgentTurn
  createContentReplacementState: typeof import('../../utils/tool-result-storage.js').createContentReplacementState
  createContextCollapseState: typeof import('../../compact/context-collapse.js').createContextCollapseState
  readHypotheses: typeof import('../../utils/hypothesis-store.js').readHypotheses
  toolsetStatuses: typeof import('../../tools/data-sources/registry.js').toolsetStatuses
} | null = null

async function getModules() {
  if (importedModules) return importedModules
  const [
    openaiAdapter,
    tools,
    config,
    prompt,
    permissions,
    agentLoop,
    storage,
    collapse,
    hypStore,
    reg,
  ] = await Promise.all([
    import('../../openai-adapter.js'),
    import('../../tools/index.js'),
    import('../../config.js'),
    import('../../prompt.js'),
    import('../../permissions.js'),
    import('../../agent-loop.js'),
    import('../../utils/tool-result-storage.js'),
    import('../../compact/context-collapse.js'),
    import('../../utils/hypothesis-store.js'),
    import('../../tools/data-sources/registry.js'),
  ])
  importedModules = {
    OpenAIModelAdapter: openaiAdapter.OpenAIModelAdapter,
    createDefaultToolRegistry: tools.createDefaultToolRegistry,
    hydrateMcpTools: tools.hydrateMcpTools,
    loadRuntimeConfig: config.loadRuntimeConfig,
    buildSystemPrompt: prompt.buildSystemPrompt,
    PermissionManager: permissions.PermissionManager,
    runAgentTurn: agentLoop.runAgentTurn,
    createContentReplacementState: storage.createContentReplacementState,
    createContextCollapseState: collapse.createContextCollapseState,
    readHypotheses: hypStore.readHypotheses,
    toolsetStatuses: reg.toolsetStatuses,
  }
  return importedModules
}

/** 设置临时 LITE_AI_HOME，复制真实 settings.json（含数据源端点与 API key）。 */
async function setupTempHome(): Promise<{ dir: string; restore: () => void }> {
  const tmp = path.join(
    os.tmpdir(),
    `lite-ai-itbench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(tmp, { recursive: true })

  try {
    const content = await readFile(LITE_AI_SETTINGS_PATH, 'utf8')
    await writeFile(path.join(tmp, 'settings.json'), content, 'utf8')
  } catch {
    // settings.json 不存在时靠 env vars 兜底
  }

  const original = process.env.LITE_AI_HOME
  process.env.LITE_AI_HOME = tmp
  return { dir: tmp, restore: () => {
    if (original === undefined) delete process.env.LITE_AI_HOME
    else process.env.LITE_AI_HOME = original
  } }
}

/** 评测中过滤掉的工具（写操作 / 交互 / 子 agent 无关项）。 */
const FILTER_OUT_TOOLS = new Set([
  'ask_user',
  'generate_postmortem',
  'incident_checkpoint',
  'tail_logs',
  'follow_logs',
  'stop_follow',
  'web_search',
  'web_fetch',
  'rewrite_todo_list',
  'update_todo_status',
  'edit_file',
  'write_file',
  'create_directory',
  'delete_file',
  'run_command',
  'load_skill',
  'search_incident_kb',
])

/** 只读数据源工具白名单：评测中主要依靠这些查真数据。 */
const ALLOW_DATA_TOOLS = new Set([
  // prometheus
  'prometheus_list_rules',
  'prometheus_get_metric_names',
  'prometheus_get_label_values',
  'prometheus_get_all_labels',
  'prometheus_get_series',
  'prometheus_get_metric_metadata',
  'prometheus_execute_prometheus_instant_query',
  'prometheus_execute_prometheus_range_query',
  // elasticsearch
  'elasticsearch_search',
  'elasticsearch_mappings',
  'elasticsearch_list_indices',
  'elasticsearch_cluster_health',
  'elasticsearch_index_stats',
  'elasticsearch_nodes_stats',
  // tempo
  'tempo_fetch_traces_comparative_sample',
  'tempo_search_traces_by_query',
  'tempo_search_traces_by_tags',
  'tempo_query_trace_by_id',
  'tempo_search_tag_names',
  'tempo_search_tag_values',
  'tempo_query_metrics_instant',
  'tempo_query_metrics_range',
  // kubernetes
  'kubernetes_jq_query',
  'kubernetes_tabular_query',
  'kubernetes_count',
  // loki
  'loki_query_logs',
  'loki_query_labels',
  'loki_query_label_values',
  'loki_query_series',
  // 假设链
  'hypothesis_tracker',
])

/** 过滤后保留数据源工具 + 只读小工具。 */
function filterTools(all: { name: string; isReadOnly?: boolean }[]): {
  name: string
  isReadOnly?: boolean
}[] {
  const kept = ALLOW_DATA_TOOLS
  return all.filter(
    t => kept.has(t.name) && !FILTER_OUT_TOOLS.has(t.name),
  )
}

/** 执行一条注入/恢复命令。失败时抛错（依赖错误是否致命由调用方定）。 */
async function runCommandScript(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return `${stdout}${stderr ? `\n[stderr] ${stderr}` : ''}`.trim()
  } catch (error) {
    const e = error as { stderr?: string; message?: string }
    return `命令失败: ${e.message ?? String(error)}${e.stderr ? `\n${e.stderr}` : ''}`
  }
}

/** 注入故障。returns 是否注入导致致命错误。 */
async function injectFault(scenario: ItbenchScenario): Promise<void> {
  const fi = scenario.faultInjection
  if (!fi) return
  if (fi.pre && fi.pre.length > 0) {
    for (const cmd of fi.pre) await runCommandScript(cmd)
  }
  for (const cmd of fi.setup) await runCommandScript(cmd)
  const wait = fi.setupWaitSeconds ?? 0
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait * 1000))
  }
}

/** 恢复故障。 */
async function clearFault(scenario: ItbenchScenario): Promise<void> {
  const fi = scenario.faultInjection
  if (!fi) return
  for (const cmd of fi.teardown) await runCommandScript(cmd)
  const wait = fi.teardownWaitSeconds ?? 0
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait * 1000))
  }
}

/** 组装给 agent 的诊断指令（明确指定数据源工具与诊断步骤）。 */
function buildUserMessage(scenario: ItbenchScenario, sources: string[]): string {
  return [
    `请调查以下生产事故并定位根因。`,
    ``,
    `【事故场景】${scenario.name}`,
    scenario.keyMetrics && scenario.keyMetrics.length > 0
      ? `【高信号指标】${scenario.keyMetrics.join(', ')}`
      : '',
    `【描述】${scenario.description}`,
    ``,
    `【可用只读数据源】${sources.join(', ')}`,
    ``,
    `【步骤】`,
    `1. 先用 kubernetes_* 查看相关命名空间 (${scenario.namespace}) 下的 Pod/Deployment/Service 与事件，确认是否异常`,
    `2. 用 prometheus_* 查询 ${scenario.keyMetrics && scenario.keyMetrics.length > 0 ? `高信号指标（如 ${scenario.keyMetrics.slice(0, 3).join(', ')}）` : '相关指标'}，观察趋势与突变`,
    `3. 用 tempo_* 查询相关服务的链路，定位慢 span / 错误 span`,
    `4. 用 loki_* 或 elasticsearch_* 查询相关服务日志，找报错与堆栈`,
    `5. 用 hypothesis_tracker 记录并证实你的根因假设，Mark 为 confirmed`,
    ``,
    `【要求】`,
    `- 只允许只读操作，不要修改任何集群/数据源状态`,
    `- 定位到具体根因服务/组件后，用 hypothesis_tracker 创建 confirmed 假设并写明结论`,
  ].filter(Boolean).join('\n')
}

export type ItbenchRunOptions = {
  maxSteps?: number
  modelName?: string
  quiet?: boolean
  /** 跳过故障注入（用于调试数据源） */
  skipFaultInjection?: boolean
  signal?: AbortSignal
}

/** 运行单场景（含故障注入编排），返回判分结果。 */
export async function runScenario(
  scenario: ItbenchScenario,
  repeat: number,
  options: ItbenchRunOptions = {},
): Promise<ItbenchInstanceResult> {
  const mods = await getModules()
  const maxSteps = options.maxSteps ?? 60
  const tempHome = await setupTempHome()
  const runCwd = path.join(os.tmpdir(), `itbench-run-${Date.now()}`)
  await mkdir(runCwd, { recursive: true })

  let steps = 0
  let error: string | undefined

  try {
    if (!options.skipFaultInjection) {
      await injectFault(scenario)
    }

    const registry = await mods.createDefaultToolRegistry({ cwd: runCwd, runtime: null })
    await mods.hydrateMcpTools({ cwd: runCwd, runtime: null, tools: registry })

    const keptNames = filterTools(registry.list())
    const kept = new Set(keptNames.map(t => t.name))
    const scoped = registry.subset([...kept])

    const sources = await mods.toolsetStatuses()
    const enabled = sources.filter(s => s.enabled).map(s => s.name)

    const permissions = new mods.PermissionManager(runCwd)
    await permissions.whenReady()

    const systemPrompt = await mods.buildSystemPrompt(runCwd, permissions.getSummary())

    const userMessage = buildUserMessage(scenario, enabled)

    const startTime = Date.now()
    const messages = await mods.runAgentTurn({
      model: new mods.OpenAIModelAdapter(scoped, () => mods.loadRuntimeConfig()),
      tools: scoped,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      cwd: runCwd,
      permissions,
      maxSteps,
      modelName: options.modelName,
      startTime,
      contentReplacementState: mods.createContentReplacementState(),
      contextCollapseState: mods.createContextCollapseState(),
      onToolStart: () => { steps += 1 },
      onAutoCompact: () => {},
      onSnipCompact: () => {},
      onContextCollapse: () => {},
    })
    // runAgentTurn 内部步进；fallback 用消息条数近似
    if (steps === 0) steps = messages.length - 2

    const hypotheses = await mods.readHypotheses(runCwd)

    const completed = error === undefined
    return scoreInstance(
      hypotheses,
      scenario.groundTruth,
      steps,
      completed,
      scenario.id,
      repeat,
      error,
    )
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    const hypotheses: HypothesisList = { incident: scenario.id, updatedAt: new Date().toISOString(), hypotheses: [] }
    return scoreInstance(
      hypotheses,
      scenario.groundTruth,
      steps,
      false,
      scenario.id,
      repeat,
      error,
    )
  } finally {
    try {
      if (!options.skipFaultInjection) {
        await clearFault(scenario)
      }
    } catch {
      // teardown 失败不阻断结果返回
    }
    tempHome.restore()
    await rm(runCwd, { recursive: true, force: true })
  }
}

/** 列出已启用的数据源（供 index.ts 打印确认）。 */
export async function listDataSources(): Promise<string[]> {
  const mods = await getModules()
  const statuses = await mods.toolsetStatuses()
  return statuses.filter(s => s.enabled).map(s => s.name)
}