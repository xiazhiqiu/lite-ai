import process from 'node:process'
import { killBackgroundShellTasks } from '../../background-tasks.js'
import { loadHistoryEntries } from '../../history.js'
import { PermissionManager } from '../../permissions.js'
import { discoverInstructionFiles } from '../../memory.js'
import { clearSession, listSessions, cleanupExpiredSessions, listAllProjects } from '../../session.js'
import { parseInputChunk, type ParsedInputEvent } from '../../tui/input-parser.js'
import { enterAlternateScreen, exitAlternateScreen, hideCursor, showCursor, extractSelectedText } from '../../ui.js'
import { createContextCollapseState } from '../../compact/context-collapse.js'
import { createContentReplacementState } from '../../utils/tool-result-storage.js'
import type { TtyAppArgs, ScreenState } from './types.js'
import { copyToClipboard } from './clipboard.js'
import { keepSelectionAfterMouseRelease, setStatus, screenToAbsoluteLineIndex, scrollTranscriptBy, jumpTranscriptToEdge, scrollPendingApprovalBy, togglePendingApprovalExpand, movePendingApprovalSelection, historyUp, historyDown, getVisibleCommands, renderScreen, createRenderScheduler } from './render.js'
import { pushTranscriptEntry } from './transcript-entries.js'
import { pushWelcomeAnimation, advanceWelcomeAnimation } from './welcome.js'
import { refreshSystemPrompt } from './session-ops.js'
import { handleInput, createPermissionPromptHandler } from './input.js'

