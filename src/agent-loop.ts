import type { ToolRegistry } from './tool.js'
import type {
  ChatMessage,
  CompressionResult,
  ModelAdapter,
  ProviderThinkingBlock,
  ProviderUsage,
} from './types.js'
import type { PermissionManager } from './permissions.js'
import { createTurnMonitor, type TurnMonitor } from './monitor/turn-monitor.js'
import { readMonitorConfig } from './monitor/config.js'
import type { AssistantAction, AssistantContext } from './monitor/types.js'
import { microcompact } from './compact/microcompact.js'
import { autoCompact } from './compact/auto-compact.js'
import {
  applyContextCollapseIfNeeded,
  createContextCollapseState,
  type ContextCollapseResult,
  type ContextCollapseState,
} from './compact/context-collapse.js'
import { throwIfAborted } from './abort.js'
import {
  snipCompactConversation,
  type SnipCompactResult,
} from './compact/snipCompact.js'
import { computeContextStats } from './utils/token-estimator.js'
import { createTurnScope, type TurnScope } from './observability/metrics.js'
import {
  partitionToolCalls,
  isToolConcurrencyEnabled,
} from './utils/tool-parallel.js'
import {
  buildAgentStatusBar,
  isStatusBarEnabled,
  formatElapsed,
} from './utils/status-bar.js'
import {
  applyToolResultBudget,
  createContentReplacementState,
  replaceLargeToolResult,
  type ContentReplacementState,
  type PendingToolResult,
} from './utils/tool-result-storage.js'

function isEmptyAssistantResponse(content: string): boolean {
  return content.trim().length === 0
}

function withProviderUsage<T extends ChatMessage>(
  message: T,
  usage: ProviderUsage | undefined,
): T {
  if (!usage) return message
  if (
    message.role === 'assistant' ||
    message.role === 'assistant_progress' ||
    message.role === 'assistant_tool_call'
  ) {
    return { ...message, providerUsage: usage } as T
  }
  return message
}

type TurnStats = {
  model?: string
  steps: number
  toolCalls: number
  toolErrors: number
  emptyResponses: number
  thinkingRetries: number
  midtaskContinuations: number
  contextUtilization: number
  maxStepsHit: boolean
}

/** 对外入口：执行一个 agent 回合并记录回合级指标（try/finally 覆盖抛错路径）。 */
export async function runAgentTurn(args: {
  model: ModelAdapter
  tools: ToolRegistry
  messages: ChatMessage[]
  cwd: string
  permissions?: PermissionManager
  maxSteps?: number
  modelName?: string
  startTime?: number
  onToolStart?: (toolUseId: string, toolName: string, input: unknown) => void
  onToolResult?: (toolUseId: string, toolName: string, output: string, isError: boolean) => void
  onAssistantMessage?: (content: string, metadata?: { final?: boolean }) => void
  onProgressMessage?: (content: string) => void
  onAutoCompact?: (result: CompressionResult) => void | Promise<void>
  onSnipCompact?: (result: SnipCompactResult) => void | Promise<void>
  onContextCollapse?: (result: ContextCollapseResult) => void | Promise<void>
  onContextStats?: (stats: import('./utils/token-estimator.js').ContextStats) => void
  contentReplacementState?: ContentReplacementState
  contextCollapseState?: ContextCollapseState
  signal?: AbortSignal
}): Promise<ChatMessage[]> {
  const startedAt = Date.now()
  const scope = createTurnScope()
  const turnMonitor = createTurnMonitor(readMonitorConfig())
  try {
    const { messages, stats } = await runAgentTurnCore(args, scope, turnMonitor)
    scope.flush({ ...stats, durationMs: Date.now() - startedAt })
    return messages
  } catch (error) {
    const statsErr = error as Error & { stats?: TurnStats }
    // 优先用回合循环中断时携带的部分指标，保留已发生步骤的进度。
    const stats = statsErr.stats ?? {
      model: args.modelName,
      steps: 0,
      toolCalls: 0,
      toolErrors: 0,
      emptyResponses: 0,
      thinkingRetries: 0,
      midtaskContinuations: 0,
      contextUtilization: 0,
      maxStepsHit: false,
    }
    scope.flush({
      ...stats,
      durationMs: Date.now() - startedAt,
      error: statsErr.message ?? String(error),
    })
    throw error
  }
}

