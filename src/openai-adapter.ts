import type { ToolRegistry } from './tool.js'
import type {
  AgentStep,
  ChatMessage,
  ModelAdapter,
  ModelRequestOptions,
  ProviderThinkingBlock,
  ProviderUsage,
  StepDiagnostics,
  ToolCall,
} from './types.js'
import type { RuntimeConfig } from './config.js'
import { resolveMaxOutputTokens } from './utils/context.js'
import { parseAssistantText } from './utils/text-markers.js'
import { buildAnthropicSnipBoundaryText } from './compact/snipCompact.js'
import { abortableDelay, throwIfAborted } from './abort.js'

const DEFAULT_MAX_RETRIES = 4
const BASE_RETRY_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 8_000

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

type OpenAIUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

function getRetryLimit(): number {
  const value = Number(process.env.LITE_AI_MAX_RETRIES)
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_RETRIES
  }
  return Math.floor(value)
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null
  const asSeconds = Number(retryAfter)
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000)
  }
  const at = Date.parse(retryAfter)
  if (!Number.isFinite(at)) {
    return null
  }
  return Math.max(0, at - Date.now())
}

function getRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return retryAfterMs
  }
  const base = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)),
    MAX_RETRY_DELAY_MS,
  )
  const jitter = Math.random() * 0.25 * base
  return Math.floor(base + jitter)
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) {
    return {}
  }
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.trim() } }
  }
}

function extractErrorMessage(data: unknown, status: number): string {
  if (typeof data === 'string' && data.trim()) {
    return data.trim()
  }
  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'object' &&
    data.error !== null &&
    'message' in data.error &&
    typeof data.error.message === 'string' &&
    data.error.message.trim()
  ) {
    return data.error.message.trim()
  }
  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'string' &&
    data.error.trim()
  ) {
    return data.error.trim()
  }
  if (
    typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string' &&
    data.message.trim()
  ) {
    return data.message.trim()
  }
  return `Model request failed: ${status}`
}

function isAssistantToolCall(
  message: ChatMessage,
): message is Extract<ChatMessage, { role: 'assistant_tool_call' }> {
  return message.role === 'assistant_tool_call'
}

function toOpenAIToolCall(call: Extract<ChatMessage, { role: 'assistant_tool_call' }>): OpenAIToolCall {
  return {
    id: call.toolUseId,
    type: 'function',
    function: {
      name: call.toolName,
      arguments: JSON.stringify(call.input ?? {}),
    },
  }
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  const converted: OpenAIMessage[] = []
  let pendingToolCalls: Extract<ChatMessage, { role: 'assistant_tool_call' }>[] = []

  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return
    converted.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls.map(toOpenAIToolCall),
    })
    pendingToolCalls = []
  }

  for (const message of messages) {
    if (message.role === 'system') {
      converted.push({ role: 'system', content: message.content })
      continue
    }

    if (isAssistantToolCall(message)) {
      pendingToolCalls.push(message)
      continue
    }

    // 遇到非 tool_call 消息，先刷新已累积的 tool_calls 组
    flushToolCalls()

    if (message.role === 'user') {
      converted.push({ role: 'user', content: message.content })
      continue
    }

    // assistant_thinking 为内部推理，按最小改动不回传
    if (message.role === 'assistant_thinking') {
      continue
    }

    if (message.role === 'assistant' || message.role === 'assistant_progress') {
      converted.push({ role: 'assistant', content: message.content })
      continue
    }

    if (message.role === 'context_summary') {
      converted.push({
        role: 'user',
        content: `[Context Summary from earlier conversation]\n${message.content}`,
      })
      continue
    }

    if (message.role === 'snip_boundary') {
      converted.push({ role: 'user', content: buildAnthropicSnipBoundaryText() })
      continue
    }

    if (message.role === 'tool_result') {
      converted.push({
        role: 'tool',
        tool_call_id: message.toolUseId,
        content: message.content,
      })
      continue
    }
  }

  flushToolCalls()
  return converted
}

function normalizeOpenAIUsage(usage: OpenAIUsage | undefined): ProviderUsage | undefined {
  if (!usage) return undefined
  const inputTokens = usage.prompt_tokens ?? 0
  const outputTokens = usage.completion_tokens ?? 0
  const totalTokens = inputTokens + outputTokens
  if (totalTokens <= 0) return undefined
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    source: 'openai',
  }
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

type OpenAiStreamToolState = {
  id?: string
  name?: string
  argsParts: string[]
  emitted?: boolean
}

/**
 * 消费 OpenAI 兼容 SSE 流并组装 AgentStep（DeepSeek 走此通道）。
 *
 * - delta.tool_calls 按 index 累积；OpenAI 规范下各 tool call 的 delta 连续发射，
 *   因此「新 index 首现」即视为此前所有 index 拼装完成 → 触发 onToolCallReady；
 *   finish_reason / 流结束时兜底 flush 全部剩余调用。
 * - content delta 透传 onTextDelta；reasoning_content delta 累积为 thinking 块（DeepSeek）。
 * - usage 依赖 stream_options.include_usage（DeepSeek 官方支持）。
 * - 断流不重试：已触发过工具回调 → 组装部分步骤返回（防孤儿 tool_use）；否则上抛。
 */
