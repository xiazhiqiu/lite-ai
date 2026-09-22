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

/** 单次模型请求超时，防止上游无响应时无限阻塞 agent turn。 */
const MODEL_REQUEST_TIMEOUT_MS = 5 * 60 * 1000

function withRequestTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAIToolCall[]
      reasoning_content?: string
    }
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

/** thinking 模式模型（如 deepseek-reasoner）多轮对话必须把 reasoning_content 回传给 API */
function isThinkingModel(model: string): boolean {
  const normalized = model.toLowerCase()
  return normalized.includes('reasoner') || normalized.includes('thinking')
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

function toOpenAIMessages(
  messages: ChatMessage[],
  opts: { passBackReasoning?: boolean } = {},
): OpenAIMessage[] {
  const converted: OpenAIMessage[] = []
  let pendingToolCalls: Extract<ChatMessage, { role: 'assistant_tool_call' }>[] = []
  // thinking 模式：把上一条 assistant_thinking 的推理文本回传到后续 assistant 消息的 reasoning_content
  let pendingReasoning: string | undefined

  // thinking 模式要求的是字段**在场**，不是字段**非空** —— 空串同样必须回传。
  //
  // 曾经的写法是 `...(pendingReasoning ? { reasoning_content } : {})`：provider 返回
  // `reasoning_content: ""`（字段在、内容空）时被当成"没有推理"，字段整个消失，
  // 下一次请求直接 400 `The reasoning_content in the thinking mode must be passed back to the API`。
  //
  // 对真实失败请求体做过单变量变异，结论：
  //   · 只给「带 tool_calls 那条」补 → 仍 400
  //   · 只给「tool_calls 之前那条文本 assistant」补 → 200
  //   · 给「全部 assistant」补（空串）→ 200
  // 因此这里取安全超集：只要开了回传，每条 assistant 消息都带上该字段。
  const reasoningFields = (): { reasoning_content?: string } => {
    if (opts.passBackReasoning) return { reasoning_content: pendingReasoning ?? '' }
    return pendingReasoning ? { reasoning_content: pendingReasoning } : {}
  }

  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return
    converted.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls.map(toOpenAIToolCall),
      ...reasoningFields(),
    })
    pendingToolCalls = []
    pendingReasoning = undefined
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

    // assistant_thinking 为内部推理，默认不回传；thinking 模式模型需原样回传 reasoning_content
    if (message.role === 'assistant_thinking') {
      if (opts.passBackReasoning) {
        const reasoning = message.blocks
          .map(block => (typeof block.text === 'string' ? block.text : ''))
          .filter(Boolean)
          .join('\n')
        if (reasoning) pendingReasoning = reasoning
      }
      continue
    }

    if (message.role === 'assistant' || message.role === 'assistant_progress') {
      converted.push({
        role: 'assistant',
        content: message.content,
        ...reasoningFields(),
      })
      pendingReasoning = undefined
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
  /**
   * provider 是否在响应里返回过 `reasoning_content` 字段（**含空串**）。
   *
   * 用来补 `isThinkingModel()` 的名字启发式的漏判：`deepseek-v4-flash` 这类名字既不含
   * "reasoner" 也不含 "thinking"，启发式判为 false，但服务端确实按 thinking 模式校验，
   * 会在带 tool 的下一轮要求回传该字段（实测 400）。以「provider 真的返回过」为依据，
   * 比猜模型名可靠。
   */
  private sawReasoningField = false

  constructor(
    private readonly tools: ToolRegistry,
    private readonly getRuntimeConfig: () => Promise<RuntimeConfig>,
  ) {}

  async next(
    messages: ChatMessage[],
    options: ModelRequestOptions = {},
  ): Promise<AgentStep> {
    throwIfAborted(options.signal)
    const requestSignal = withRequestTimeout(options.signal)
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
      messages: toOpenAIMessages(messages, {
        passBackReasoning:
          runtime.passBackReasoning ??
          (isThinkingModel(runtime.model) || this.sawReasoningField),
      }),
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
        signal: requestSignal,
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
        requestSignal,
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
    // 记录"provider 返回了该字段"这一事实（含空串），供下一轮决定是否回传。
    if (message !== undefined && 'reasoning_content' in message) {
      this.sawReasoningField = true
    }
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