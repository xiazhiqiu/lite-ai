import { PermissionManager, PermissionPromptResult, PermissionRequest } from '../../permissions.js'
import type { SessionMeta, ProjectMeta } from '../../session.js'
import type { TranscriptEntry, TranscriptSelection } from '../../ui.js'
import type { RuntimeConfig } from '../../config.js'
import type { ToolRegistry } from '../../tool.js'
import type { ChatMessage, ModelAdapter } from '../../types.js'
import type { ContextStats } from '../../utils/token-estimator.js'
import type { SubAgentManager } from '../../agents/manager.js'
import type { ContextCollapseState } from '../../compact/context-collapse.js'
import type { ContentReplacementState } from '../../utils/tool-result-storage.js'

export type TtyAppArgs = {
  runtime: RuntimeConfig | null
  tools: ToolRegistry
  model: ModelAdapter
  subAgents: SubAgentManager
  messages: ChatMessage[]
  cwd: string
  permissions: PermissionManager
  contentReplacementState?: ContentReplacementState
  contextCollapseState?: ContextCollapseState
  sessionId: string
  alreadySavedCount: number
  resumeTarget?: string | 'picker'
}

export type PendingApproval = {
  request: PermissionRequest
  resolve: (result: PermissionPromptResult) => void
  detailsExpanded: boolean
  detailsScrollOffset: number
  selectedChoiceIndex: number
  feedbackMode: boolean
  feedbackInput: string
}

export type SessionPicker = {
  sessions: SessionMeta[]
  selectedIndex: number
  resolve: (sessionId: string | null) => void
  deleteConfirmIndex: number | null
  allProjects: boolean
  projects: ProjectMeta[]
  projectSelectedIndex: number
}

export type WelcomeAnimationMode = 'chew' | 'escape' | 'done'

export type WelcomeAnimation = {
  entryId: number
  mode: WelcomeAnimationMode
  frameIndex: number
}

export type ScreenState = {
  input: string
  cursorOffset: number
  transcript: TranscriptEntry[]
  transcriptScrollOffset: number
  selectedSlashIndex: number
  status: string | null
  activeTool: string | null
  recentTools: Array<{ name: string; status: 'success' | 'error' }>
  history: string[]
  historyIndex: number
  historyDraft: string
  nextEntryId: number
  pendingApproval: PendingApproval | null
  sessionPicker: SessionPicker | null
  isBusy: boolean
  contextStats: ContextStats | null
  compressionStatus: string | null
  statusAnimationFrame: number
  inputHintFrame: number
  thinkingStartedAt: number | null
  selection: TranscriptSelection | null
  mouseDown: { x: number; y: number } | null
  transcriptBodyStartY: number
  transcriptBodyLines: number
  welcomeAnimation: WelcomeAnimation | null
}

export type TranscriptEntryDraft =
  | Omit<Extract<TranscriptEntry, { kind: 'user' }>, 'id'>
  | Omit<Extract<TranscriptEntry, { kind: 'assistant' }>, 'id'>
  | Omit<Extract<TranscriptEntry, { kind: 'progress' }>, 'id'>
  | Omit<Extract<TranscriptEntry, { kind: 'tool' }>, 'id'>
export type AggregatedEditProgress = {
  entryId: number
  toolName: string
  path: string
  total: number
  completed: number
  errors: number
  lastOutput: string
}