async function runAgentTurnCore(
  args: {
    model: ModelAdapter
    tools: ToolRegistry
    messages: ChatMessage[]
    cwd: string
    permissions?: PermissionManager
    maxSteps?: number
    modelName?: string
    startTime?: number
    onToolStart?: (toolUseId: string, toolName: string, input: unknown) => void
    onToolResult?: (toolUseId: string, toolName: string, output: string, isError: boolean) => void
    onAssistantMessage?: (content: string, metadata?: { final?: boolean }) => void
    onProgressMessage?: (content: string) => void
    onAutoCompact?: (result: CompressionResult) => void | Promise<void>
    onSnipCompact?: (result: SnipCompactResult) => void | Promise<void>
    onContextCollapse?: (result: ContextCollapseResult) => void | Promise<void>
    onContextStats?: (stats: import('./utils/token-estimator.js').ContextStats) => void
    contentReplacementState?: ContentReplacementState
    contextCollapseState?: ContextCollapseState
    signal?: AbortSignal
  },
  scope: TurnScope,
  turnMonitor: TurnMonitor,
): Promise<{ messages: ChatMessage[]; stats: TurnStats }> {
  const maxSteps = args.maxSteps
  const modelName = args.modelName ?? ''
  const startTime = args.startTime ?? Date.now()
  const statusBarToolCount = new Map<string, number>()
  let turnSteps = 0
  let toolCallsTotal = 0
  let maxStepsHit = false
  let contextUtilization = 0
  let messages = args.messages
  let toolErrorCount = 0
  let sawToolResultThisTurn = false
  let snippedThisTurn = false
  // microcompact 只折叠只读（可重建）工具结果；名单由注册表按 isReadOnly 推导，
  // 使数据源 / MCP 只读工具自动纳入，无需维护静态前缀清单。
  const foldableToolNames = new Set(
    args.tools
      .list()
      .filter(tool => tool.isReadOnly === true)
      .map(tool => tool.name),
  )
  const contentReplacementState =
    args.contentReplacementState ?? createContentReplacementState()
  let contextCollapseState =
    args.contextCollapseState ?? createContextCollapseState()

  const buildStats = (): TurnStats => {
    const monitorStats = turnMonitor.stats()
    return {
      model: modelName || undefined,
      steps: turnSteps,
      toolCalls: toolCallsTotal,
      toolErrors: toolErrorCount,
      emptyResponses: monitorStats.emptyResponseRetry,
      thinkingRetries: monitorStats.recoverableThinkingRetry,
      midtaskContinuations: monitorStats.midTaskTextContinuation,
      contextUtilization: contextUtilization,
      maxStepsHit,
    }
  }

  const replaceContextCollapseState = (nextState: ContextCollapseState) => {
    contextCollapseState = nextState
    if (args.contextCollapseState) {
      args.contextCollapseState.spans = [...nextState.spans]
      args.contextCollapseState.enabled = nextState.enabled
      args.contextCollapseState.consecutiveFailures = nextState.consecutiveFailures
    }
  }

  const pushContinuationPrompt = (content: string) => {
    messages = [
      ...messages,
      {
        role: 'user',
        content,
      },
    ]
  }

  const appendThinkingBlocks = (blocks: ProviderThinkingBlock[] | undefined) => {
    if (!blocks || blocks.length === 0) return
    messages = [
      ...messages,
      {
        role: 'assistant_thinking',
        blocks,
      },
    ]
  }

  try {
  for (let step = 0; maxSteps == null || step < maxSteps; step++) {
    throwIfAborted(args.signal)
    turnSteps += 1
    let latestStats: import('./utils/token-estimator.js').ContextStats | null = null
    let modelMessages = messages

    if (modelName) {
      latestStats = computeContextStats(messages, modelName)
      contextUtilization = latestStats.utilization

      if (!snippedThisTurn) {
        const snipResult = await snipCompactConversation({
          messages,
          contextStats: latestStats,
          modelContextWindow: latestStats.effectiveInput,
        })
        if (snipResult.didSnip) {
          messages = snipResult.messages
          snippedThisTurn = true
          await args.onSnipCompact?.(snipResult)
          latestStats = computeContextStats(messages, modelName)
          args.onContextStats?.(latestStats)
        }
      }

      const beforeMicrocompact = messages
      messages = microcompact(messages, modelName, foldableToolNames)
      if (messages !== beforeMicrocompact) {
        latestStats = computeContextStats(messages, modelName)
        args.onContextStats?.(latestStats)
      }

      const collapseResult = await applyContextCollapseIfNeeded(
        messages,
        modelName,
        args.model,
        contextCollapseState,
      )
      replaceContextCollapseState(collapseResult.state)
      modelMessages = collapseResult.messages
      if (collapseResult.collapsed) {
        await args.onContextCollapse?.(collapseResult)
        latestStats = computeContextStats(modelMessages, modelName)
        args.onContextStats?.(latestStats)
      } else if (modelMessages !== messages) {
        latestStats = computeContextStats(modelMessages, modelName)
        args.onContextStats?.(latestStats)
      }
    }

    // AutoCompact: LLM-based compression when context is critical (first step only)
    if (step === 0 && modelName) {
      latestStats = latestStats ?? computeContextStats(modelMessages, modelName)
      args.onContextStats?.(latestStats)
      if (latestStats.warningLevel === 'critical' || latestStats.warningLevel === 'blocked') {
        const result = await autoCompact(modelMessages, modelName, args.model, args.cwd)
        if (result) {
          messages = result.messages
          modelMessages = messages
          replaceContextCollapseState(createContextCollapseState())
          await args.onAutoCompact?.(result)
          latestStats = computeContextStats(messages, modelName)
          args.onContextStats?.(latestStats)
        }
      }
    }

    const nextInput = (() => {
      if (!isStatusBarEnabled() || !modelName) return modelMessages
      const stats = latestStats ?? computeContextStats(modelMessages, modelName)
      const total = [...statusBarToolCount.values()].reduce((a, b) => a + b, 0)
      const detail = [...statusBarToolCount.entries()].map(([n, c]) => `${n}:${c}`).join(', ')
      const status = buildAgentStatusBar({
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        elapsed: formatElapsed(Date.now() - startTime),
        toolUsage: total === 0 ? '0' : `${total} (${detail})`,
        ctx: `${Math.round(stats.utilization * 100)}% (${stats.warningLevel})`,
        cwd: args.cwd,
      })
      return [...modelMessages, { role: 'user' as const, content: status }]
    })()

    const llmStartedAt = Date.now()
    let next: Awaited<ReturnType<ModelAdapter['next']>>
    try {
      next = await args.model.next(nextInput, {
        tools: args.tools.list(),
        signal: args.signal,
      })
    } catch (error) {
      scope.pushLlm({
        model: modelName,
        provider: undefined,
        latencyMs: Date.now() - llmStartedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const llmLatencyMs = Date.now() - llmStartedAt
    scope.pushLlm({
      model: modelName,
      provider: next.usage?.source,
      inputTokens: next.usage?.inputTokens,
      outputTokens: next.usage?.outputTokens,
      totalTokens: next.usage?.totalTokens,
      latencyMs: llmLatencyMs,
      stopReason: next.diagnostics?.stopReason,
    })

    if (next.type === 'assistant') {
      const assistantCtx: AssistantContext = {
        content: next.content,
        kind: next.kind,
        isEmpty: isEmptyAssistantResponse(next.content),
        sawToolResultThisTurn,
        toolErrorCount,
        diagnostics: next.diagnostics,
        thinkingBlocks: next.thinkingBlocks,
      }
      const action: AssistantAction = turnMonitor.detectAssistant(assistantCtx)

      switch (action.kind) {
        case 'progress_continue':
        case 'midtask_continue':
          args.onProgressMessage?.(action.progress)
          appendThinkingBlocks(assistantCtx.thinkingBlocks)
          messages = [
            ...messages,
            { role: 'assistant_progress', content: action.progress },
          ]
          pushContinuationPrompt(action.continuation)
          continue
        case 'thinking_retry':
          // 与旧代码一致：thinking 重试不触发 appendThinkingBlocks。
          args.onProgressMessage?.(action.progress)
          messages = [
            ...messages,
            { role: 'assistant_progress', content: action.progress },
          ]
          pushContinuationPrompt(action.continuation)
          continue
        case 'empty_continue':
          pushContinuationPrompt(action.continuation)
          continue
        case 'empty_stop': {
          args.onAssistantMessage?.(action.fallback, { final: true })
          appendThinkingBlocks(assistantCtx.thinkingBlocks)
          return {
            messages: [
              ...messages,
              { role: 'assistant', content: action.fallback },
            ],
            stats: buildStats(),
          }
        }
        case 'finish': {
          const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: next.content,
          }
          appendThinkingBlocks(assistantCtx.thinkingBlocks)
          const withAssistant: ChatMessage[] = [
            ...messages,
            withProviderUsage(assistantMessage, next.usage),
          ]
          if (!assistantCtx.isEmpty) {
            args.onAssistantMessage?.(next.content, { final: true })
          }
          return { messages: withAssistant, stats: buildStats() }
        }
      }
    }

    appendThinkingBlocks(next.thinkingBlocks)

    if (next.content) {
      if (next.contentKind === 'progress') {
        args.onProgressMessage?.(next.content)
        messages = [
          ...messages,
          withProviderUsage({ role: 'assistant_progress', content: next.content }, next.usage),
        ]
        pushContinuationPrompt(
          'Continue immediately from your <progress> update with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
        )
      } else {
        args.onAssistantMessage?.(
          next.content,
          (next.calls?.length ?? 0) > 0 ? undefined : { final: true },
        )
        messages = [
          ...messages,
          withProviderUsage(
            { role: 'assistant', content: next.content },
            (next.calls?.length ?? 0) > 0 ? undefined : next.usage,
          ),
        ]
      }
    }

    if ((next.calls?.length ?? 0) === 0 && next.content && next.contentKind !== 'progress') {
      return { messages, stats: buildStats() }
    }

    const executedToolResults: Array<{
      call: (typeof next.calls)[number]
      result: Awaited<ReturnType<ToolRegistry['execute']>>
      toolResult?: PendingToolResult
    }> = []

    const isConcurrent = isToolConcurrencyEnabled()
    const groups = isConcurrent
      ? partitionToolCalls(next.calls, call => {
          // 未找到工具 / 未声明 isParallelSafe → false（fail-closed）
          return args.tools.find(call.toolName)?.isParallelSafe?.(call.input) ?? false
        })
      : next.calls.map(call => ({ parallel: false, calls: [call] }))

    for (const group of groups) {
      throwIfAborted(args.signal)

      if (group.parallel) {
        // 并行批：先统一 onToolStart，再 Promise.all 执行，再按发射序 onToolResult
        for (const call of group.calls) {
          args.onToolStart?.(call.id, call.toolName, call.input)
        }
        const results = await Promise.all(
          group.calls.map(call =>
            args.tools.execute(call.toolName, call.input, {
              cwd: args.cwd,
              permissions: args.permissions,
              scope,
            }),
          ),
        )
        group.calls.forEach((call, i) => {
          const result = results[i]!
          const notice = turnMonitor.observeToolCall({
            toolName: call.toolName,
            input: call.input,
            ok: result.ok,
          })
          if (notice) {
            result.output = `${notice}\n${result.output}`
          }
          sawToolResultThisTurn = true
          if (!result.ok) {
            toolErrorCount += 1
          }
          args.onToolResult?.(call.id, call.toolName, result.output, !result.ok)
          toolCallsTotal += 1
          statusBarToolCount.set(call.toolName, (statusBarToolCount.get(call.toolName) ?? 0) + 1)
          executedToolResults.push({ call, result })
        })
      } else {
        // 串行批：逐个执行（与当前行为一致）
        for (const call of group.calls) {
          throwIfAborted(args.signal)
          args.onToolStart?.(call.id, call.toolName, call.input)
          const result = await args.tools.execute(call.toolName, call.input, {
            cwd: args.cwd,
            permissions: args.permissions,
            scope,
          })
          const notice = turnMonitor.observeToolCall({
            toolName: call.toolName,
            input: call.input,
            ok: result.ok,
          })
          if (notice) {
            result.output = `${notice}\n${result.output}`
          }
          sawToolResultThisTurn = true
          if (!result.ok) {
            toolErrorCount += 1
          }
          args.onToolResult?.(call.id, call.toolName, result.output, !result.ok)
          toolCallsTotal += 1
          statusBarToolCount.set(call.toolName, (statusBarToolCount.get(call.toolName) ?? 0) + 1)
          executedToolResults.push({ call, result })
        }
      }
    }

    // 批后统一：按原发射序执行 replaceLargeToolResult（绝不在并行区执行，避免共享 contentReplacementState 竞态）
    for (const entry of executedToolResults) {
      entry.toolResult = await replaceLargeToolResult({
        role: 'tool_result',
        toolUseId: entry.call.id,
        toolName: entry.call.toolName,
        content: entry.result.output,
        isError: !entry.result.ok,
      }, contentReplacementState)
    }

    const budgetedResults = await applyToolResultBudget(
      executedToolResults.map(entry => entry.toolResult!),
      contentReplacementState,
    )
    const toolResultById = new Map(
      budgetedResults.results.map(result => [result.toolUseId, result]),
    )

    const toolCallMessages = executedToolResults.map((entry, i) => {
      const toolCallMessage: ChatMessage = {
        role: 'assistant_tool_call',
        toolUseId: entry.call.id,
        toolName: entry.call.toolName,
        input: entry.call.input,
      }

      return withProviderUsage(
        toolCallMessage,
        i === executedToolResults.length - 1 ? next.usage : undefined,
      )
    })
    const toolResults = executedToolResults.map(entry =>
      toolResultById.get(entry.call.id) ?? entry.toolResult!,
    )

    messages = [
      ...messages,
      ...toolCallMessages,
      ...toolResults,
    ]

    const awaitUserEntry = executedToolResults.find(entry => entry.result.awaitUser)
    if (awaitUserEntry) {
      const question = awaitUserEntry.result.output.trim()
        if (question.length > 0) {
          args.onAssistantMessage?.(question)
          messages = [
            ...messages,
            {
              role: 'assistant',
              content: question,
            },
          ]
        }
        return { messages, stats: buildStats() }
    }
    }
  } catch (error) {
    // 回合在循环内中断：给错误挂上已累计的部分指标，供外层 runAgentTurn 落库，
    // 避免 steps/tool_calls 等进度在抛错路径上全部记录为 0。
    const statsErr = error as Error & { stats?: TurnStats }
    statsErr.stats = buildStats()
    throw error
  }

  const maxStepContent = `达到最大工具步数限制，已停止当前回合。`
  args.onAssistantMessage?.(maxStepContent, { final: true })
  maxStepsHit = true
  return {
    messages: [
      ...messages,
      {
        role: 'assistant',
        content: maxStepContent,
      },
    ],
    stats: buildStats(),
  }
}
