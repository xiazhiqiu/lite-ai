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

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [key: string]: unknown }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

type AnthropicUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
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

function isTextBlock(block: AnthropicContentBlock): block is Extract<AnthropicContentBlock, {
  type: 'text'
}> {
  return block.type === 'text' && typeof block.text === 'string'
}

function isToolUseBlock(block: AnthropicContentBlock): block is Extract<AnthropicContentBlock, {
  type: 'tool_use'
}> {
  return (
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    typeof block.name === 'string'
  )
}

function isThinkingBlock(block: AnthropicContentBlock): block is ProviderThinkingBlock {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

function toTextBlock(text: string): AnthropicContentBlock {
  return { type: 'text', text }
}

function normalizeAnthropicUsage(usage: AnthropicUsage | undefined): ProviderUsage | undefined {
  if (!usage) return undefined
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  const outputTokens = usage.output_tokens ?? 0
  const totalTokens = inputTokens + outputTokens
  if (totalTokens <= 0) return undefined
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    source: 'anthropic',
  }
}

function toAssistantText(message: Extract<ChatMessage, {
  role: 'assistant' | 'assistant_progress'
}>): string {
  if (message.role === 'assistant_progress') {
    return `<progress>\n${message.content}\n</progress>`
  }

  return message.content
}

function pushAnthropicMessage(
  messages: AnthropicMessage[],
  role: 'user' | 'assistant',
  block: AnthropicContentBlock,
): void {
  const last = messages.at(-1)
  if (last?.role === role) {
    last.content.push(block)
    return
  }

  messages.push({ role, content: [block] })
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string
  messages: AnthropicMessage[]
} {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n')

  const converted: AnthropicMessage[] = []

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'user') {
      pushAnthropicMessage(converted, 'user', toTextBlock(message.content))
      continue
    }

    if (message.role === 'assistant_thinking') {
      for (const block of message.blocks) {
        pushAnthropicMessage(converted, 'assistant', block)
      }
      continue
    }

    if (message.role === 'assistant' || message.role === 'assistant_progress') {
      pushAnthropicMessage(
        converted,
        'assistant',
        toTextBlock(toAssistantText(message)),
      )
      continue
    }

    if (message.role === 'assistant_tool_call') {
      pushAnthropicMessage(converted, 'assistant', {
        type: 'tool_use',
        id: message.toolUseId,
        name: message.toolName,
        input: message.input,
      })
      continue
    }

    if (message.role === 'context_summary') {
      pushAnthropicMessage(converted, 'user', toTextBlock(
        `[Context Summary from earlier conversation]\n${message.content}`,
      ))
      continue
    }

    if (message.role === 'snip_boundary') {
      pushAnthropicMessage(converted, 'user', toTextBlock(
        buildAnthropicSnipBoundaryText(),
      ))
      continue
    }

    pushAnthropicMessage(converted, 'user', {
      type: 'tool_result',
      tool_use_id: message.toolUseId,
      content: message.content,
      is_error: message.isError,
    })
  }

  return { system, messages: converted }
}

type SseBlockState = {
  type: string
  toolId?: string
  toolName?: string
  toolJson?: string
  toolInput?: unknown
  text?: string
  thinking?: string
  signature?: string
  redactedData?: unknown
  emitted?: boolean
}

/**
 * 合并 message_start / message_delta 的 usage：
 * input 与 cache 字段来自 message_start，output_tokens 由 message_delta 提供累计值。
 */
function mergeUsage(
  base: AnthropicUsage | undefined,
  incoming: AnthropicUsage | undefined,
): AnthropicUsage | undefined {
  if (!incoming) return base
  if (!base) return incoming
  return { ...base, ...incoming }
}

/**
 * 消费 Anthropic SSE 流并组装 AgentStep。
 *
 * - tool_use 块的 input_json_delta 拼装完成后（content_block_stop）立即触发 onToolCallReady；
 * - 文本增量透传 onTextDelta；
 * - 断流不重试（fetch 阶段的 429/5xx 重试已在此前的循环里完成）：
 *   已触发过工具回调 → 组装部分步骤返回（保证已发射的 tool_use 都有 tool_result，防孤儿）；
 *   未触发过 → 直接上抛（此时无任何副作用，重试责任在调用方）。
 */
function hasToolUseBlocks(blocks: Map<number, SseBlockState>): boolean {
  for (const state of blocks.values()) {
    if (state.type === 'tool_use') return true
  }
  return false
}

