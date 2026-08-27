// src/monitor/turn-monitor.ts
import { detectAssistant } from './assistant.js'
import type {
  AssistantAction,
  AssistantContext,
  MonitorConfig,
  ToolDetector,
  ToolObservation,
} from './types.js'
import { createConsecutiveFailureDetector } from './consecutive-failure.js'
import { createToolRepeatDetector } from './tool-repeat.js'

/**
 * 回合监控器：注册工具侧 detector，并统一提供 assistant 决策。
 * 实例生命周期 = 单个 agent 回合，天然承载回合级状态，无需 begin/end。
 */
export class TurnMonitor {
  private readonly detectors: ToolDetector[]

  constructor(detectors: ToolDetector[]) {
    this.detectors = detectors
  }

  /**
   * 观察一次工具调用，返回需要注入到对应工具结果前缀的提醒文本；无提醒返回 null。
   * 多个 detector 命中时以换行合并。
   */
  observeToolCall(call: ToolObservation): string | null {
    const notices: string[] = []
    for (const detector of this.detectors) {
      const notice = detector.observe(call)
      if (notice) notices.push(notice)
    }
    return notices.length > 0 ? notices.join('\n') : null
  }

  /** 决策下一轮 assistant 应如何处置（continue / stop / finish），见 assistant.ts。 */
  detectAssistant(ctx: AssistantContext): AssistantAction {
    return detectAssistant(ctx, this.counters)
  }

  /** 回合内控制流计数器，由 detectAssistant 维护。 */
  private readonly counters = {
    emptyResponseRetry: 0,
    recoverableThinkingRetry: 0,
    midTaskTextContinuation: 0,
  }
}

/** 默认装配：精确重复 + 连续失败。 */
export function createTurnMonitor(config: MonitorConfig): TurnMonitor {
  return new TurnMonitor([
    createToolRepeatDetector(config.toolRepeatNoticeMax),
    createConsecutiveFailureDetector(config.consecutiveFailureMax),
  ])
}