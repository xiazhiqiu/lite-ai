import type { ToolCall } from '../types.js'

export type CallGroup = {
  parallel: boolean
  calls: ToolCall[]
}

export type IsParallelSafe = (call: ToolCall) => boolean

/** env 开关，默认关闭。置 LITE_AI_TOOL_CONCURRENCY=1 启用工具并发。 */
export function isToolConcurrencyEnabled(): boolean {
  return process.env.LITE_AI_TOOL_CONCURRENCY === '1'
}

/**
 * 贪心保序分组：连续 safe 调用并入同一并行批，unsafe 调用打断并另起串行组。
 * isSafe 抛异常 → 该调用按串行处理（fail-closed），不中断整批分组。
 *
 * 例：[read, read, grep, edit, read] →
 *   [{parallel:true,[read,read,grep]},{parallel:false,[edit]},{parallel:true,[read]}]
 */
export function partitionToolCalls(
  calls: ToolCall[],
  isSafe: IsParallelSafe,
): CallGroup[] {
  const groups: CallGroup[] = []

  for (const call of calls) {
    const safe = isSafeSafely(isSafe, call)
    const last = groups.at(-1)

    if (safe && last && last.parallel) {
      last.calls.push(call)
      continue
    }

    groups.push({
      parallel: safe,
      calls: [call],
    })
  }

  return groups
}

function isSafeSafely(isSafe: IsParallelSafe, call: ToolCall): boolean {
  try {
    return isSafe(call)
  } catch {
    return false
  }
}