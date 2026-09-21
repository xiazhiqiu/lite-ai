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
import type { Alert, Incident } from './types.js'
import { alertSessionId, normalizeIncidentMessage, normalizeToUserMessage } from './types.js'
import { notifyIfConfigured } from './notify.js'
import { appendAlertRecord } from './alert-store.js'

export type DiagnoseDeps = {
  /** 注入自定义模型（测试用），缺省按运行时配置创建 */
  model?: ModelAdapter
  /** 最大工具步数，默认 200 */
  maxSteps?: number
  /** 覆盖 webhook 配置（测试注入 notifyUrl 等） */
  config?: WebhookConfig
  /**
   * 事件回调（G7）：原样透传给 `runAgentTurn`，用于把告警诊断的**过程**写进
   * `job_events`，让值班台的 SSE 能看到工具调用 / 证据 / 结论逐条冒出。
   *
   * 全部可选、缺省不传 → 行为与 G7 之前完全一致（单进程 webhook 形态零变化）。
   * 这也保证了告警诊断与人工对话共用**同一份** `runAgentTurn` 推理链。
   */
  onToolStart?: (toolUseId: string, toolName: string, input: unknown) => void
  onToolResult?: (
    toolUseId: string,
    toolName: string,
    output: string,
    isError: boolean,
  ) => void
  onAssistantMessage?: (content: string, metadata?: { final?: boolean }) => void
  onProgressMessage?: (content: string) => void
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
  /**
   * 事件级诊断：提供时以 Incident 为诊断单元 —— sessionId 取 incidentId、
   * 消息注入完整事件包（主告警 + 全部成员 + 多重根因协议）。缺省时退化为单条诊断。
   */
  incident?: Incident
  deps?: DiagnoseDeps
}): Promise<DiagnosisResult> {
  const { cwd, alert, incident } = args
  const deps = args.deps ?? {}
  const sessionId = incident ? incident.incidentId : alertSessionId(alert)
  const config = deps.config ?? (await loadWebhookConfig())

  await appendAlertRecord({
    alertId: alert.id,
    incidentId: incident?.incidentId,
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
    {
      role: 'user',
      content: incident ? normalizeIncidentMessage(incident) : normalizeToUserMessage(alert),
    },
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
      maxSteps: deps.maxSteps ?? 200,
      modelName: runtime.model || '',
      contentReplacementState,
      contextCollapseState,
      // G7：诊断过程对外可见面。缺省 undefined → runAgentTurn 内部用 ?. 调用，零影响。
      onToolStart: deps.onToolStart,
      onToolResult: deps.onToolResult,
      onAssistantMessage: deps.onAssistantMessage,
      onProgressMessage: deps.onProgressMessage,
    })
  } catch (error) {
    // 失败优雅降级：记录 failed + 尽力落可 resume 会话 + 失败通知，再抛给队列日志
    const reason = error instanceof Error ? error.message : String(error)
    const failureNote = `[诊断失败] ${reason}\n可执行 lite-ai --resume ${sessionId} 续查。`
    const persistable = messages.filter(m => m.role !== 'system')
    persistable.push({ role: 'assistant' as const, content: failureNote })
    await saveSession(cwd, sessionId, persistable).catch(() => {})
    await appendAlertRecord({
      alertId: alert.id, incidentId: incident?.incidentId, sessionId, title: alert.title,
      severity: alert.severity, summary: reason, status: 'failed' as const,
    })
    await notifyIfConfigured(config, alert, sessionId, failureNote, 'failed')
    throw error
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