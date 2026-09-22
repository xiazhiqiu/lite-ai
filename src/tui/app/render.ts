import process from 'node:process'
import { listBackgroundTasks } from '../../background-tasks.js'
import { SLASH_COMMANDS, findMatchingSlashCommands } from '../../cli-commands.js'
import { summarizeMcpServers } from '../../mcp-status.js'
import { getPermissionPromptMaxScrollOffset, renderBanner, renderFooterBar, renderInputPrompt, renderPanel, renderPermissionPrompt, renderPermissionSummaryLine, renderSlashMenu, renderStatusLine, renderTerminalFrame, renderToolPanel, renderTranscript, getTranscriptMaxScrollOffset, renderTranscriptLines, getTranscriptWindowSize, type TranscriptSelection } from '../../ui.js'
import type { SubAgentManager } from '../../agents/manager.js'
import type { TtyAppArgs, ScreenState } from './types.js'

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function keepSelectionAfterMouseRelease(
  selection: TranscriptSelection | null,
): TranscriptSelection | null {
  return selection
}
export function getSessionStats(args: TtyAppArgs, state: ScreenState) {
  const mcpStatus = summarizeMcpServers(args.tools.getMcpServers())
  return {
    transcriptCount: state.transcript.length,
    messageCount: args.messages.length,
    skillCount: args.tools.getSkills().length,
    mcpTotalCount: mcpStatus.total,
    mcpConnectedCount: mcpStatus.connected,
    mcpConnectingCount: mcpStatus.connecting,
    mcpErrorCount: mcpStatus.error,
    contextStats: state.contextStats,
  }
}

export function renderHeaderPanel(args: TtyAppArgs, state: ScreenState): string {
  return renderBanner(
    args.runtime,
    args.cwd,
    args.permissions.getSummary(),
    getSessionStats(args, state),
  )
}

export function renderPromptPanel(state: ScreenState): string {
  const commands = getVisibleCommands(state.input)
  const promptBody = [
    renderInputPrompt(state.input, state.cursorOffset, state.inputHintFrame),
    commands.length > 0
      ? `\n${renderSlashMenu(
          commands,
          Math.min(state.selectedSlashIndex, commands.length - 1),
        )}`
      : '',
  ].join('')
  return renderPanel('prompt', promptBody, { showTitle: false })
}

export function renderPermissionSummary(args: TtyAppArgs, state: ScreenState): string {
  return renderPermissionSummaryLine(
    args.permissions.getSummary(),
    state.inputHintFrame,
  )
}

export function setStatus(state: ScreenState, status: string | null): void {
  state.status = status
  if (status === 'Thinking...') {
    state.thinkingStartedAt ??= Date.now()
  } else {
    state.thinkingStartedAt = null
  }
}

export function renderFooterStatus(state: ScreenState): string {
  if (state.status === 'Thinking...') {
    const startedAt = state.thinkingStartedAt ?? Date.now()
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    return `\u001b[33m\u001b[1mThinking(${seconds}s)\u001b[0m`
  }
  return renderStatusLine(state.status, state.statusAnimationFrame)
}

export function getTranscriptBodyLines(args: TtyAppArgs, state: ScreenState): number {
  const rows = Math.max(24, process.stdout.rows ?? 40)
  const headerLines = renderHeaderPanel(args, state).split('\n').length
  const permissionSummaryLines = renderPermissionSummary(args, state).split('\n').length
  const promptLines = renderPromptPanel(state).split('\n').length
  const footerLines = 1
  const gapsBetweenSections = 2
  const transcriptPanelFrameLines = 0
  const remaining =
    rows -
    headerLines -
    permissionSummaryLines -
    promptLines -
    footerLines -
    gapsBetweenSections -
    transcriptPanelFrameLines

  return Math.max(6, remaining)
}