async function consumeOpenAiSseStream(
  response: Response,
  callbacks: {
    onToolCallReady?: (call: ToolCall) => void
    onTextDelta?: (text: string) => void
    onThinkingDelta?: (text: string) => void
  },
): Promise<AgentStep> {
  if (!response.body) {
    throw new Error('OpenAI 流式响应缺少 body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const toolStates = new Map<number, OpenAiStreamToolState>()
  const textParts: string[] = []
  const thinkingParts: string[] = []
  let buffer = ''
  let stopReason: string | undefined
  let usage: OpenAIUsage | undefined
  let toolCallEmitted = false
  let finishSeen = false

  const flushTool = (state: OpenAiStreamToolState, index: number): void => {
    if (state.emitted) return
    state.emitted = true
    const rawArgs = state.argsParts.join('')
    toolCallEmitted = true
    callbacks.onToolCallReady?.({
      id: state.id ?? `stream_tool_${index}`,
      toolName: state.name ?? '',
      input: parseToolArguments(rawArgs),
    })
  }

  const flushAll = (): void => {
    for (const [index, state] of toolStates) flushTool(state, index)
  }

  const handleChunk = (data: Record<string, unknown>): void => {
    if (data.usage) {
      usage = data.usage as OpenAIUsage
    }

    const choices = (data.choices ?? []) as Array<Record<string, unknown>>
    const choice = choices[0]
    if (!choice) return

    const delta = (choice.delta ?? {}) as Record<string, unknown>

    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      stopReason = choice.finish_reason
      finishSeen = true
      // finish 到达 = 所有 tool call 拼装完毕
      flushAll()
    }

    if (typeof delta.content === 'string' && delta.content) {
      textParts.push(delta.content)
      callbacks.onTextDelta?.(delta.content)
    }

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      thinkingParts.push(delta.reasoning_content)
      callbacks.onThinkingDelta?.(delta.reasoning_content)
    }

    const deltaToolCalls = delta.tool_calls as
      | Array<{
          index?: number
          id?: string
          function?: { name?: string; arguments?: string }
        }>
      | undefined

    for (const deltaCall of deltaToolCalls ?? []) {
      const index = Number(deltaCall.index ?? 0)
      let state = toolStates.get(index)
      if (!state) {
        // 新 index 首现：按连续发射约定，此前所有 index 均已拼装完成
        for (const [priorIndex, priorState] of toolStates) {
          flushTool(priorState, priorIndex)
        }
        state = { argsParts: [] }
        toolStates.set(index, state)
      }
      if (deltaCall.id) state.id = deltaCall.id
      if (deltaCall.function?.name) state.name = deltaCall.function.name
      if (typeof deltaCall.function?.arguments === 'string') {
        state.argsParts.push(deltaCall.function.arguments)
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator = buffer.indexOf('\n\n')
      while (separator !== -1) {
        const frame = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            handleChunk(JSON.parse(payload) as Record<string, unknown>)
          } catch {
            // 兼容网关可能夹杂非 JSON 帧：忽略坏帧，截断判定由 finishSeen 兜底
          }
        }
        separator = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    if (toolCallEmitted || toolStates.size > 0) {
      // 已有（或已累积的）工具调用：全部 flush 交出去，正常回写 tool_result，防孤儿
      flushAll()
      return buildOpenAiStep(textParts, thinkingParts, toolStates, {
        stopReason,
        usage,
        fallbackStopReason: 'stream_error',
      })
    }
    throw error
  }

  if (!finishSeen) {
    // 流提前关闭（未见 finish_reason）= 传输截断：flush 已累积调用后降级为部分步骤
    if (toolCallEmitted || toolStates.size > 0) {
      flushAll()
      return buildOpenAiStep(textParts, thinkingParts, toolStates, {
        stopReason,
        usage,
        fallbackStopReason: 'stream_error',
      })
    }
    throw new Error('OpenAI 流式响应提前结束（未收到 finish_reason）')
  }

  return buildOpenAiStep(textParts, thinkingParts, toolStates, { stopReason, usage })
}

function buildOpenAiStep(
  textParts: string[],
  thinkingParts: string[],
  toolStates: Map<number, OpenAiStreamToolState>,
  meta: {
    stopReason?: string
    usage?: OpenAIUsage
    fallbackStopReason?: string
  },
): AgentStep {
  const toolCalls: ToolCall[] = [...toolStates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, state]) => ({
      id: state.id ?? `stream_tool_${index}`,
      toolName: state.name ?? '',
      input: parseToolArguments(state.argsParts.join('')),
    }))

  const reasoning = thinkingParts.join('')
  const thinkingBlocks: ProviderThinkingBlock[] = reasoning
    ? [{ type: 'thinking' as const, text: reasoning }]
    : []

  const parsedText = parseAssistantText(textParts.join('').trim())
  const diagnostics: StepDiagnostics = {
    stopReason: meta.stopReason ?? meta.fallbackStopReason,
  }
  const usage = normalizeOpenAIUsage(meta.usage)

  if (toolCalls.length > 0) {
    return {
      type: 'tool_calls' as const,
      calls: toolCalls,
      content: parsedText.content || undefined,
      contentKind: parsedText.kind === 'progress' ? ('progress' as const) : undefined,
      thinkingBlocks,
      diagnostics,
      usage,
    }
  }

  return {
    type: 'assistant' as const,
    content: parsedText.content,
    kind: parsedText.kind,
    thinkingBlocks,
    diagnostics,
    usage,
  }
}

