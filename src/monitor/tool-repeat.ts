// src/monitor/tool-repeat.ts
import type { ToolDetector } from './types.js'

function stableSerialize(input: unknown): string {
  try {
    if (input === undefined) return ''
    return JSON.stringify(input) ?? ''
  } catch {
    return '<unserializable>'
  }
}

/**
 * 同一工具+同一输入的连续相邻重复检测。达到 noticeAt（含）后返回提示文案，
 * 不拦截执行。仅统计「连续相邻」；中间插入任一不同调用即清零重计。
 */
export function createToolRepeatDetector(noticeAt: number): ToolDetector {
  const consecutive = new Map<string, number>()
  let lastKey: string | undefined

  const key = (toolName: string, input: unknown): string =>
    `${toolName}\u0000${stableSerialize(input)}`

  return {
    id: 'tool-repeat',
    observe(call) {
      const k = key(call.toolName, call.input)
      if (lastKey !== k) {
        if (lastKey !== undefined) consecutive.delete(lastKey)
        consecutive.set(k, 1)
      } else {
        consecutive.set(k, (consecutive.get(k) ?? 1) + 1)
      }
      lastKey = k

      const count = consecutive.get(k) ?? 1
      if (count < noticeAt) return null

      const safeInput = stableSerialize(call.input)
      const excerpt =
        safeInput != null && safeInput.length > 0
          ? `，输入：${safeInput.slice(0, 120)}`
          : ''
      return `! 提示：工具 ${call.toolName}${excerpt} 已连续出现 ${count} 次，结果未见进展。如非有意轮询，请考虑更换策略、修正输入，或确认任务是否已可结束。`
    },
  }
}