export function getMaxTranscriptScrollOffset(args: TtyAppArgs, state: ScreenState): number {
  return getTranscriptMaxScrollOffset(
    state.transcript,
    getTranscriptBodyLines(args, state),
  )
}
export function screenToAbsoluteLineIndex(
  _args: TtyAppArgs,
  state: ScreenState,
  screenY: number,
): number {
  const bodyStartY = state.transcriptBodyStartY
  const bodyY = screenY - bodyStartY
  if (bodyY < 0) return -1

  const lines = renderTranscriptLines(state.transcript)
  const pageSize = getTranscriptWindowSize(state.transcriptBodyLines)
  const maxOffset = Math.max(0, lines.length - pageSize)
  const offset = Math.max(0, Math.min(state.transcriptScrollOffset, maxOffset))
  const end = lines.length - offset
  const start = Math.max(0, end - pageSize)

  const lineIndex = start + bodyY
  if (lineIndex < 0) return -1
  if (lines.length === 0) return -1
  return Math.min(lineIndex, lines.length - 1)
}
export function scrollTranscriptBy(
  args: TtyAppArgs,
  state: ScreenState,
  delta: number,
): boolean {
  const nextOffset = Math.max(
    0,
    Math.min(
      getMaxTranscriptScrollOffset(args, state),
      state.transcriptScrollOffset + delta,
    ),
  )

  if (nextOffset === state.transcriptScrollOffset) {
    return false
  }

  state.transcriptScrollOffset = nextOffset
  return true
}

export function jumpTranscriptToEdge(
  args: TtyAppArgs,
  state: ScreenState,
  target: 'top' | 'bottom',
): boolean {
  const nextOffset =
    target === 'top' ? getMaxTranscriptScrollOffset(args, state) : 0
  if (nextOffset === state.transcriptScrollOffset) {
    return false
  }

  state.transcriptScrollOffset = nextOffset
  return true
}

export function getPendingApprovalMaxScrollOffset(state: ScreenState): number {
  const pending = state.pendingApproval
  if (!pending) return 0
  return getPermissionPromptMaxScrollOffset(pending.request, {
    expanded: pending.detailsExpanded,
  })
}

export function scrollPendingApprovalBy(state: ScreenState, delta: number): boolean {
  const pending = state.pendingApproval
  if (!pending || !pending.detailsExpanded) {
    return false
  }

  const maxOffset = getPendingApprovalMaxScrollOffset(state)
  const nextOffset = Math.max(
    0,
    Math.min(maxOffset, pending.detailsScrollOffset + delta),
  )
  if (nextOffset === pending.detailsScrollOffset) {
    return false
  }
  pending.detailsScrollOffset = nextOffset
  return true
}

export function togglePendingApprovalExpand(state: ScreenState): boolean {
  const pending = state.pendingApproval
  if (!pending || pending.request.kind !== 'edit') {
    return false
  }
  pending.detailsExpanded = !pending.detailsExpanded
  pending.detailsScrollOffset = 0
  return true
}

export function movePendingApprovalSelection(state: ScreenState, delta: number): boolean {
  const pending = state.pendingApproval
  if (!pending || pending.feedbackMode) {
    return false
  }
  const total = pending.request.choices.length
  if (total <= 0) return false
  pending.selectedChoiceIndex =
    (pending.selectedChoiceIndex + delta + total) % total
  return true
}

export function historyUp(state: ScreenState): boolean {
  if (state.history.length === 0 || state.historyIndex <= 0) {
    return false
  }

  if (state.historyIndex === state.history.length) {
    state.historyDraft = state.input
  }

  state.historyIndex -= 1
  state.input = state.history[state.historyIndex] ?? ''
  state.cursorOffset = state.input.length
  return true
}

export function historyDown(state: ScreenState): boolean {
  if (state.historyIndex >= state.history.length) {
    return false
  }

  state.historyIndex += 1
  state.input =
    state.historyIndex === state.history.length
      ? state.historyDraft
      : (state.history[state.historyIndex] ?? '')
  state.cursorOffset = state.input.length
  return true
}

