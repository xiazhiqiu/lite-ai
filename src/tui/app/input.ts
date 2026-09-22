import crypto from 'node:crypto'
import { runAgentTurn } from '../../agent-loop.js'
import { findMatchingSlashCommands, tryHandleLocalCommand } from '../../cli-commands.js'
import { saveHistoryEntries } from '../../history.js'
import { parseLocalToolShortcut } from '../../local-tool-shortcuts.js'
import { PermissionPromptResult, PermissionRequest } from '../../permissions.js'
import { saveSession, loadSession, listSessions, renameSession, appendCompactBoundary, appendSnipBoundary, forkSession } from '../../session.js'
import { computeContextStats } from '../../utils/token-estimator.js'
import { manualCompact } from '../../compact/manual-compact.js'
import { snipCompactConversation } from '../../compact/snipCompact.js'
import { applyContextCollapseIfNeeded, createContextCollapseState } from '../../compact/context-collapse.js'
import type { TtyAppArgs, ScreenState, AggregatedEditProgress } from './types.js'
import { setStatus } from './render.js'
import { pushTranscriptEntry, updateToolEntry, collapseToolEntry, getRunningToolEntries, finalizeDanglingRunningTools, summarizeCollapsedToolBody, summarizeToolInput, isFileEditTool, extractPathFromToolInput } from './transcript-entries.js'
import { startWelcomeEscapeAnimation } from './welcome.js'
import { refreshSystemPrompt, retainedMessagesAfterCompact, persistContextCollapseResult, executeToolShortcut, resumeSession } from './session-ops.js'

