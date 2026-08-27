// src/monitor/assistant.ts
import type { AssistantAction, AssistantContext } from './types.js'

type DecisionCounters = {
  emptyResponseRetry: number
  recoverableThinkingRetry: number
  midTaskTextContinuation: number
}

const EMPTY_RETRY_MAX = 2
const THINKING_RETRY_MAX = 3
const MIDTASK_CONTINUATION_MAX = 3

function isRecoverableThinkingStop(ctx: AssistantContext): boolean {
  if (!ctx.isEmpty) return false
  const stop = ctx.diagnostics?.stopReason
  if (stop !== 'pause_turn' && stop !== 'max_tokens') return false
  return (
    (ctx.diagnostics?.blockTypes ?? []).includes('thinking') ||
    (ctx.diagnostics?.ignoredBlockTypes ?? []).includes('thinking')
  )
}

/**
 * 把 agent-loop 的 assistant 级联分支收敛为纯决策。
 * 顺序必须与旧代码完全一致；计数器由调用方持有（每回合清零）。
 */
export function detectAssistant(
  ctx: AssistantContext,
  counters: DecisionCounters,
): AssistantAction {
  if (!ctx.isEmpty && ctx.kind === 'progress') {
    return {
      kind: 'progress_continue',
      progress: ctx.content,
      continuation:
        'Continue immediately from your <progress> update with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
    }
  }

  if (isRecoverableThinkingStop(ctx) && counters.recoverableThinkingRetry < THINKING_RETRY_MAX) {
    counters.recoverableThinkingRetry += 1
    const stop = ctx.diagnostics!.stopReason
    return {
      kind: 'thinking_retry',
      progress:
        stop === 'max_tokens'
          ? '模型在 thinking 阶段触发 max_tokens，正在继续请求后续步骤...'
          : '模型返回 pause_turn，正在继续请求后续步骤...',
      continuation:
        stop === 'max_tokens'
          ? 'Your previous response hit max_tokens during thinking before producing the next actionable step. Resume immediately and continue with the next concrete tool call, code change, or an explicit <final> answer only if the task is complete. Do not repeat the earlier plan.'
          : 'Resume from the previous pause_turn and continue the task immediately. Produce the next concrete tool call, code change, or an explicit <final> answer only if the task is complete.',
    }
  }

  if (ctx.isEmpty && counters.emptyResponseRetry < EMPTY_RETRY_MAX) {
    counters.emptyResponseRetry += 1
    return {
      kind: 'empty_continue',
      continuation: ctx.sawToolResultThisTurn
        ? 'Your last response was empty after recent tool results. Continue immediately by trying the next concrete step, adapting to any tool errors, or giving an explicit <final> answer only if the task is complete.'
        : 'Your last response was empty. Continue immediately with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
    }
  }

  if (ctx.isEmpty) {
    const fallback = ctx.sawToolResultThisTurn
      ? ctx.toolErrorCount > 0
        ? `工具执行后模型返回空响应，已停止当前回合。最近有 ${ctx.toolErrorCount} 个工具报错；请重试、调整命令，或让模型改用其他方案。`
        : '工具执行后模型返回空响应，已停止当前回合。请重试，或要求模型继续完成剩余步骤。'
      : '模型返回空响应，已停止当前回合。请重试，或要求模型继续。'
    return { kind: 'empty_stop', fallback }
  }

  if (
    ctx.sawToolResultThisTurn &&
    ctx.kind !== 'final' &&
    ctx.kind !== 'progress' &&
    counters.midTaskTextContinuation < MIDTASK_CONTINUATION_MAX
  ) {
    counters.midTaskTextContinuation += 1
    return {
      kind: 'midtask_continue',
      progress: ctx.content,
      continuation:
        '你上一条是纯文本但未标记 <final>，而本回合已经执行过工具，说明任务可能尚未完成。若任务确实已完成，请以 <final> 开头给出最终答案；否则继续下一步的具体工具调用。',
    }
  }

  return { kind: 'finish' }
}

export type { DecisionCounters }