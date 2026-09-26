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

/** 并行批内同时在飞的工具数上限。 */
export const DEFAULT_TOOL_CONCURRENCY_LIMIT = 8

/**
 * 解析并发上限：LITE_AI_TOOL_CONCURRENCY_LIMIT，非法值回退默认。
 * 防止模型一轮吐 10+ 调用时同时 fork 等量子进程打爆 fd/内存。
 */
export function toolConcurrencyLimit(): number {
  const raw = process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT
  if (!raw) return DEFAULT_TOOL_CONCURRENCY_LIMIT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TOOL_CONCURRENCY_LIMIT
  return Math.floor(parsed)
}

/**
 * 有上限的并发 map：最多 limit 个在飞，输出按输入下标保序。
 * 语义对齐 Promise.all —— 首个 reject 立刻 reject（已发起的调用不回滚）。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const effectiveLimit = Math.max(1, Math.floor(limit) || 1)
  let cursor = 0
  let active = 0
  let settled = false

  return new Promise<R[]>((resolve, reject) => {
    const settle = () => {
      active -= 1
      launch()
    }

    const launch = () => {
      if (settled) return
      while (active < effectiveLimit && cursor < items.length) {
        const index = cursor++
        active += 1
        Promise.resolve()
          .then(() => worker(items[index] as T, index))
          .then(
            value => {
              results[index] = value
              settle()
            },
            error => {
              if (settled) return
              settled = true
              reject(error)
            },
          )
      }
      if (active === 0 && cursor >= items.length && !settled) {
        settled = true
        resolve(results)
      }
    }

    launch()
  })
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