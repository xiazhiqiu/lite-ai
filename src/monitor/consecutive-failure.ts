// src/monitor/consecutive-failure.ts
import type { ToolDetector } from './types.js'

/**
 * 连续 N 次工具调用全部失败检测。任一次成功即清零；达到 maxFailures（含）后每次失败都返回提示。
 */
export function createConsecutiveFailureDetector(maxFailures: number): ToolDetector {
  let streak = 0

  return {
    id: 'consecutive-failure',
    observe(call) {
      streak = call.ok ? 0 : streak + 1
      if (streak >= maxFailures) {
        return `! 提示：工具已连续失败 ${streak} 次。请检查命令、输入或依赖是否异常，避免在同一工具上反复重试；必要时更换策略。`
      }
      return null
    },
  }
}