export function getVisibleCommands(input: string) {
  if (!input.startsWith('/')) return []
  if (input === '/') return SLASH_COMMANDS
  const matches = findMatchingSlashCommands(input)
  return SLASH_COMMANDS.filter(command => matches.includes(command.usage))
}
export function renderScreen(args: TtyAppArgs, state: ScreenState): void {
  const backgroundTasks = listBackgroundTasks()
  const frame: string[] = []
  const headerPanel = renderHeaderPanel(args, state)
  frame.push(headerPanel)
  frame.push('')
  state.transcriptBodyStartY = headerPanel.split('\n').length + 4
  state.transcriptBodyLines = getTranscriptBodyLines(args, state)

  if (state.pendingApproval) {
    frame.push(
      renderPanel('approval', renderPermissionPrompt(state.pendingApproval.request, {
        expanded: state.pendingApproval.detailsExpanded,
        scrollOffset: state.pendingApproval.detailsScrollOffset,
        selectedChoiceIndex: state.pendingApproval.selectedChoiceIndex,
        feedbackMode: state.pendingApproval.feedbackMode,
        feedbackInput: state.pendingApproval.feedbackInput,
      })),
    )
    frame.push('')
    frame.push(renderPanel('activity', renderToolPanel(state.activeTool, state.recentTools, backgroundTasks)))
    frame.push('')
    frame.push(
      renderFooterBar(
        state.status,
        true,
        args.tools.getSkills().length > 0,
        summarizeMcpServers(args.tools.getMcpServers()),
        backgroundTasks,
        state.compressionStatus,
        state.statusAnimationFrame,
        undefined,
        renderSubAgentFooter(args.subAgents),
      ),
    )
    renderTerminalFrame(frame.join('\n'))
    return
  }

  if (state.sessionPicker) {
    if (state.sessionPicker.allProjects) {
      const projects = state.sessionPicker.projects
      const lines = projects.map((p, i) => {
        const marker = i === state.sessionPicker!.projectSelectedIndex ? ' > ' : '   '
        const ago = formatRelativeTime(p.latestUpdatedAt)
        return `${marker}${p.dir}  ${p.sessionCount} sessions  ${ago}`
      })
      const body = `All projects:\n\n${lines.join('\n')}\n\nEnter to see info, Tab to go back, Esc to cancel`
      frame.push(renderPanel('projects', body))
    } else {
      const lines = state.sessionPicker.sessions.map((s, i) => {
        const marker = i === state.sessionPicker!.selectedIndex ? ' > ' : '   '
        const title = s.title ? `  ${s.title}` : ''
        const ago = formatRelativeTime(s.updatedAt)
        const deleteTag = state.sessionPicker!.deleteConfirmIndex === i ? '  [DELETE? Press d again to confirm]' : ''
        return `${marker}${s.id}${title}  ${s.messageCount} messages  ${ago}${deleteTag}`
      })
      const body = `Select a session to resume:\n\n${lines.join('\n')}\n\n↑/↓ to select, Enter to resume, d to delete, Tab for all projects, Esc to cancel`
      frame.push(renderPanel('sessions', body))
    }
    frame.push('')
    frame.push(
      renderFooterBar(
        state.status,
        true,
        args.tools.getSkills().length > 0,
        summarizeMcpServers(args.tools.getMcpServers()),
        backgroundTasks,
        state.compressionStatus,
        state.statusAnimationFrame,
        undefined,
        renderSubAgentFooter(args.subAgents),
      ),
    )
    renderTerminalFrame(frame.join('\n'))
    return
  }

  frame.push(
    renderPanel(
      'session feed',
      state.transcript.length > 0
        ? renderTranscript(
            state.transcript,
            state.transcriptScrollOffset,
            getTranscriptBodyLines(args, state),
            state.selection ?? undefined,
          )
        : '',
      {
        minBodyLines: getTranscriptBodyLines(args, state),
        frame: false,
      },
    ),
  )
  frame.push(renderPermissionSummary(args, state))
  frame.push(renderPromptPanel(state))
  frame.push(
    renderFooterBar(
      state.status,
      true,
      args.tools.getSkills().length > 0,
      summarizeMcpServers(args.tools.getMcpServers()),
      backgroundTasks,
      state.compressionStatus,
      state.statusAnimationFrame,
      renderFooterStatus(state),
      renderSubAgentFooter(args.subAgents),
    ),
  )
  renderTerminalFrame(frame.join('\n'))
}

export function renderSubAgentFooter(manager: SubAgentManager): string | undefined {
  if (manager.runningCount === 0) return undefined
  return `\x1b[1m\x1b[35m● SUB-AGENTS ${manager.runningCount}/${manager.maxConcurrent} RUNNING\x1b[0m`
}

export function createRenderScheduler(renderNow: () => void): () => void {
  let scheduled: NodeJS.Immediate | null = null

  return () => {
    if (scheduled) return

    scheduled = setImmediate(() => {
      scheduled = null
      renderNow()
    })
  }
}
