// src/monitor/types.ts
import type { ProviderThinkingBlock, StepDiagnostics } from '../types.js'

export type ToolObservation = {
  toolName: string
  input: unknown
  ok: boolean
}

export type MonitorConfig = {
  /** 同一工具+输入连续相邻达到该次数时提示 */
  toolRepeatNoticeMax: number
  /** 连续工具失败达到该次数时提示 */
  consecutiveFailureMax: number
}

export type AssistantContext = {
  content: string
  /** undefined 表示未标记；与源码 next.kind 行为一致 */
  kind?: 'final' | 'progress'
  isEmpty: boolean
  sawToolResultThisTurn: boolean
  toolErrorCount: number
  diagnostics?: StepDiagnostics
  thinkingBlocks?: ProviderThinkingBlock[]
}

/** detectAssistant 的决策输出。主循环按 kind 分发副作用。 */
export type AssistantAction =
  | { kind: 'progress_continue'; progress: string; continuation: string }
  | { kind: 'midtask_continue'; progress: string; continuation: string }
  | { kind: 'thinking_retry'; progress: string; continuation: string }
  | { kind: 'empty_continue'; continuation: string }
  | { kind: 'empty_stop'; fallback: string }
  | { kind: 'finish' }