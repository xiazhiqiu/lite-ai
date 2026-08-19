/**
 * RE2-SS 评测运行器：驱动 lite-ai agent 诊断单个实例，返回结构化结果。
 *
 * 复用 E2E 测试的驱动模式：真实模型（DeepSeek）+ mock 数据源。
 * agent 经 run_command（curl/kubectl）查 mock Prometheus/ES/k8s，
 * 提假设 → 加证据 → 标记状态。跑完后从 hypothesis-store 读取最终假设
 * 链，供 scorer 评分。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startMockSources, cleanupKubeconfigDir } from './mock/harness.js'
import type { InstanceResult } from './scorer.js'
import type { HypothesisList } from '../utils/hypothesis-store.js'

export type InstanceInput = {
  /** 场景真值服务，如 "payment" */
  service: string
  /** 场景真值故障，如 "mem" */
  fault: string
  /** 场景标识，如 "payment_mem" */
  scenario: string
  /** 实例号，如 "1" */
  instance: string
  /** 重复轮次（0-based） */
  repeat: number
  /** 实例目录绝对路径 */
  cwd: string
  /** 建议先查询的高信号指标（可选，帮助 agent 聚焦） */
  keyMetrics?: string[]
  /** 是否过滤 read_file（默认 true，强制走 mock 数据源） */
  filterReadFile?: boolean
  /** 每场景最大步骤 */
  maxSteps?: number
}

export type EvalRunOptions = {
  /** 是否静默（不打印进度），默认 false */
  quiet?: boolean
}

/** 在内存中缓存动态 import 的模块（避免每次重复 import）。 */
let importedModules: {
  OpenAIModelAdapter: typeof import('../openai-adapter.js').OpenAIModelAdapter
  createDefaultToolRegistry: typeof import('../tools/index.js').createDefaultToolRegistry
  hydrateMcpTools: typeof import('../tools/index.js').hydrateMcpTools
  loadRuntimeConfig: typeof import('../config.js').loadRuntimeConfig
  buildSystemPrompt: typeof import('../prompt.js').buildSystemPrompt
  PermissionManager: typeof import('../permissions.js').PermissionManager
  runAgentTurn: typeof import('../agent-loop.js').runAgentTurn
  createContentReplacementState: typeof import('../utils/tool-result-storage.js').createContentReplacementState
  createContextCollapseState: typeof import('../compact/context-collapse.js').createContextCollapseState
  readHypotheses: typeof import('../utils/hypothesis-store.js').readHypotheses
} | null = null

