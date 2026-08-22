/**
 * 告警自动诊断执行：构造消息 → runAgentTurn → 存会话 → 通知。
 *
 * 不单独落盘 md 报告：会话 jsonl 即完整诊断记录（含工具调用 / 假设链 / 证据），
 * 复盘报告由 agent 诊断时自行用 generate_postmortem 落盘。
 */
import type { WebhookConfig } from '../config.js'
import { loadRuntimeConfig, loadWebhookConfig } from '../config.js'
import { MockModelAdapter } from '../mock-model.js'
import { OpenAIModelAdapter } from '../openai-adapter.js'
import { AnthropicModelAdapter } from '../anthropic-adapter.js'
import { PermissionManager } from '../permissions.js'
import { buildSystemPrompt } from '../prompt.js'
import { createWebhookDiagnosisToolRegistry } from '../tools/index.js'
import { runAgentTurn } from '../agent-loop.js'
import { saveSession } from '../session.js'
import { createContentReplacementState } from '../utils/tool-result-storage.js'
import { createContextCollapseState } from '../compact/context-collapse.js'
import type { ChatMessage, ModelAdapter } from '../types.js'
import type { ToolRegistry } from '../tool.js'
import type { Alert } from './types.js'
import { alertSessionId, normalizeToUserMessage } from './types.js'
import { notifyIfConfigured } from './notify.js'
import { appendAlertRecord } from './alert-store.js'

export type DiagnoseDeps = {
  /** 注入自定义模型（测试用），缺省按运行时配置创建 */
  model?: ModelAdapter
  /** 最大工具步数，默认 40 */
  maxSteps?: number
  /** 覆盖 webhook 配置（测试注入 notifyUrl 等） */
  config?: WebhookConfig
}

export type DiagnosisResult = {
  sessionId: string
  diagnosisSummary: string
}

function pickModel(
  runtime: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  tools: ToolRegistry,
  injected?: ModelAdapter,
): ModelAdapter {
  if (injected) return injected
  if (process.env.LITE_AI_MODEL_MODE === 'mock') {
    return new MockModelAdapter()
  }
  return runtime.provider === 'openai'
    ? new OpenAIModelAdapter(tools, loadRuntimeConfig)
    : new AnthropicModelAdapter(tools, loadRuntimeConfig)
}

/** 摘取最后一个 final assistant 消息作为诊断摘要。 */
function extractFinalSummary(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'assistant' && typeof m.content === 'string') {
      return m.content
    }
  }
  return ''
}

export async function runAlertDiagnosis(args: {
  cwd: string
  alert: Alert
  deps?: DiagnoseDeps
}): Promise<DiagnosisResult> {
  const { cwd, alert } = args
  const deps = args.deps ?? {}
  const sessionId = alertSessionId(alert)
  const config = deps.config ?? (await loadWebhookConfig())

  await appendAlertRecord({
    alertId: alert.id,
    sessionId,
    title: alert.title,
    severity: alert.severity,
    summary: alert.summary,
    status: 'received',
  })

  const runtime = await loadRuntimeConfig()
  const tools = await createWebhookDiagnosisToolRegistry({ cwd, runtime })

  // 只读诊断通道（C1）：工具集已限定为无副作用数据源查询，
  // 且无交互式 ask_user，无需 allow_once 权限放行。
  const permissions = new PermissionManager(cwd, async () => ({
    decision: 'allow_once' as const,
  }))
  await permissions.whenReady()

  const model = pickModel(runtime, tools, deps.model)

  const systemPrompt = await buildSystemPrompt(cwd, permissions.getSummary(), {
    skills: tools.getSkills(),
    mcpServers: tools.getMcpServers(),
    subAgents: { maxConcurrent: 1 },
  })

  let messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: normalizeToUserMessage(alert) },
  ]

  const contentReplacementState = createContentReplacementState()
  const contextCollapseState = createContextCollapseState()

  try {
    messages = await runAgentTurn({
      model,
      tools,
      messages,
      cwd,
      permissions,
      maxSteps: deps.maxSteps ?? 40,
      modelName: runtime.model || '',
      contentReplacementState,
      contextCollapseState,
    })
  } finally {
    await tools.dispose().catch(() => {})
  }

  const diagnosisSummary = extractFinalSummary(messages)

  // 存成可 resume 的会话，值班员用 `lite-ai --resume <sessionId>` 恢复。
  await saveSession(cwd, sessionId, messages)

  await appendAlertRecord({
    alertId: alert.id,
    sessionId,
    title: alert.title,
    severity: alert.severity,
    summary: alert.summary,
    status: 'diagnosed',
  })

  await notifyIfConfigured(config, alert, sessionId, diagnosisSummary)

  return { sessionId, diagnosisSummary }
}