import type { ChatMessage } from '../types.js'
import { COMPACTABLE_TOOLS } from '../utils/context.js'
import { computeContextStats, CLEAR_MARKER } from '../utils/token-estimator.js'
import { THRESHOLDS, RETENTION } from './constants.js'

/**
 * microcompact 折叠只读、可重建的工具结果以释放上下文。
 * foldableToolNames 由调用方按注册表推导（isReadOnly === true），
 * 使数据源 / MCP 只读工具自动纳入折叠范围，无需维护前缀名单。
 */
export function microcompact(
  messages: ChatMessage[],
  model: string,
  foldableToolNames?: ReadonlySet<string>,
): ChatMessage[] {
  const stats = computeContextStats(messages, model)
  if (stats.utilization < THRESHOLDS.MICROCOMPACT_UTILIZATION) {
    return messages
  }

  const isFoldable = foldableToolNames
    ? (name: string) => foldableToolNames.has(name)
    : (name: string) => COMPACTABLE_TOOLS.has(name)

  const toolResultIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'tool_result' && isFoldable(msg.toolName)) {
      toolResultIndices.push(i)
    }
  }

  if (toolResultIndices.length <= RETENTION.KEEP_RECENT_TOOL_RESULTS) {
    return messages
  }

  const keepFrom = toolResultIndices.length - RETENTION.KEEP_RECENT_TOOL_RESULTS
  const indicesToClear = new Set(toolResultIndices.slice(0, keepFrom))

  let changed = false
  const result: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (indicesToClear.has(i) && msg.role === 'tool_result') {
      if (msg.content !== CLEAR_MARKER) {
        changed = true
        result.push({
          ...msg,
          content: CLEAR_MARKER,
        })
      } else {
        result.push(msg)
      }
    } else {
      result.push(msg)
    }
  }

  return changed ? result : messages
}
