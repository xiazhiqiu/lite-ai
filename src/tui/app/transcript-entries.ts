import type { TranscriptEntry } from '../../ui.js'
import type { ScreenState, TranscriptEntryDraft } from './types.js'
import { setStatus } from './render.js'

export function pushTranscriptEntry(
  state: ScreenState,
  entry: TranscriptEntryDraft,
): number {
  const id = state.nextEntryId++
  state.transcript.push({ id, ...entry })
  return id
}
export function updateToolEntry(
  state: ScreenState,
  entryId: number,
  status: 'running' | 'success' | 'error',
  body: string,
): void {
  const entry = state.transcript.find(
    item => item.id === entryId && item.kind === 'tool',
  )

  if (!entry || entry.kind !== 'tool') {
    return
  }

  entry.status = status
  entry.body = body
  entry.collapsed = false
  entry.collapsedSummary = undefined
  entry.collapsePhase = undefined
}

export function collapseToolEntry(
  state: ScreenState,
  entryId: number,
  summary: string,
): void {
  const entry = state.transcript.find(
    item => item.id === entryId && item.kind === 'tool',
  )
  if (!entry || entry.kind !== 'tool' || entry.status === 'running') {
    return
  }
  entry.collapsePhase = undefined
  entry.collapsed = true
  entry.collapsedSummary = summary
}

export function getRunningToolEntries(state: ScreenState): Array<Extract<TranscriptEntry, { kind: 'tool' }>> {
  return state.transcript.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> =>
      entry.kind === 'tool' && entry.status === 'running',
  )
}

export function finalizeDanglingRunningTools(state: ScreenState): void {
  const runningEntries = getRunningToolEntries(state)
  for (const entry of runningEntries) {
    entry.status = 'error'
    entry.body = `${entry.body}\n\nERROR: Tool did not report a final result before the turn ended. This usually means the command kept running in the background or the tool lifecycle got out of sync.`
    entry.collapsed = false
    entry.collapsedSummary = undefined
    entry.collapsePhase = undefined
    state.recentTools.push({
      name: entry.toolName,
      status: 'error',
    })
  }
  if (runningEntries.length > 0) {
    state.activeTool = null
    setStatus(state, `Previous turn ended with ${runningEntries.length} unfinished tool call(s).`)
  }
}

export function summarizeCollapsedToolBody(output: string): string {
  const line = output
    .split('\n')
    .map(item => item.trim())
    .find(Boolean)
  if (!line) {
    return 'output collapsed'
  }
  if (line.length > 140) {
    return `${line.slice(0, 140)}...`
  }
  return line
}

export function truncateForDisplay(text: string, max = 180): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

export function summarizeToolInput(toolName: string, input: unknown): string {
  if (typeof input === 'string') {
    return truncateForDisplay(input.replace(/\s+/g, ' ').trim())
  }

  if (typeof input === 'object' && input !== null) {
    const maybePath = (input as { path?: unknown }).path
    const pathPart =
      typeof maybePath === 'string' && maybePath.trim()
        ? ` path=${maybePath}`
        : ''

    if (toolName === 'patch_file') {
      const count = Array.isArray((input as { replacements?: unknown }).replacements)
        ? (input as { replacements: unknown[] }).replacements.length
        : 0
      return `patch_file${pathPart} replacements=${count}`
    }

    if (toolName === 'edit_file') {
      return `edit_file${pathPart}`
    }

    if (toolName === 'read_file') {
      const offset = (input as { offset?: unknown }).offset
      const limit = (input as { limit?: unknown }).limit
      return `read_file${pathPart}${offset !== undefined ? ` offset=${String(offset)}` : ''}${limit !== undefined ? ` limit=${String(limit)}` : ''}`
    }

    if (toolName === 'run_command') {
      const command = (input as { command?: unknown }).command
      return `run_command${typeof command === 'string' ? ` ${truncateForDisplay(command, 120)}` : ''}`
    }
  }

  try {
    return truncateForDisplay(JSON.stringify(input))
  } catch {
    return truncateForDisplay(String(input))
  }
}

export function isFileEditTool(toolName: string): boolean {
  return (
    toolName === 'edit_file' ||
    toolName === 'patch_file' ||
    toolName === 'modify_file' ||
    toolName === 'write_file'
  )
}

export function extractPathFromToolInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }
  if (!('path' in input)) {
    return null
  }
  const value = (input as { path?: unknown }).path
  return typeof value === 'string' && value.trim() ? value : null
}