async function consumeAnthropicSseStream(
  response: Response,
  callbacks: {
    onToolCallReady?: (call: ToolCall) => void
    onTextDelta?: (text: string) => void
    onThinkingDelta?: (text: string) => void
  },
): Promise<AgentStep> {
  if (!response.body) {
    throw new Error('Anthropic 流式响应缺少 body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const blocks = new Map<number, SseBlockState>()
  const blockTypes: string[] = []
  const ignoredBlockTypes = new Set<string>()
  let buffer = ''
  let stopReason: string | undefined
  let usage: AnthropicUsage | undefined
  let messageStopSeen = false

  const handleEvent = (data: Record<string, unknown>) => {
    const type = data.type
    if (type === 'message_start') {
      const message = data.message as { usage?: AnthropicUsage } | undefined
      usage = mergeUsage(usage, message?.usage)
      return
    }

    if (type === 'content_block_start') {
      const index = Number(data.index)
      const block = (data.content_block ?? {}) as Record<string, unknown>
      blockTypes.push(String(block.type))
      blocks.set(index, {
        type: String(block.type),
        toolId: typeof block.id === 'string' ? block.id : undefined,
        toolName: typeof block.name === 'string' ? block.name : undefined,
        redactedData: block.data,
      })
      return
    }

    if (type === 'content_block_delta') {
      const state = blocks.get(Number(data.index))
      if (!state) return
      const delta = (data.delta ?? {}) as Record<string, unknown>
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        state.text = (state.text ?? '') + delta.text
        callbacks.onTextDelta?.(delta.text)
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        state.toolJson = (state.toolJson ?? '') + delta.partial_json
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        state.thinking = (state.thinking ?? '') + delta.thinking
        callbacks.onThinkingDelta?.(delta.thinking)
      } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        state.signature = (state.signature ?? '') + delta.signature
      }
      return
    }

    if (type === 'content_block_stop') {
      const state = blocks.get(Number(data.index))
      if (!state || state.emitted) return
      if (state.type === 'tool_use') {
        state.emitted = true
        try {
          state.toolInput = state.toolJson ? JSON.parse(state.toolJson) : {}
        } catch {
          // 参数 JSON 损坏：保留调用但置空输入，让 schema 校验拒绝并回写错误结果（防孤儿 tool_use）
          state.toolInput = {}
        }
        callbacks.onToolCallReady?.({
          id: state.toolId ?? '',
          toolName: state.toolName ?? '',
          input: state.toolInput,
        })
      }
      return
    }

    if (type === 'message_delta') {
      const delta = (data.delta ?? {}) as { stop_reason?: string }
      if (delta.stop_reason) stopReason = delta.stop_reason
      usage = mergeUsage(usage, data.usage as AnthropicUsage | undefined)
      return
    }

    if (type === 'message_stop') {
      messageStopSeen = true
      return
    }

    if (type === 'error') {
      const error = data.error as { message?: string } | undefined
      throw new Error(error?.message ?? 'Anthropic 流式错误')
    }

    if (type && type !== 'ping' && type !== 'message_stop') {
      ignoredBlockTypes.add(String(type))
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
          if (!payload) continue
          handleEvent(JSON.parse(payload) as Record<string, unknown>)
        }
        separator = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    if (hasToolUseBlocks(blocks)) {
      // 已有工具调用（可能尚未收到 content_block_stop）：降级为部分步骤，正常回写 tool_result，防孤儿
      return buildStepFromBlocks(blocks, {
        blockTypes,
        ignoredBlockTypes,
        stopReason,
        usage,
        fallbackStopReason: 'stream_error',
      })
    }
    throw error
  }

  if (!messageStopSeen) {
    // 流提前关闭（未到 message_stop）= 传输截断，与中途抛错同样处理
    const truncated = new Error('Anthropic 流式响应提前结束（未收到 message_stop）')
    if (hasToolUseBlocks(blocks)) {
      return buildStepFromBlocks(blocks, {
        blockTypes,
        ignoredBlockTypes,
        stopReason,
        usage,
        fallbackStopReason: 'stream_error',
      })
    }
    throw truncated
  }

  return buildStepFromBlocks(blocks, {
    blockTypes,
    ignoredBlockTypes,
    stopReason,
    usage,
  })
}

