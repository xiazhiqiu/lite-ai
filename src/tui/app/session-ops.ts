import { buildSystemPrompt } from '../../prompt.js'
import { appendContextCollapseSpan, loadTranscript, loadContextCollapseState } from '../../session.js'
import type { ChatMessage, CompressionResult } from '../../types.js'
import { createContextCollapseState, type ContextCollapseResult } from '../../compact/context-collapse.js'
import type { TtyAppArgs, ScreenState } from './types.js'
import { setStatus } from './render.js'
import { pushTranscriptEntry, updateToolEntry, collapseToolEntry, getRunningToolEntries, finalizeDanglingRunningTools, summarizeCollapsedToolBody, summarizeToolInput } from './transcript-entries.js'

export async function refreshSystemPrompt(args: TtyAppArgs): Promise<void> {
  args.messages[0] = {
    role: 'system',
    content: await buildSystemPrompt(args.cwd, args.permissions.getSummary(), {
      skills: args.tools.getSkills(),
      mcpServers: args.tools.getMcpServers(),
      subAgents: { maxConcurrent: args.subAgents.maxConcurrent },
    }),
  }
}

export function retainedMessagesAfterCompact(result: CompressionResult): ChatMessage[] {
  return result.messages.filter(message => (
    message.role !== 'system' && message !== result.summary
  ))
}

export async function persistContextCollapseResult(
  args: TtyAppArgs,
  result: ContextCollapseResult,
): Promise<number> {
  const spans = result.spans.length > 0
    ? result.spans
    : result.span
      ? [result.span]
      : []

  for (const span of spans) {
    await appendContextCollapseSpan(args.cwd, args.sessionId, span)
  }

  return spans.reduce(
    (sum, span) => sum + Math.max(0, span.tokensBefore - span.tokensAfter),
    0,
  )
}

export async function executeToolShortcut(
  args: TtyAppArgs,
  state: ScreenState,
  toolName: string,
  input: unknown,
  rerender: () => void,
): Promise<void> {
  state.isBusy = true
  setStatus(state, `Running ${toolName}...`)
  state.activeTool = toolName
  const entryId = pushTranscriptEntry(state, {
    kind: 'tool',
    toolName,
    status: 'running',
    body: summarizeToolInput(toolName, input),
  })
  rerender()

  try {
    const result = await args.tools.execute(toolName, input, {
      cwd: args.cwd,
      permissions: args.permissions,
    })

    state.recentTools.push({
      name: toolName,
      status: result.ok ? 'success' : 'error',
    })
    updateToolEntry(
      state,
      entryId,
      result.ok ? 'success' : 'error',
      result.ok ? result.output : `ERROR: ${result.output}`,
    )
    collapseToolEntry(
      state,
      entryId,
      summarizeCollapsedToolBody(
        result.ok ? result.output : `ERROR: ${result.output}`,
      ),
    )
    state.transcriptScrollOffset = 0
  } finally {
    state.isBusy = false
    state.activeTool = null
    finalizeDanglingRunningTools(state)
    if (getRunningToolEntries(state).length === 0) {
      setStatus(state, null)
    }
  }
}

export async function resumeSession(
  args: TtyAppArgs,
  state: ScreenState,
  sessionId: string,
  loaded: ChatMessage[],
): Promise<void> {
  args.sessionId = sessionId
  const systemContent =
    args.messages[0]?.role === 'system' ? args.messages[0].content : ''
  await refreshSystemPrompt(args)
  args.messages.length = 0
  args.messages.push({ role: 'system', content: systemContent })
  args.messages.push(...loaded)
  state.transcript = []
  const persistedTranscript = await loadTranscript(args.cwd, sessionId)
  if (persistedTranscript && persistedTranscript.length > 0) {
    for (const entry of persistedTranscript) {
      pushTranscriptEntry(state, entry)
    }
  } else {
    for (const msg of loaded) {
      if (msg.role === 'user') {
        pushTranscriptEntry(state, { kind: 'user', body: msg.content })
      } else if (msg.role === 'assistant') {
        pushTranscriptEntry(state, { kind: 'assistant', body: msg.content })
      } else if (msg.role === 'assistant_tool_call') {
        pushTranscriptEntry(state, {
          kind: 'tool',
          toolName: msg.toolName,
          status: 'success',
          body: summarizeToolInput(msg.toolName, msg.input),
        })
      } else if (msg.role === 'context_summary') {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `[Context summary: ${msg.compressedCount} messages compressed]`,
        })
      } else if (msg.role === 'snip_boundary') {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Snipped earlier context: removed ${msg.removedCount} messages, freed ~${Math.round(msg.tokensFreed)} tokens.`,
        })
      }
    }
  }
  pushTranscriptEntry(state, {
    kind: 'assistant',
    body: `Session ${sessionId} resumed (${loaded.length} messages loaded).`,
  })
  args.alreadySavedCount = loaded.length
  args.contextCollapseState =
    await loadContextCollapseState(args.cwd, sessionId) ??
    createContextCollapseState()
  state.transcriptScrollOffset = 0
}