export async function runTtyApp(args: TtyAppArgs): Promise<void> {
  enterAlternateScreen()
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  hideCursor()

  const state: ScreenState = {
    input: '',
    cursorOffset: 0,
    transcript: [],
    transcriptScrollOffset: 0,
    selectedSlashIndex: 0,
    status: null,
    activeTool: null,
    recentTools: [],
    history: await loadHistoryEntries(),
    historyIndex: 0,
    historyDraft: '',
    nextEntryId: 1,
    pendingApproval: null,
    sessionPicker: null,
    isBusy: false,
    contextStats: null,
    compressionStatus: null,
    statusAnimationFrame: 0,
    inputHintFrame: 0,
    thinkingStartedAt: null,
    selection: null,
    mouseDown: null,
    transcriptBodyStartY: 0,
    transcriptBodyLines: 20,
    welcomeAnimation: null,
  }
  state.historyIndex = state.history.length

  const permissionArgs: TtyAppArgs = {
    ...args,
    contentReplacementState:
      args.contentReplacementState ?? createContentReplacementState(),
    contextCollapseState:
      args.contextCollapseState ?? createContextCollapseState(),
    permissions: new PermissionManager(
      args.cwd,
      createPermissionPromptHandler(state, () => scheduleRender()),
    ),
  }
  const renderNow = () => renderScreen(permissionArgs, state)
  let scheduleRender = renderNow
  scheduleRender = createRenderScheduler(renderNow)
  const unsubscribeSubAgents = permissionArgs.subAgents.subscribe(scheduleRender)
  await permissionArgs.permissions.whenReady()
  if (
    permissionArgs.messages.length === 0 ||
    permissionArgs.messages[0]?.role !== 'system'
  ) {
    await refreshSystemPrompt(permissionArgs)
  }

  pushWelcomeAnimation(state)

  // Show loaded instruction files at startup
  const memoryFiles = await discoverInstructionFiles(args.cwd)
  if (memoryFiles.length > 0) {
    const lines = [
      `Memory: ${memoryFiles.length} instruction file(s) loaded`,
      ...memoryFiles.map((f, i) => {
        const lineCount = f.content.split('\n').length
        const preview = f.content.trim().split('\n')[0] || '<empty>'
        return `  ${i + 1}. ${f.path}\n     lines=${lineCount} preview=${preview}`
      }),
    ]
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: lines.join('\n'),
    })
  }

  let deferredResumeInput: string | null = null
  if (permissionArgs.resumeTarget) {
    if (permissionArgs.resumeTarget === 'picker') {
      deferredResumeInput = '/resume'
    } else {
      await handleInput(
        permissionArgs,
        state,
        scheduleRender,
        `/resume ${permissionArgs.resumeTarget}`,
      )
    }
  } else {
    const expired = await cleanupExpiredSessions(args.cwd, 30 * 24 * 60 * 60 * 1000)
    if (expired > 0) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Cleaned up ${expired} expired session(s) (>30 days old).`,
      })
    }
    const sessions = await listSessions(args.cwd)
    if (sessions.length > 0) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Found ${sessions.length} saved session(s). Type /resume to continue one.`,
      })
    }
  }

  renderNow()

  await new Promise<void>(resolve => {
    let finished = false
    let inputRemainder = ''
    let eventChain = Promise.resolve()
    let submitInFlight = false
    const statusAnimationTimer = setInterval(() => {
      state.statusAnimationFrame = (state.statusAnimationFrame + 1) % 3
      scheduleRender()
    }, 1000)
    const welcomeAnimationTimer = setInterval(() => {
      if (advanceWelcomeAnimation(state)) {
        scheduleRender()
      }
    }, 200)
    const inputHintTimer = setInterval(() => {
      state.inputHintFrame = (state.inputHintFrame + 1) % 2
      if (!state.input) {
        scheduleRender()
      }
    }, 3000)

    const cleanup = () => {
      clearInterval(statusAnimationTimer)
      clearInterval(welcomeAnimationTimer)
      clearInterval(inputHintTimer)
      unsubscribeSubAgents()
      // 清理仍在运行的后台任务，避免退出后留下孤儿进程
      killBackgroundShellTasks()
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('close', onClose)
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      showCursor()
      exitAlternateScreen()
      process.stdin.pause()
      process.stdout.write(`Session ${permissionArgs.sessionId} saved. To resume: lite-ai --resume ${permissionArgs.sessionId}\n`)
    }

    const finish = () => {
      if (finished) return
      finished = true
      cleanup()
      resolve()
    }

    const handleEvent = async (event: ParsedInputEvent) => {
      try {
        if (state.pendingApproval) {
          if (event.kind === 'text' && event.ctrl && event.text === 'o') {
            if (togglePendingApprovalExpand(state)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'text' && event.ctrl && event.text === 'c') {
            finish()
            return
          }

          if (event.kind === 'wheel') {
            if (
              event.direction === 'up'
                ? scrollPendingApprovalBy(state, -3)
                : scrollPendingApprovalBy(state, 3)
            ) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'pageup') {
            if (scrollPendingApprovalBy(state, -8)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'pagedown') {
            if (scrollPendingApprovalBy(state, 8)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'up' && event.meta) {
            if (scrollPendingApprovalBy(state, -1)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'down' && event.meta) {
            if (scrollPendingApprovalBy(state, 1)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'up' && !event.meta) {
            if (movePendingApprovalSelection(state, -1)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'down' && !event.meta) {
            if (movePendingApprovalSelection(state, 1)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'backspace') {
            const pending = state.pendingApproval
            if (pending.feedbackMode && pending.feedbackInput.length > 0) {
              pending.feedbackInput = pending.feedbackInput.slice(0, -1)
              scheduleRender()
            }
            return
          }

          if (event.kind === 'text' && !event.ctrl && !event.meta) {
            const pending = state.pendingApproval
            if (!pending.feedbackMode) {
              const pressed = event.text.trim().toLowerCase()
              const matched = pending.request.choices.find(
                choice => choice.key.toLowerCase() === pressed,
              )
              if (matched) {
                if (matched.decision === 'deny_with_feedback') {
                  pending.feedbackMode = true
                  pending.feedbackInput = ''
                  scheduleRender()
                  return
                }

                state.pendingApproval = null
                setStatus(state, null)
                pending.resolve({ decision: matched.decision })
                scheduleRender()
                return
              }
            }

            if (pending.feedbackMode) {
              pending.feedbackInput += event.text
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'return') {
            const pending = state.pendingApproval
            if (pending.feedbackMode) {
              const feedback = pending.feedbackInput.trim()
              state.pendingApproval = null
              setStatus(state, null)
              pending.resolve({
                decision: 'deny_with_feedback',
                feedback,
              })
              scheduleRender()
              return
            }

            const selected =
              pending.request.choices[
                Math.min(
                  pending.selectedChoiceIndex,
                  pending.request.choices.length - 1,
                )
              ]
            if (!selected) {
              return
            }

            if (selected.decision === 'deny_with_feedback') {
              pending.feedbackMode = true
              pending.feedbackInput = ''
              scheduleRender()
              return
            }

            state.pendingApproval = null
            setStatus(state, null)
            pending.resolve({ decision: selected.decision })
            scheduleRender()
            return
          }

          if (event.kind === 'key' && event.name === 'escape') {
            const pending = state.pendingApproval
            if (pending.feedbackMode) {
              pending.feedbackMode = false
              pending.feedbackInput = ''
              scheduleRender()
              return
            }

            state.pendingApproval = null
            setStatus(state, null)
            pending.resolve({ decision: 'deny_once' })
            scheduleRender()
            return
          }

          return
        }

        if (state.sessionPicker) {
          if (event.kind === 'text' && event.ctrl && event.text === 'c') {
            state.sessionPicker.resolve(null)
            state.sessionPicker = null
            setStatus(state, null)
            scheduleRender()
            return
          }

          // All-projects view
          if (state.sessionPicker.allProjects) {
            if (event.kind === 'key' && event.name === 'up') {
              if (state.sessionPicker.projectSelectedIndex > 0) {
                state.sessionPicker.projectSelectedIndex -= 1
                scheduleRender()
              }
              return
            }

            if (event.kind === 'key' && event.name === 'down') {
              if (state.sessionPicker.projectSelectedIndex < state.sessionPicker.projects.length - 1) {
                state.sessionPicker.projectSelectedIndex += 1
                scheduleRender()
              }
              return
            }

            if (event.kind === 'key' && event.name === 'return') {
              const proj = state.sessionPicker.projects[state.sessionPicker.projectSelectedIndex]
              if (proj && proj.sessionCount > 0) {
                state.sessionPicker = null
                setStatus(state, null)
                pushTranscriptEntry(state, {
                  kind: 'assistant',
                  body: `Project "${proj.dir}" has ${proj.sessionCount} session(s). Switch to it by exiting and running:\n\n  cd <project-path> && lite-ai --resume`,
                })
                scheduleRender()
              }
              return
            }

            if ((event.kind === 'key' && event.name === 'tab') || (event.kind === 'key' && event.name === 'escape')) {
              state.sessionPicker.allProjects = false
              scheduleRender()
              return
            }

            return
          }

          // Session list view
          if (event.kind === 'key' && event.name === 'up') {
            const picker = state.sessionPicker
            if (picker.selectedIndex > 0) {
              picker.selectedIndex -= 1
              picker.deleteConfirmIndex = null
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'down') {
            const picker = state.sessionPicker
            if (picker.selectedIndex < picker.sessions.length - 1) {
              picker.selectedIndex += 1
              picker.deleteConfirmIndex = null
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'return') {
            const picker = state.sessionPicker
            const selected = picker.sessions[picker.selectedIndex]
            const id = selected?.id ?? null
            state.sessionPicker = null
            setStatus(state, null)
            picker.resolve(id)
            scheduleRender()
            return
          }

          // 'd' to delete — first press marks, second press confirms
          if (event.kind === 'text' && !event.ctrl && !event.meta && event.text === 'd') {
            const picker = state.sessionPicker
            if (picker.deleteConfirmIndex === picker.selectedIndex) {
              // Second press — confirm delete
              const target = picker.sessions[picker.selectedIndex]
              if (target) {
                await clearSession(args.cwd, target.id)
                const sessions = await listSessions(args.cwd)
                if (sessions.length === 0) {
                  state.sessionPicker.resolve(null)
                  state.sessionPicker = null
                  setStatus(state, null)
                  scheduleRender()
                  return
                }
                picker.sessions = sessions
                picker.selectedIndex = Math.min(picker.selectedIndex, sessions.length - 1)
                picker.deleteConfirmIndex = null
              }
            } else {
              picker.deleteConfirmIndex = picker.selectedIndex
            }
            scheduleRender()
            return
          }

          // Tab — switch to all-projects view
          if (event.kind === 'key' && event.name === 'tab') {
            state.sessionPicker.allProjects = true
            state.sessionPicker.projects = await listAllProjects()
            state.sessionPicker.projectSelectedIndex = 0
            scheduleRender()
            return
          }

          if (event.kind === 'key' && event.name === 'escape') {
            state.sessionPicker.resolve(null)
            state.sessionPicker = null
            setStatus(state, null)
            scheduleRender()
            return
          }

          return
        }

        const visibleCommands = getVisibleCommands(state.input)

        if (event.kind === 'text' && event.ctrl && event.text === 'c') {
          finish()
          return
        }

        if (event.kind === 'wheel') {
          if (
              event.direction === 'up'
              ? scrollTranscriptBy(permissionArgs, state, 3)
              : scrollTranscriptBy(permissionArgs, state, -3)
          ) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'mouse') {
          const screenX = event.x + 1
          const screenY = event.y + 1
          const lineIndex = screenToAbsoluteLineIndex(permissionArgs, state, screenY)
          if (lineIndex < 0) {
            state.mouseDown = null
            state.selection = null
            return
          }
          const col = Math.max(0, screenX - 3)  // panel border (2) + content starts after left padding space

          if (event.action === 'press' && event.button === 'left') {
            state.mouseDown = { x: col, y: lineIndex }
            state.selection = null
            scheduleRender()
            return
          }

          if (event.action === 'drag' && event.button === 'left' && state.mouseDown) {
            const startLine = Math.min(state.mouseDown.y, lineIndex)
            const endLine = Math.max(state.mouseDown.y, lineIndex)
            const startCol =
              startLine === state.mouseDown.y
                ? Math.min(state.mouseDown.x, col)
                : state.mouseDown.y < lineIndex
                  ? state.mouseDown.x
                  : col
            const endCol =
              endLine === state.mouseDown.y
                ? Math.max(state.mouseDown.x, col)
                : state.mouseDown.y > lineIndex
                  ? state.mouseDown.x
                  : col

            state.selection = {
              startLine,
              startCol,
              endLine,
              endCol,
            }
            scheduleRender()
            return
          }

          if (event.action === 'release' && state.mouseDown) {
            if (state.selection) {
              const text = extractSelectedText(state.transcript, state.selection)
              if (text) {
                copyToClipboard(text)
              }
            }
            state.mouseDown = null
            state.selection = keepSelectionAfterMouseRelease(state.selection)
            scheduleRender()
            return
          }

          return
        }


        if (event.kind === 'key' && event.name === 'return') {
          if (state.isBusy) {
            setStatus(
              state,
              state.activeTool
                ? `Running ${state.activeTool}...`
                : 'Current turn is still running...',
            )
            scheduleRender()
            return
          }

          if (visibleCommands.length > 0) {
            const selected =
              visibleCommands[
                Math.min(state.selectedSlashIndex, visibleCommands.length - 1)
              ]
            if (selected && state.input.trim() !== selected.usage) {
              state.input = selected.usage
              state.cursorOffset = state.input.length
              state.selectedSlashIndex = 0
              scheduleRender()
              return
            }
          }

          const submittedInput = state.input
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          scheduleRender()
          if (submitInFlight) {
            return
          }
          submitInFlight = true
          void (async () => {
            try {
              const shouldExit = await handleInput(
                permissionArgs,
                state,
                scheduleRender,
                submittedInput,
              )
              if (shouldExit) {
                finish()
                return
              }
              scheduleRender()
            } catch (error) {
              pushTranscriptEntry(state, {
                kind: 'assistant',
                body: error instanceof Error ? error.message : String(error),
              })
              state.input = ''
              state.cursorOffset = 0
              state.selectedSlashIndex = 0
              setStatus(state, null)
              scheduleRender()
            } finally {
              submitInFlight = false
            }
          })()
          return
        }

        if (event.kind === 'key' && event.name === 'backspace') {
          if (state.cursorOffset > 0) {
            state.input =
              state.input.slice(0, state.cursorOffset - 1) +
              state.input.slice(state.cursorOffset)
            state.cursorOffset -= 1
          }
          state.selectedSlashIndex = 0
          scheduleRender()
          return
        }

        if (event.kind === 'key' && event.name === 'delete') {
          state.input =
            state.input.slice(0, state.cursorOffset) +
            state.input.slice(state.cursorOffset + 1)
          state.selectedSlashIndex = 0
          scheduleRender()
          return
        }

        if (event.kind === 'key' && event.name === 'tab') {
          if (visibleCommands.length > 0) {
            const selected =
              visibleCommands[
                Math.min(state.selectedSlashIndex, visibleCommands.length - 1)
              ]
            if (selected) {
              state.input = selected.usage
              state.cursorOffset = state.input.length
              state.selectedSlashIndex = 0
              scheduleRender()
            }
          }
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'p') {
          if (historyUp(state)) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'n') {
          if (historyDown(state)) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'key' && event.name === 'up') {
          if (visibleCommands.length > 0) {
            state.selectedSlashIndex =
              (state.selectedSlashIndex - 1 + visibleCommands.length) %
              visibleCommands.length
            scheduleRender()
          } else if (event.meta) {
            if (scrollTranscriptBy(permissionArgs, state, 1)) {
              scheduleRender()
            }
          } else if (historyUp(state)) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'key' && event.name === 'down') {
          if (visibleCommands.length > 0) {
            state.selectedSlashIndex =
              (state.selectedSlashIndex + 1) % visibleCommands.length
              scheduleRender()
          } else if (event.meta) {
            if (scrollTranscriptBy(permissionArgs, state, -1)) {
              scheduleRender()
            }
          } else if (historyDown(state)) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'key' && event.name === 'pageup') {
          if (scrollTranscriptBy(permissionArgs, state, 8)) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'key' && event.name === 'pagedown') {
          if (scrollTranscriptBy(permissionArgs, state, -8)) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'key' && event.name === 'left') {
          state.cursorOffset = Math.max(0, state.cursorOffset - 1)
          scheduleRender()
          return
        }

        if (event.kind === 'key' && event.name === 'right') {
          state.cursorOffset = Math.min(state.input.length, state.cursorOffset + 1)
          scheduleRender()
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'u') {
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          scheduleRender()
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'a') {
          if (!state.input) {
            if (jumpTranscriptToEdge(permissionArgs, state, 'top')) {
              scheduleRender()
            }
            return
          }

          state.cursorOffset = 0
          scheduleRender()
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'e') {
          if (!state.input) {
            if (jumpTranscriptToEdge(permissionArgs, state, 'bottom')) {
              scheduleRender()
            }
            return
          }

          state.cursorOffset = state.input.length
          scheduleRender()
          return
        }

        if (event.kind === 'key' && event.name === 'escape') {
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          scheduleRender()
          return
        }

        if (event.kind === 'text' && !event.ctrl) {
          state.input =
            state.input.slice(0, state.cursorOffset) +
            event.text +
            state.input.slice(state.cursorOffset)
          state.cursorOffset += event.text.length
          state.selectedSlashIndex = 0
          state.historyIndex = state.history.length
          scheduleRender()
        }
      } catch (error) {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: error instanceof Error ? error.message : String(error),
        })
        state.input = ''
        state.cursorOffset = 0
        state.selectedSlashIndex = 0
        setStatus(state, null)
        scheduleRender()
      }
    }

    const onData = (chunk: Buffer | string) => {
      const parsed = parseInputChunk(inputRemainder, chunk)
      inputRemainder = parsed.rest
      eventChain = eventChain.then(async () => {
        for (const event of parsed.events) {
          await handleEvent(event)
        }
      }).catch(error => {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: error instanceof Error ? error.message : String(error),
        })
        state.input = ''
        state.cursorOffset = 0
        state.selectedSlashIndex = 0
        setStatus(state, null)
        scheduleRender()
      })
    }

    const onEnd = () => finish()
    const onClose = () => finish()
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('close', onClose)

    // Handle deferred --resume (picker mode)
    if (deferredResumeInput) {
      const input = deferredResumeInput
      deferredResumeInput = null
      submitInFlight = true
      void (async () => {
        try {
          const shouldExit = await handleInput(
            permissionArgs,
            state,
            scheduleRender,
            input,
          )
          if (shouldExit) {
            finish()
            return
          }
          scheduleRender()
        } catch (error) {
          pushTranscriptEntry(state, {
            kind: 'assistant',
            body: error instanceof Error ? error.message : String(error),
          })
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          setStatus(state, null)
          scheduleRender()
        } finally {
          submitInFlight = false
        }
      })()
    }
  })
}
