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

    if (!response.ok) {
      throw new Error(extractErrorMessage(data, response.status))
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