export async function handleInput(
  args: TtyAppArgs,
  state: ScreenState,
  rerender: () => void,
  submittedRawInput?: string,
): Promise<boolean> {
  if (state.isBusy) {
    setStatus(
      state,
      state.activeTool
        ? `Running ${state.activeTool}...`
        : 'Current turn is still running...',
    )
    return false
  }

  const input = (submittedRawInput ?? state.input).trim()
  if (!input) return false
  if (input === '/exit') return true

  // /collapse: persistent model-visible projection; original transcript remains intact
  if (input === '/collapse') {
    const model = args.runtime?.model ?? ''
    if (!model) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'No model configured. Cannot collapse context.',
      })
      return false
    }

    state.isBusy = true
    setStatus(state, 'Collapsing context...')
    state.compressionStatus = 'collapsing...'
    rerender()
    try {
      const result = await applyContextCollapseIfNeeded(
        args.messages,
        model,
        args.model,
        args.contextCollapseState ?? createContextCollapseState(),
        {
          utilizationThreshold: 0,
          reason: 'manual',
        },
      )
      args.contextCollapseState = result.state
      state.contextStats = computeContextStats(result.messages, model)

      if (result.collapsed) {
        const savedTokens = await persistContextCollapseResult(args, result)
        const spanCount = result.spans.length
        state.compressionStatus = `collapse saved ~${Math.round(savedTokens)} tokens`
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Context collapse projected ${spanCount} span${spanCount === 1 ? '' : 's'} into model-visible summaries. Original transcript is preserved.`,
        })
      } else {
        state.compressionStatus = result.state.enabled ? 'nothing safe to collapse' : 'collapse disabled'
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: result.state.enabled
            ? 'Nothing safe to collapse.'
            : 'Context collapse is disabled after repeated summary failures.',
        })
      }
    } catch (error) {
      state.compressionStatus = null
      const message = error instanceof Error ? error.message : String(error)
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Context collapse failed: ${message}`,
      })
    } finally {
      state.isBusy = false
      setStatus(state, null)
      state.transcriptScrollOffset = 0
      setTimeout(() => {
        state.compressionStatus = null
        rerender()
      }, 5000)
    }
    return false
  }

  // /snip: deterministic middle-context removal without calling the model
  if (input === '/snip') {
    const model = args.runtime?.model ?? ''
    const stats = computeContextStats(args.messages, model)
    const result = await snipCompactConversation({
      messages: args.messages,
      contextStats: stats,
      modelContextWindow: stats.effectiveInput,
    })

    if (!result.didSnip || result.boundaryMessage?.role !== 'snip_boundary') {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'Nothing safe to snip.',
      })
      return false
    }

    await appendSnipBoundary(args.cwd, args.sessionId, result.boundaryMessage)
    args.messages.length = 0
    args.messages.push(...result.messages)
    args.alreadySavedCount = 0
    args.contextCollapseState = createContextCollapseState()
    state.contextStats = computeContextStats(args.messages, model)
    state.compressionStatus = `snip saved ~${Math.round(result.tokensFreed)} tokens`
    state.transcriptScrollOffset = 0
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: `Snipped earlier context: removed ${result.removedMessageIds.length} messages, freed ~${Math.round(result.tokensFreed)} tokens.`,
    })
    setTimeout(() => {
      state.compressionStatus = null
      rerender()
    }, 5000)
    return false
  }

  // /compact: manual context compression
  if (input === '/compact') {
    if (args.messages.length <= 2) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'Not enough conversation to compress.',
      })
      return false
    }
    const model = args.runtime?.model ?? ''
    if (!model) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'No model configured. Cannot compress.',
      })
      return false
    }
    state.isBusy = true
    setStatus(state, 'Compressing context...')
    state.compressionStatus = 'compressing...'
    rerender()
    try {
      const result = await manualCompact(args.messages, args.model, args.cwd)
      if (result) {
        const summaryText = typeof result.summary.content === 'string' ? result.summary.content : ''
        await appendCompactBoundary(
          args.cwd,
          args.sessionId,
          summaryText,
          'manual',
          result.tokensBefore,
          result.tokensAfter,
          retainedMessagesAfterCompact(result),
        )
        args.messages.length = 0
        args.messages.push(...result.messages)
        args.alreadySavedCount = args.messages.length - 1
        args.contextCollapseState = createContextCollapseState()
        const savedPct = Math.round((1 - result.tokensAfter / result.tokensBefore) * 100)
        const savedTokens = result.tokensBefore - result.tokensAfter
        state.compressionStatus = `ctx -${savedPct}% (saved ${savedTokens >= 1000 ? `${Math.round(savedTokens / 1000)}K` : savedTokens} tokens)`
        state.contextStats = computeContextStats(args.messages, model)
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Context compressed: ${result.removedCount} messages summarized. ${savedPct}% reduction (${savedTokens >= 1000 ? `${Math.round(savedTokens / 1000)}K` : savedTokens} tokens saved).`,
        })
      } else {
        state.compressionStatus = 'compression failed'
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: 'Could not compress further. The conversation may already be minimal.',
        })
      }
    } catch (error) {
      state.compressionStatus = null
      const message = error instanceof Error ? error.message : String(error)
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Compression failed: ${message}`,
      })
    } finally {
      state.isBusy = false
      setStatus(state, null)
      state.transcriptScrollOffset = 0
      // Clear compression status after a delay (will be reset on next render cycle)
      setTimeout(() => {
        state.compressionStatus = null
        rerender()
      }, 5000)
    }
    return false
  }

  if (input.startsWith('/rename ')) {
    const newName = input.slice('/rename '.length).trim()
    if (!newName) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'Usage: /rename <name>',
      })
      return false
    }
    const ok = await renameSession(args.cwd, args.sessionId, newName)
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: ok ? `Session renamed to "${newName}".` : 'No active session to rename.',
    })
    return false
  }

  if (input === '/resume' || input.startsWith('/resume ')) {
    const sessionIdArg = input.startsWith('/resume ') ? input.slice('/resume '.length).trim() : ''

    if (!sessionIdArg) {
      const sessions = await listSessions(args.cwd)
      if (sessions.length === 0) {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: 'No saved sessions for this project.',
        })
        return false
      }

      const selectedId = await new Promise<string | null>(resolve => {
        state.sessionPicker = {
          sessions,
          selectedIndex: 0,
          resolve,
          deleteConfirmIndex: null,
          allProjects: false,
          projects: [],
          projectSelectedIndex: 0,
        }
        setStatus(state, 'Select a session to resume')
        rerender()
      })

      state.sessionPicker = null
      setStatus(state, null)
      rerender()

      if (!selectedId) return false

      const loaded = await loadSession(args.cwd, selectedId)
      if (!loaded || loaded.length === 0) {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Session ${selectedId} not found.`,
        })
        return false
      }
      await resumeSession(args, state, selectedId, loaded)
      return false
    }

    // Direct resume by id
    const loaded = await loadSession(args.cwd, sessionIdArg)
    if (!loaded || loaded.length === 0) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Session ${sessionIdArg} not found.`,
      })
      return false
    }
    await resumeSession(args, state, sessionIdArg, loaded)
    return false
  }

  if (input === '/new') {
    args.sessionId = crypto.randomUUID().slice(0, 8)
    args.alreadySavedCount = 0
    args.contextCollapseState = createContextCollapseState()
    state.transcript = []
    args.messages.length = 0
    await refreshSystemPrompt(args)
    state.transcriptScrollOffset = 0
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: 'Session cleared. Starting fresh.',
    })
    return false
  }

  if (input === '/fork') {
    const newId = await forkSession(args.cwd, args.sessionId)
    if (!newId) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'No current session to fork.',
      })
      return false
    }
    args.sessionId = newId
    args.alreadySavedCount = args.messages.length - 1
    args.contextCollapseState = createContextCollapseState()
    state.transcriptScrollOffset = 0
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: `Session forked. Now in session ${newId}. Original session preserved.`,
    })
    return false
  }

  if (state.history.at(-1) !== input) {
    state.history.push(input)
    await saveHistoryEntries(state.history, args.cwd, args.sessionId)
  }
  state.historyIndex = state.history.length
  state.historyDraft = ''

  if (input === '/tools') {
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: args.tools
        .list()
        .map(tool => `${tool.name}: ${tool.description}`)
        .join('\n'),
    })
    return false
  }

  const localCommandResult = await tryHandleLocalCommand(input, {
    cwd: args.cwd,
    tools: args.tools,
    permissionSummary: args.permissions.getSummary(),
  })
  if (localCommandResult !== null) {
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: localCommandResult,
    })
    return false
  }

  const toolShortcut = parseLocalToolShortcut(input)
  if (toolShortcut) {
    await executeToolShortcut(
      args,
      state,
      toolShortcut.toolName,
      toolShortcut.input,
      rerender,
    )
    return false
  }

  if (input.startsWith('/')) {
    const matches = findMatchingSlashCommands(input)
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body:
        matches.length > 0
          ? `未识别命令。你是不是想输入：\n${matches.join('\n')}`
          : '未识别命令。输入 /help 查看可用命令。',
    })
    return false
  }

  await refreshSystemPrompt(args)
  args.messages.push({ role: 'user', content: input })
  pushTranscriptEntry(state, {
    kind: 'user',
    body: input,
  })
  state.transcriptScrollOffset = 0
  startWelcomeEscapeAnimation(state)
  setStatus(state, 'Thinking...')
  state.isBusy = true
  rerender()

  const pendingToolEntries = new Map<string, number>()
  const aggregatedEditByKey = new Map<string, AggregatedEditProgress>()
  const aggregatedEditByEntryId = new Map<number, AggregatedEditProgress>()
  const turnStartedAt = Date.now()

  args.permissions.beginTurn()
  try {
    const nextMessages = await runAgentTurn({
      model: args.model,
      tools: args.tools,
      messages: args.messages,
      cwd: args.cwd,
      permissions: args.permissions,
      modelName: args.runtime?.model ?? '',
      contentReplacementState: args.contentReplacementState,
      contextCollapseState: args.contextCollapseState,
      onContextStats(stats) {
        state.contextStats = stats
        rerender()
      },
      async onAutoCompact(result) {
        const savedPct = Math.round((1 - result.tokensAfter / result.tokensBefore) * 100)
        const savedTokens = result.tokensBefore - result.tokensAfter
        state.compressionStatus = `ctx -${savedPct}% (saved ${savedTokens >= 1000 ? `${Math.round(savedTokens / 1000)}K` : savedTokens} tokens)`
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Context auto-compressed: ${result.removedCount} messages summarized.`,
        })
        const summaryText = typeof result.summary.content === 'string' ? result.summary.content : ''
        await appendCompactBoundary(
          args.cwd,
          args.sessionId,
          summaryText,
          'auto',
          result.tokensBefore,
          result.tokensAfter,
          retainedMessagesAfterCompact(result),
        )
        args.alreadySavedCount = result.messages.length - 1
        state.transcriptScrollOffset = 0
        setTimeout(() => {
          state.compressionStatus = null
          rerender()
        }, 5000)
      },
      async onContextCollapse(result) {
        if (result.collapsed) {
          const savedTokens = await persistContextCollapseResult(args, result)
          state.compressionStatus = `collapse saved ~${Math.round(savedTokens)} tokens`
          rerender()
          setTimeout(() => {
            state.compressionStatus = null
            rerender()
          }, 5000)
        }
      },
      async onSnipCompact(result) {
        if (result.boundaryMessage?.role === 'snip_boundary') {
          await appendSnipBoundary(args.cwd, args.sessionId, result.boundaryMessage)
        }
        args.alreadySavedCount = 0
        state.compressionStatus = `snip saved ~${Math.round(result.tokensFreed)} tokens`
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Snipped earlier context: removed ${result.removedMessageIds.length} messages, freed ~${Math.round(result.tokensFreed)} tokens.`,
        })
        state.transcriptScrollOffset = 0
        setTimeout(() => {
          state.compressionStatus = null
          rerender()
        }, 5000)
      },
      onAssistantMessage(content, metadata) {
        const workedForSeconds = metadata?.final
          ? Math.max(0, Math.floor((Date.now() - turnStartedAt) / 1000))
          : undefined
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: content,
          ...(workedForSeconds === undefined ? {} : { workedForSeconds }),
        })
        state.transcriptScrollOffset = 0
        rerender()
      },
      onProgressMessage(content) {
        pushTranscriptEntry(state, {
          kind: 'progress',
          body: content,
        })
        state.transcriptScrollOffset = 0
        rerender()
      },
      onToolStart(toolUseId, toolName, toolInput) {
        setStatus(state, `Running ${toolName}...`)
        state.activeTool = toolName
        let entryId: number
        const targetPath = extractPathFromToolInput(toolInput)
        const canAggregate = isFileEditTool(toolName) && targetPath !== null

        if (canAggregate) {
          const key = `${toolName}:${targetPath}`
          const existing = aggregatedEditByKey.get(key)
          if (existing) {
            existing.total += 1
            existing.lastOutput = summarizeToolInput(toolName, toolInput)
            entryId = existing.entryId
            updateToolEntry(
              state,
              entryId,
              existing.errors > 0 ? 'error' : 'running',
              `Aggregated ${toolName} for ${targetPath}\nCompleted: ${existing.completed}/${existing.total}`,
            )
          } else {
            entryId = pushTranscriptEntry(state, {
              kind: 'tool',
              toolName,
              status: 'running',
              body: summarizeToolInput(toolName, toolInput),
            })
            const progress: AggregatedEditProgress = {
              entryId,
              toolName,
              path: targetPath,
              total: 1,
              completed: 0,
              errors: 0,
              lastOutput: summarizeToolInput(toolName, toolInput),
            }
            aggregatedEditByKey.set(key, progress)
            aggregatedEditByEntryId.set(entryId, progress)
          }
        } else {
          entryId = pushTranscriptEntry(state, {
            kind: 'tool',
            toolName,
            status: 'running',
            body: summarizeToolInput(toolName, toolInput),
          })
        }
        const pending = pendingToolEntries.get(toolUseId)
        if (pending === undefined) {
          pendingToolEntries.set(toolUseId, entryId)
        }
        state.transcriptScrollOffset = 0
        rerender()
      },
      onToolResult(toolUseId, toolName, output, isError) {
        const entryId = pendingToolEntries.get(toolUseId)
        pendingToolEntries.delete(toolUseId)
        if (entryId !== undefined) {
          const aggregated = aggregatedEditByEntryId.get(entryId)
          if (aggregated && aggregated.toolName === toolName) {
            aggregated.completed += 1
            if (isError) {
              aggregated.errors += 1
            }
            aggregated.lastOutput = output
            const done = aggregated.completed >= aggregated.total
            if (done) {
              state.recentTools.push({
                name: `${toolName} x${aggregated.total}`,
                status: aggregated.errors > 0 ? 'error' : 'success',
              })
            }
            const aggregatedBody = done
              ? [
                  `Aggregated ${toolName} for ${aggregated.path}`,
                  `Operations: ${aggregated.total}, errors: ${aggregated.errors}`,
                  `Last result: ${aggregated.lastOutput}`,
                ].join('\n')
              : `Aggregated ${toolName} for ${aggregated.path}\nCompleted: ${aggregated.completed}/${aggregated.total}`
            updateToolEntry(
              state,
              entryId,
              aggregated.errors > 0 ? 'error' : done ? 'success' : 'running',
              aggregatedBody,
            )
            if (done) {
              collapseToolEntry(
                state,
                entryId,
                summarizeCollapsedToolBody(aggregatedBody),
              )
              aggregatedEditByEntryId.delete(entryId)
              aggregatedEditByKey.delete(`${toolName}:${aggregated.path}`)
            }
          } else {
            state.recentTools.push({
              name: toolName,
              status: isError ? 'error' : 'success',
            })
            updateToolEntry(
              state,
              entryId,
              isError ? 'error' : 'success',
              isError ? `ERROR: ${output}` : output,
            )
            collapseToolEntry(
              state,
              entryId,
              summarizeCollapsedToolBody(
                isError ? `ERROR: ${output}` : output,
              ),
            )
          }
        } else {
          state.recentTools.push({
            name: toolName,
            status: isError ? 'error' : 'success',
          })
        }
        state.activeTool = null
        setStatus(state, 'Thinking...')
        rerender()
      },
    })
    args.messages.length = 0
    args.messages.push(...nextMessages)
    await saveSession(args.cwd, args.sessionId, args.messages, args.alreadySavedCount)
    args.alreadySavedCount = args.messages.length - 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    args.messages.push({
      role: 'assistant',
      content: `请求失败: ${message}`,
    })
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: `请求失败: ${message}`,
    })
    state.transcriptScrollOffset = 0
  } finally {
    args.permissions.endTurn()
    state.isBusy = false
  }

  finalizeDanglingRunningTools(state)
  if (getRunningToolEntries(state).length === 0) {
    setStatus(state, null)
  }
  return false
}

export function createPermissionPromptHandler(
  state: ScreenState,
  rerender: () => void,
): (request: PermissionRequest) => Promise<PermissionPromptResult> {
  return request =>
    new Promise(resolve => {
      state.pendingApproval = {
        request,
        resolve,
        detailsExpanded: false,
        detailsScrollOffset: 0,
        selectedChoiceIndex: 0,
        feedbackMode: false,
        feedbackInput: '',
      }
      setStatus(state, 'Waiting for approval...')
      rerender()
    })
}