export class OpenAIModelAdapter implements ModelAdapter {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly getRuntimeConfig: () => Promise<RuntimeConfig>,
  ) {}

  async next(
    messages: ChatMessage[],
    options: ModelRequestOptions = {},
  ): Promise<AgentStep> {
    throwIfAborted(options.signal)
    const runtime = await this.getRuntimeConfig()
    const url = `${runtime.baseUrl.replace(/\/$/, '')}/chat/completions`
    const maxOutputTokens = resolveMaxOutputTokens(
      runtime.model,
      runtime.maxOutputTokens,
    )

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (runtime.apiKey) {
      headers.Authorization = `Bearer ${runtime.apiKey}`
    }

    // 流式判定 = 任一流式回调在场（onToolCallReady 边生成边执行 / onTextDelta·onThinkingDelta 纯预览）；
    // 仅声明预览回调时也发 stream 请求，否则文本/思考增量在批处理模式下丢失。
    const streaming =
      options.onToolCallReady != null || options.onTextDelta != null || options.onThinkingDelta != null
    const requestBody = {
      model: runtime.model,
      messages: toOpenAIMessages(messages),
      tools: (options.tools ?? this.tools.list()).map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      max_tokens: maxOutputTokens,
      ...(streaming
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
    }

    const maxRetries = getRetryLimit()
    let response: Response | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: options.signal,
      })
      if (response.ok) {
        break
      }
      if (!shouldRetryStatus(response.status) || attempt >= maxRetries) {
        break
      }
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      await abortableDelay(
        getRetryDelayMs(attempt + 1, retryAfterMs),
        options.signal,
      )
    }

    if (!response) {
      throw new Error('Model request failed before receiving a response')
    }

    if (!response.ok) {
      const errorData = (await readJsonBody(response)) as {
        error?: { message?: string }
      }
      throw new Error(extractErrorMessage(errorData, response.status))
    }

    // 流式分支：SSE 边生成边回调（重试已在 fetch 阶段完成；流中途失败不重试，见 consumeOpenAiSseStream）。
    // 准入 = 任一流式回调在场：onToolCallReady（执行器边生成边执行）或 onTextDelta/onThinkingDelta（纯预览）。
    // 防御：兼容网关可能无视 stream 参数直接返回 JSON —— content-type 非 event-stream 时降级非流式解析。
    if (streaming && (options.onToolCallReady || options.onTextDelta || options.onThinkingDelta)) {
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) {
        return consumeOpenAiSseStream(response, {
          onToolCallReady: options.onToolCallReady,
          onTextDelta: options.onTextDelta,
          onThinkingDelta: options.onThinkingDelta,
        })
      }
    }

    const data = (await readJsonBody(response)) as {
      choices?: Array<{
        finish_reason?: string
        message?: {
          content?: string | null
          reasoning_content?: string | null
          tool_calls?: Array<{
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
      usage?: OpenAIUsage
      error?: { message?: string }
    }

    const choice = data.choices?.[0]
    const message = choice?.message

    const toolCalls: ToolCall[] = []
    for (const call of message?.tool_calls ?? []) {
      if (!call.id || !call.function?.name) continue
      toolCalls.push({
        id: call.id,
        toolName: call.function.name,
        input: parseToolArguments(call.function.arguments ?? ''),
      })
    }

    const reasoning = message?.reasoning_content
    const thinkingBlocks: ProviderThinkingBlock[] = reasoning
      ? [{ type: 'thinking' as const, text: reasoning }]
      : []

    const parsedText = parseAssistantText(message?.content ?? '')
    const diagnostics: StepDiagnostics = {
      stopReason: choice?.finish_reason,
    }
    const usage = normalizeOpenAIUsage(data.usage)

    if (toolCalls.length > 0) {
      return {
        type: 'tool_calls' as const,
        calls: toolCalls,
        content: parsedText.content || undefined,
        contentKind:
          parsedText.kind === 'progress'
            ? ('progress' as const)
            : undefined,
        thinkingBlocks,
        diagnostics,
        usage,
      }
    }

    return {
      type: 'assistant' as const,
      content: parsedText.content,
      kind: parsedText.kind,
      thinkingBlocks,
      diagnostics,
      usage,
    }
  }
}