function buildStepFromBlocks(
  blocks: Map<number, SseBlockState>,
  meta: {
    blockTypes: string[]
    ignoredBlockTypes: Set<string>
    stopReason?: string
    usage?: AnthropicUsage
    fallbackStopReason?: string
  },
): AgentStep {
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, state]) => state)

  const toolCalls: ToolCall[] = []
  const textParts: string[] = []
  const thinkingBlocks: ProviderThinkingBlock[] = []

  for (const state of ordered) {
    if (state.type === 'text') {
      if (state.text) textParts.push(state.text)
      continue
    }

    if (state.type === 'tool_use') {
      toolCalls.push({
        id: state.toolId ?? '',
        toolName: state.toolName ?? '',
        input: state.toolInput ?? {},
      })
      continue
    }

    if (state.type === 'thinking' || state.type === 'redacted_thinking') {
      const block: ProviderThinkingBlock = { type: state.type }
      if (state.thinking !== undefined) block.thinking = state.thinking
      if (state.signature !== undefined) block.signature = state.signature
      if (state.redactedData !== undefined) block.data = state.redactedData
      thinkingBlocks.push(block)
    }
  }

  const parsedText = parseAssistantText(textParts.join('\n').trim())
  const diagnostics: StepDiagnostics = {
    stopReason: meta.stopReason ?? meta.fallbackStopReason,
    blockTypes: meta.blockTypes,
    ignoredBlockTypes: [...meta.ignoredBlockTypes],
  }
  const normalizedUsage = normalizeAnthropicUsage(meta.usage)

  if (toolCalls.length > 0) {
    return {
      type: 'tool_calls' as const,
      calls: toolCalls,
      content: parsedText.content || undefined,
      contentKind: parsedText.kind === 'progress' ? ('progress' as const) : undefined,
      thinkingBlocks,
      diagnostics,
      usage: normalizedUsage,
    }
  }

  return {
    type: 'assistant' as const,
    content: parsedText.content,
    kind: parsedText.kind,
    thinkingBlocks,
    diagnostics,
    usage: normalizedUsage,
  }
}

export class AnthropicModelAdapter implements ModelAdapter {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly getRuntimeConfig: () => Promise<RuntimeConfig>,
  ) {}

  async next(
    messages: ChatMessage[],
    options: ModelRequestOptions = {},
  ) {
    throwIfAborted(options.signal)
    const runtime = await this.getRuntimeConfig()
    const payload = toAnthropicMessages(messages)
    const url = `${runtime.baseUrl.replace(/\/$/, '')}/v1/messages`
    const maxOutputTokens = resolveMaxOutputTokens(
      runtime.model,
      runtime.maxOutputTokens,
    )

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }

    if (runtime.authToken) {
      headers.Authorization = `Bearer ${runtime.authToken}`
    } else if (runtime.apiKey) {
      headers['x-api-key'] = runtime.apiKey
    }

    // 流式判定 = 任一流式回调在场（onToolCallReady 边生成边执行 / onTextDelta·onThinkingDelta 纯预览）；
    // 仅声明预览回调时也发 stream 请求，否则文本/思考增量在批处理模式下丢失。
    const streaming =
      options.onToolCallReady != null || options.onTextDelta != null || options.onThinkingDelta != null
    const requestBody = {
      model: runtime.model,
      system: payload.system,
      messages: payload.messages,
      tools: (options.tools ?? this.tools.list()).map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      max_tokens: maxOutputTokens,
      ...(streaming ? { stream: true } : {}),
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

    // 流式分支：SSE 边生成边回调（重试已在 fetch 阶段完成；流中途失败不重试，见 consumeAnthropicSseStream）。
    // 准入 = 任一流式回调在场：onToolCallReady（执行器边生成边执行）或 onTextDelta/onThinkingDelta（纯预览）。
    // 防御：兼容网关可能无视 stream 参数直接返回 JSON —— content-type 非 event-stream 时降级非流式解析。
    if (streaming && (options.onToolCallReady || options.onTextDelta || options.onThinkingDelta)) {
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) {
        return consumeAnthropicSseStream(response, {
          onToolCallReady: options.onToolCallReady,
          onTextDelta: options.onTextDelta,
          onThinkingDelta: options.onThinkingDelta,
        })
      }
    }

    const data = (await readJsonBody(response)) as {
      stop_reason?: string
      content?: AnthropicContentBlock[]
      usage?: AnthropicUsage
      error?: { message?: string }
    }

    const toolCalls: ToolCall[] = []
    const textParts: string[] = []
    const thinkingBlocks: ProviderThinkingBlock[] = []
    const blockTypes: string[] = []
    const ignoredBlockTypes = new Set<string>()

    for (const block of data.content ?? []) {
      blockTypes.push(block.type)

      if (isTextBlock(block)) {
        textParts.push(block.text)
        continue
      }

      if (isToolUseBlock(block)) {
        toolCalls.push({
          id: block.id,
          toolName: block.name,
          input: block.input,
        })
        continue
      }

      if (isThinkingBlock(block)) {
        thinkingBlocks.push(block)
        continue
      }

      ignoredBlockTypes.add(block.type)
    }

    const parsedText = parseAssistantText(textParts.join('\n').trim())
    const diagnostics: StepDiagnostics = {
      stopReason: data.stop_reason,
      blockTypes,
      ignoredBlockTypes: [...ignoredBlockTypes],
    }
    const usage = normalizeAnthropicUsage(data.usage)

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