async function getModules() {
  if (importedModules) return importedModules
  const [openaiAdapter, tools, config, prompt, permissions, agentLoop, storage, collapse, hypStore] =
    await Promise.all([
      import('../openai-adapter.js'),
      import('../tools/index.js'),
      import('../config.js'),
      import('../prompt.js'),
      import('../permissions.js'),
      import('../agent-loop.js'),
      import('../utils/tool-result-storage.js'),
      import('../compact/context-collapse.js'),
      import('../utils/hypothesis-store.js'),
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
  }
  return importedModules
}

/** 设置临时 LITE_AI_HOME，复制真实 settings.json（含 API key）。 */
async function setupTempHome(): Promise<{ dir: string; restore: () => void }> {
  const dir = await mkdir && await (async () => {
    const tmp = path.join(os.tmpdir(), `lite-ai-eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(tmp, { recursive: true })
    return tmp
  })()

  const realSettings = path.join(os.homedir(), '.lite-ai', 'settings.json')
  try {
    const content = await readFile(realSettings, 'utf8')
    await writeFile(path.join(dir, 'settings.json'), content, 'utf8')
  } catch {
    // settings.json 不存在时靠 env vars 兜底
  }

  const original = process.env.LITE_AI_HOME
  process.env.LITE_AI_HOME = dir

  let cleaned = false
  const restore = () => {
    if (cleaned) return
    cleaned = true
    if (original === undefined) delete process.env.LITE_AI_HOME
    else process.env.LITE_AI_HOME = original
    void rm(dir, { recursive: true, force: true })
  }
  return { dir, restore }
}

/** 运行一个实例的 agent 诊断，返回 InstanceResult。 */
export async function runInstance(
  input: InstanceInput,
  options: EvalRunOptions = {},
): Promise<InstanceResult> {
  const mods = await getModules()
  const filterReadFile = input.filterReadFile ?? true
  const maxSteps = input.maxSteps ?? 60

  const { restore } = await setupTempHome()
  let sources: Awaited<ReturnType<typeof startMockSources>> | null = null
  try {
    sources = await startMockSources(input.cwd)

    const runtime = await mods.loadRuntimeConfig()
    const fullTools = await mods.createDefaultToolRegistry({ cwd: input.cwd, runtime })
    await mods.hydrateMcpTools({ cwd: input.cwd, runtime, tools: fullTools }).catch(() => {})

    const allowedNames = filterReadOnly(fullTools.list().map(t => t.name), filterReadFile)
    const tools = fullTools.subset(allowedNames)

    const permissions = new mods.PermissionManager(input.cwd, async () => ({
      decision: 'allow_once' as const,
    }))
    await permissions.whenReady()

    const model = new mods.OpenAIModelAdapter(tools, () => mods.loadRuntimeConfig())

    const systemPrompt = await mods.buildSystemPrompt(
      input.cwd,
      permissions.getSummary(),
      {
        skills: tools.getSkills(),
        mcpServers: tools.getMcpServers(),
        subAgents: { maxConcurrent: 2 },
      },
    )

    const start = Math.max(0, sources.injectTime - 300)
    const end = sources.injectTime + 300
    const userMessage = buildUserMessage(sources, input, start, end)

    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    type ChatMessage = import('../types.js').ChatMessage
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ]

    const contentReplacementState = mods.createContentReplacementState()
    const contextCollapseState = mods.createContextCollapseState()
    let stepCount = 0
    let firstConfirmedStep = -1

    await mods.runAgentTurn({
      model,
      tools,
      messages,
      cwd: input.cwd,
      permissions,
      maxSteps,
      modelName: runtime.model,
      contentReplacementState,
      contextCollapseState,
      onToolResult: (_toolUseId, toolName, output, isError) => {
        stepCount += 1
        // 检测 update_status → confirmed
        if (
          toolName === 'hypothesis_tracker' &&
          !isError &&
          output.includes('status updated to confirmed')
        ) {
          if (firstConfirmedStep === -1) firstConfirmedStep = stepCount
        }
      },
    })

    const hypotheses: HypothesisList = await mods.readHypotheses(input.cwd)

    return scoreInstanceFrom(
      hypotheses,
      input,
      stepCount,
      firstConfirmedStep,
      true,
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return scoreInstanceFrom(
      { incident: input.scenario, updatedAt: new Date().toISOString(), hypotheses: [] },
      input,
      0,
      -1,
      false,
      msg,
    )
  } finally {
    if (sources) await sources.stop().catch(() => {})
    restore()
    await cleanupKubeconfigDir().catch(() => {})
  }
}

function filterReadOnly(names: string[], filterReadFile: boolean): string[] {
  return names.filter(n => !(filterReadFile && n === 'read_file'))
}

import { scoreInstance } from './scorer.js'

function scoreInstanceFrom(
  hypotheses: HypothesisList,
  input: InstanceInput,
  totalSteps: number,
  firstConfirmedStep: number,
  completed: boolean,
  error?: string,
): InstanceResult {
  return scoreInstance(
    hypotheses,
    input.service,
    input.fault,
    totalSteps,
    firstConfirmedStep,
    completed,
    input.scenario,
    input.instance,
    input.repeat,
    error,
  )
}

/** 构造用户诊断指令（通用化，不含场景特定 keyMetrics 之外的硬编码）。 */
function buildUserMessage(
  sources: Awaited<ReturnType<typeof startMockSources>>,
  input: InstanceInput,
  start: number,
  end: number,
): string {
  const keyMetrics =
    input.keyMetrics && input.keyMetrics.length > 0
      ? `  High-signal metric names to query first (exact names exist in Prometheus): ${input.keyMetrics.join(', ')}. Query each with query_range to see the fault-time change.`
      : ''
  const filterNote =
    'Use ONLY run_command (with curl / kubectl), hypothesis_tracker. DO NOT read the csv files directly with a file-reading tool — fetch data through the real interfaces above.'

  return [
    `I'm investigating an incident in the Sock Shop microservice demo (namespace: sock-shop).`,
    `An alert fired at unix epoch second ${sources.injectTime}; use it as the fault-time reference (window ${start}..${end}).`,
    '',
    'Live data sources (read-only):',
    `- Prometheus metrics: ${sources.prometheusUrl}  (query via curl, GET)`,
    `- Elasticsearch logs: ${sources.elasticsearchUrl}  (index "sock-shop-logs"; query via curl GET ?q= or POST /_search)`,
    '- Kubernetes cluster: kubectl (already configured; namespace sock-shop)',
    '',
    'Follow this exact protocol. ' + filterNote,
    '',
    'Step 1 — Metrics (Prometheus): use run_command + curl to:',
    `  - curl -s "${sources.prometheusUrl}/api/v1/label/__name__/values"  (list metric names)`,
    `  - curl -s "${sources.prometheusUrl}/api/v1/query?query=<metric_name>"  (instant value)`,
    `  - curl -s "${sources.prometheusUrl}/api/v1/query_range?query=<metric_name>&start=${start}&end=${end}&step=30"  (time window)`,
    '  Identify which service shows anomalous metrics around the fault time.',
    keyMetrics,
    '',
    'Step 2 — Logs (Elasticsearch): use run_command + curl to:',
    `  - curl -s "${sources.elasticsearchUrl}/sock-shop-logs/_search?q=container_name:<service>&size=20"`,
    `  - curl -s "${sources.elasticsearchUrl}/sock-shop-logs/_search?q=severity:ERROR&size=20"`,
    '  Find ERROR / exception messages from the affected service around the fault time.',
    '',
    'Step 3 — Cluster (kubectl): use run_command to:',
    '  - kubectl get pods -n sock-shop',
    '  - kubectl logs -n sock-shop <pod> --tail=50',
    '  Confirm which workload is affected.',
    '',
    'Step 4 — Hypothesis chain: use hypothesis_tracker to add at least 2 hypotheses (one most-likely root cause with priority 1, one alternative to rule out). Attach evidence (add_evidence) quoting the actual command output you observed (command, output_summary, data_source, timestamp, supports). Then update_status: confirmed for the root cause, refuted for the ruled-out one.',
    '',
    `If you reach a confident root-cause conclusion, you may list the most-likely service in your final answer, but the authoritative record is the hypothesis_tracker confirmed hypothesis.`,
    '',
    'Rules:',
    '- Do NOT use shell pipes, command substitution, or jq.',
    '- Always quote URLs with double quotes (URLs contain & query params).',
    '- Never run write operations (no -X POST except ES _search; no kubectl apply/delete/exec).',
    '- Only tools: run_command, hypothesis_tracker.',
  ].join('\n')
}